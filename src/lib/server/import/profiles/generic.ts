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
import { REQUIRED_ROLES, resolveRequiredColumns } from './columnAliases';
import {
	buildCsvFields,
	buildDeduplicationKey,
	hashFingerprint,
	refusalCellValue,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';

/** The one column that is optional and still matched by its exact name: it has no role in
 *  building a transaction, so an absent or unrecognised category simply falls back to the
 *  sentinel rather than refusing anything. Aliasing it belongs with the mapping path. */
const CATEGORY_COLUMN = 'category';

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

	// A duplicated header is STILL a refusal, and the reason is sharper than "it is ambiguous":
	// `toRecord` assigns `record[header] = row[index]`, so a later duplicate OVERWRITES an
	// earlier one and the last column silently wins. That is unreachable today only because
	// this refusal exists. Removing it does not make the file ambiguous, it makes it wrong.
	const duplicateHeaders = getDuplicateHeaders(headers);
	for (const header of duplicateHeaders)
		addRefusal(
			headerRefusals,
			{ kind: 'header' },
			{ code: 'duplicate-column', column: refusalCellValue(header) }
		);

	// An UNRECOGNISED column is no longer a refusal. It is dropped, and the file is parsed from
	// the columns we did recognise. Nothing about the ignored column is lost that this profile
	// could have used: it is a deferral to the column mapping path (#301), where the user gets
	// to say what those columns mean, not a decision that their contents do not matter.
	const resolution = resolveRequiredColumns(headers);
	if (!resolution.ok) {
		addRefusal(
			headerRefusals,
			{ kind: 'header' },
			{
				code: 'ambiguous-column-mapping',
				role: resolution.role,
				columns: resolution.headers.map(refusalCellValue).join(', ')
			}
		);
	}

	const columns = resolution.ok
		? resolution.columns
		: { date: undefined, label: undefined, amount: undefined };
	if (resolution.ok) {
		for (const role of REQUIRED_ROLES) {
			if (!columns[role])
				addRefusal(
					headerRefusals,
					{ kind: 'header' },
					{ code: 'missing-required-column', column: role }
				);
		}
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

	const resolvedFields = [columns.date, columns.label, columns.amount, CATEGORY_COLUMN].filter(
		(field): field is string => Boolean(field)
	);

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
		// Read through the RESOLVED column name, not a hardcoded one: that indirection is the
		// whole widening. `columns.date` is `dateop` for a Boursorama file and `started date`
		// for a Revolut one.
		const amountCents = parseAmountCents(record[columns.amount ?? ''] ?? '');
		const date = normalizeDate(record[columns.date ?? ''] ?? '');
		const label = sanitizeImportedText(record[columns.label ?? ''] ?? '');
		const category = sanitizeImportedText(record[CATEGORY_COLUMN] || UNCLASSIFIED_CATEGORY);

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
				// The RESOLVED names, not a fixed list: with a fixed one a Boursorama file would
				// store no date at all, because its column is `dateop`.
				csvFields: buildCsvFields(record, resolvedFields)
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
