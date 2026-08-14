import { isValidIsoDate, validateTransaction } from '$lib/domain/transaction';
import { applyCategorizationRules } from '$lib/server/categorization/rules';
import type {
	CsvImportResult,
	CsvProfileParseInput,
	ImportedTransaction,
	ImportedTransactionType
} from '../types';
import type { CsvRefusal } from '../refusals';
import {
	addRefusal,
	buildSummary,
	emptyResult,
	normalizeFirstValidDate,
	normalizeHeaderCells,
	toRecord
} from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildCsvFields,
	buildDeduplicationKey,
	buildNotes,
	firstPresent,
	hashFingerprint,
	refusalCellValue,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';

export const REVOLUT_HEADERS = [
	'Type',
	'Produit',
	'Date de début',
	'Date de fin',
	'Description',
	'Montant',
	'Frais',
	'Devise',
	'État',
	'Solde'
];

const REVOLUT_METADATA_FIELDS = [
	'Type',
	'Produit',
	'Date de début',
	'Date de fin',
	'Frais',
	'Devise',
	'État',
	'Solde'
];

export function matchesRevolutHeader(headers: string[]): boolean {
	const normalizedHeaders = normalizeHeaderCells(headers).map(normalizeComparableHeader);
	return (
		normalizedHeaders.length === REVOLUT_HEADERS.length &&
		normalizedHeaders.every(
			(header, index) => header === normalizeComparableHeader(REVOLUT_HEADERS[index])
		)
	);
}

export function parseRevolutRows({
	rows,
	warnings,
	sourceName,
	categorizationRules
}: CsvProfileParseInput): CsvImportResult {
	const headers = normalizeHeaderCells(rows[0].cells);
	if (!matchesRevolutHeader(headers)) {
		return emptyResult(
			[{ code: 'header-not-recognized', profile: 'Revolut' }],
			warnings,
			'revolut',
			rows.length - 1
		);
	}

	const transactions: ImportedTransaction[] = [];
	const seenFingerprints = new Set<string>();
	const refusals: CsvRefusal[] = [];
	let duplicateRows = 0;
	let totalDebitCents = 0;
	let totalCreditCents = 0;
	const validDates: string[] = [];

	rows.slice(1).forEach((parsedRow) => {
		const row = parsedRow.cells;
		const line = parsedRow.line;
		if (row.length !== headers.length) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'bad-column-count', expected: headers.length, actual: row.length },
				'colonnes'
			);
			return;
		}

		const record = normalizeRevolutRecord(toRecord(headers, row));
		const state = sanitizeImportedText(record['État'] ?? '');
		const currency = sanitizeImportedText(record.Devise ?? '');

		if (!isCompletedState(state)) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'state-not-completed', state: refusalCellValue(state) },
				'État'
			);
			return;
		}

		if (currency !== 'EUR') {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'unsupported-currency', currency: refusalCellValue(currency) },
				'Devise'
			);
			return;
		}

		const date = normalizeFirstValidDate(record['Date de fin'], record['Date de début']);
		if (!isValidIsoDate(date)) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'invalid-date', column: 'Date de fin' },
				'Date de fin'
			);
			return;
		}

		const amountCents = parseAmountCents(record.Montant ?? '');
		if (amountCents === null) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'invalid-amount', column: 'Montant' },
				'Montant'
			);
			return;
		}

		if (amountCents === 0) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'zero-amount', column: 'Montant' },
				'Montant'
			);
			return;
		}

		const feeCents = firstPresent(record.Frais) ? parseAmountCents(record.Frais ?? '') : null;
		if (feeCents === null && firstPresent(record.Frais)) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'invalid-fee' }, 'Frais');
			return;
		}

		const balanceCents = firstPresent(record.Solde) ? parseAmountCents(record.Solde ?? '') : null;
		if (balanceCents === null && firstPresent(record.Solde)) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'invalid-balance' }, 'Solde');
			return;
		}

		const label = sanitizeImportedText(record.Description || 'Opération Revolut');
		const revolutType = sanitizeImportedText(record.Type ?? '');
		const product = sanitizeImportedText(record.Produit ?? '');
		const category = sanitizeImportedText(revolutType || 'Revolut');
		const type: ImportedTransactionType = amountCents >= 0 ? 'income' : 'expense';
		const absAmountCents = Math.abs(amountCents);
		const fingerprint = buildDeduplicationKey({
			date,
			label,
			amountCents: absAmountCents,
			type,
			category: product ? `${category}:${product}` : category,
			account: sourceName
		});

		if (seenFingerprints.has(fingerprint)) {
			duplicateRows += 1;
			return;
		}
		seenFingerprints.add(fingerprint);
		const categorization = applyCategorizationRules({ label, category, type }, categorizationRules);
		// The Revolut operation type (the "Type" field) is never a business category:
		// it's applied only if a rule explicitly mapped it, otherwise it stays "to classify".
		const effectiveCategory = categorization.ruleId
			? categorization.category
			: UNCLASSIFIED_CATEGORY;
		const notes = buildNotes([
			record.Type,
			record.Produit,
			feeCents ? `Frais: ${record.Frais}` : ''
		]);

		const transaction: ImportedTransaction = {
			id: `csv-${hashFingerprint(fingerprint)}`,
			date,
			label,
			amountCents: absAmountCents,
			category: effectiveCategory,
			source: 'csv',
			metadata: {
				reference: '',
				notes,
				type,
				bankOperationType: revolutType || undefined,
				revolutType: revolutType || undefined,
				revolutProduct: product || undefined,
				revolutCurrency: currency,
				revolutState: state,
				revolutFeeCents: feeCents ?? undefined,
				revolutBalanceCents: balanceCents ?? undefined,
				deduplicationKey: fingerprint,
				csvFields: buildCsvFields(record, REVOLUT_METADATA_FIELDS)
			}
		};
		const validation = validateTransaction(transaction);
		if (!validation.ok) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{
					code: 'transaction-invalid',
					violations: validation.violations
				}
			);
			return;
		}

		if (type === 'expense') totalDebitCents += absAmountCents;
		if (type === 'income') totalCreditCents += absAmountCents;
		validDates.push(date);
		transactions.push(transaction);
	});

	return {
		transactions,
		warnings,
		invalidRows: refusals,
		summary: buildSummary({
			profile: 'revolut',
			totalRows: rows.length - 1,
			validRows: transactions.length,
			invalidRows: refusals.length,
			duplicateRows,
			totalDebitCents,
			totalCreditCents,
			dates: validDates
		})
	};
}

function normalizeComparableHeader(value: string): string {
	return value
		.trim()
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase();
}

function normalizeRevolutRecord(record: Record<string, string>): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		const canonical = REVOLUT_HEADERS.find(
			(header) => normalizeComparableHeader(header) === normalizeComparableHeader(key)
		);
		normalized[canonical ?? key] = value;
	}
	return normalized;
}

function isCompletedState(value: string): boolean {
	return normalizeComparableHeader(value) === 'termine';
}
