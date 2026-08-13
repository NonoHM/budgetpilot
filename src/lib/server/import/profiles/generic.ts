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
	getDuplicateHeaders,
	normalizeDate,
	toRecord
} from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildCsvFields,
	buildDeduplicationKey,
	hashFingerprint,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';

const ALLOWED_HEADERS = new Set(['date', 'label', 'amount', 'category']);
const GENERIC_FIELDS = ['date', 'label', 'amount', 'category'];

export function matchesGenericHeader(): boolean {
	return true;
}

export function parseGenericRows({
	rows,
	warnings,
	sourceName,
	categorizationRules
}: CsvProfileParseInput): CsvImportResult {
	const headers = rows[0].cells.map((header) => header.trim().toLowerCase());
	const headerRefusals: CsvRefusal[] = [];
	const duplicateHeaders = getDuplicateHeaders(headers);
	for (const header of duplicateHeaders)
		addRefusal(headerRefusals, { kind: 'header' }, { code: 'duplicate-column', column: header });
	const unknownHeaders = headers.filter((header) => !ALLOWED_HEADERS.has(header));
	for (const header of unknownHeaders)
		addRefusal(headerRefusals, { kind: 'header' }, { code: 'unknown-column', column: header });

	for (const requiredHeader of ['date', 'label', 'amount']) {
		if (!headers.includes(requiredHeader))
			addRefusal(
				headerRefusals,
				{ kind: 'header' },
				{ code: 'missing-required-column', column: requiredHeader }
			);
	}

	if (headerRefusals.length > 0) {
		return {
			transactions: [],
			warnings,
			invalidRows: headerRefusals,
			summary: buildSummary({
				profile: 'generic',
				totalRows: rows.length - 1,
				validRows: 0,
				invalidRows: headerRefusals.length,
				duplicateRows: 0,
				totalDebitCents: 0,
				totalCreditCents: 0,
				dates: []
			})
		};
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

		const record = toRecord(headers, row);
		const amountCents = parseAmountCents(record.amount ?? '');
		const date = normalizeDate(record.date ?? '');
		const label = sanitizeImportedText(record.label ?? '');
		const category = sanitizeImportedText(record.category || UNCLASSIFIED_CATEGORY);

		if (!isValidIsoDate(date)) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'invalid-date', column: 'date' }, 'date');
			return;
		}

		if (amountCents === null) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'invalid-amount', column: 'amount' },
				'amount'
			);
			return;
		}

		if (amountCents === 0) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'zero-amount', column: 'amount' },
				'amount'
			);
			return;
		}

		const type: ImportedTransactionType = amountCents >= 0 ? 'income' : 'expense';
		const fingerprint = buildDeduplicationKey({
			date,
			label,
			amountCents: Math.abs(amountCents),
			type,
			category,
			account: sourceName
		});
		if (seenFingerprints.has(fingerprint)) {
			duplicateRows += 1;
			return;
		}
		seenFingerprints.add(fingerprint);
		const categorization = applyCategorizationRules({ label, category, type }, categorizationRules);

		const transaction: ImportedTransaction = {
			id: `csv-${hashFingerprint(fingerprint)}`,
			date,
			label,
			amountCents,
			category: categorization.category,
			source: 'csv',
			metadata: {
				reference: '',
				notes: label,
				type,
				deduplicationKey: fingerprint,
				csvFields: buildCsvFields(record, GENERIC_FIELDS)
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

		if (type === 'expense') totalDebitCents += Math.abs(amountCents);
		if (type === 'income') totalCreditCents += Math.abs(amountCents);
		validDates.push(date);
		transactions.push(transaction);
	});

	return {
		transactions,
		warnings,
		invalidRows: refusals,
		summary: buildSummary({
			profile: 'generic',
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
