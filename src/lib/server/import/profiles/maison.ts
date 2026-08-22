import { isTransactionNature, isValidIsoDate, validateTransaction } from '$lib/domain/transaction';
import type { TransactionNature } from '$lib/domain/transaction';
import type {
	CsvImportResult,
	CsvProfileParseInput,
	ImportedTransaction,
	ImportedTransactionType
} from '../types';
import type { CsvRefusal } from '../refusals';
import { addRefusal, buildSummary, emptyResult, normalizeDate, toRecord } from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildPreviewRowId,
	refusalCellValue,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';
import { foldExactHeader } from '../utils/encoding';

const MAISON_HEADERS = [
	'date',
	'libelle',
	'categorie',
	'montant',
	'type',
	'nature',
	'source_bancaire'
];
const MAX_CATEGORY_LENGTH = 80;

export function matchesMaisonHeader(headers: string[]): boolean {
	const normalizedHeaders = headers.map(foldExactHeader);
	return (
		normalizedHeaders.length === MAISON_HEADERS.length &&
		normalizedHeaders.every((header, index) => header === MAISON_HEADERS[index])
	);
}

export function parseMaisonRows({ rows, warnings }: CsvProfileParseInput): CsvImportResult {
	const headers = rows[0].cells.map(foldExactHeader);
	if (!matchesMaisonHeader(headers)) {
		return emptyResult(
			[{ code: 'header-not-recognized', profile: 'maison' }],
			warnings,
			'maison',
			rows.length - 1
		);
	}

	const transactions: ImportedTransaction[] = [];
	const refusals: CsvRefusal[] = [];
	// Kept at zero and still reported: within one file nothing is a duplicate any more, and
	// saying so in the summary is what stops a reader inferring the counter was forgotten.
	const duplicateRows = 0;
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

		const record = toRecord(headers, row);

		const date = normalizeDate(record.date ?? '');
		if (!isValidIsoDate(date)) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'invalid-date', column: 'date', value: refusalCellValue(record.date ?? '') },
				'date'
			);
			return;
		}

		const label = sanitizeImportedText(record.libelle ?? '');

		const categoryResult = resolveMaisonCategory(record.categorie ?? '');
		if (!categoryResult.ok) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'category-too-long' }, 'category');
			return;
		}
		const category = categoryResult.value;

		const rawAmount = (record.montant ?? '').trim().replace(/^'/, '');
		const amountCents = parseAmountCents(rawAmount);
		if (amountCents === null) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'invalid-amount', column: 'montant' },
				'amount'
			);
			return;
		}
		if (amountCents === 0) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'zero-amount', column: 'montant' },
				'amount'
			);
			return;
		}

		const derivedType: ImportedTransactionType = amountCents >= 0 ? 'income' : 'expense';
		const rawType = (record.type ?? '').trim().toLowerCase();
		if (rawType !== derivedType) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'type-amount-mismatch' }, 'type');
			return;
		}

		const rawNature = (record.nature ?? '').trim();
		let natureManual: TransactionNature | null = null;
		if (rawNature) {
			if (!isTransactionNature(rawNature)) {
				addRefusal(
					refusals,
					{ kind: 'row', line },
					{ code: 'invalid-nature', value: refusalCellValue(rawNature) },
					'nature'
				);
				return;
			}
			natureManual = rawNature;
		}

		// The ordinal is what makes two identical rows two transactions rather than one. The
		// in-file skip that used to sit here collapsed them and counted the second as a
		// duplicate, so a file carrying the same row twice imported one of them.
		const transaction: ImportedTransaction = {
			id: buildPreviewRowId('csv', line, date, label, amountCents),
			date,
			label,
			amountCents,
			category,
			source: 'csv',
			metadata: {
				reference: '',
				notes: label,
				type: derivedType,
				natureManual: natureManual ?? undefined
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

		if (derivedType === 'expense') totalDebitCents += Math.abs(amountCents);
		if (derivedType === 'income') totalCreditCents += Math.abs(amountCents);
		validDates.push(date);
		transactions.push(transaction);
	});

	return {
		transactions,
		warnings,
		invalidRows: refusals,
		summary: buildSummary({
			profile: 'maison',
			totalRows: rows.length - 1,
			validRows: transactions.length,
			invalidRows: refusals.length,
			fileLevelRefusals: 0,
			duplicateRows,
			totalDebitCents,
			totalCreditCents,
			dates: validDates
		})
	};
}

function resolveMaisonCategory(rawValue: string): { ok: true; value: string } | { ok: false } {
	const sanitized = sanitizeImportedText(rawValue);
	if (!sanitized) return { ok: true, value: UNCLASSIFIED_CATEGORY };
	if (sanitized.length > MAX_CATEGORY_LENGTH) return { ok: false };
	// The literal sentinel is ACCEPTED, not refused, and the reason is the round trip: the export
	// writes `getEffectiveCategory`, which is exactly this string for every row in the « à classer »
	// pile. Refusing it made `docs/getting-started.md`'s "an export re-imports cleanly" false for
	// the commonest kind of row in a fresh install. An empty cell already resolves here, so this
	// widens nothing a third-party file could not already reach. There is deliberately no branch
	// for it: the value is returned unchanged like any other, and a `=== UNCLASSIFIED_CATEGORY`
	// test that returns the same string either way would be a protection that protects nothing.
	return { ok: true, value: sanitized };
}
