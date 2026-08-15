import { isValidIsoDate, validateTransaction } from '$lib/domain/transaction';
import {
	applyCategorizationRules,
	type CategorizationRuleInput
} from '$lib/server/categorization/rules';
import type {
	CsvImportResult,
	ImportedTransaction,
	ImportedTransactionType,
	ParsedCsvRow,
	ResolvedCsvImportProfile
} from '../types';
import type { CsvRefusal } from '../refusals';
import { addRefusal, buildSummary, normalizeDate, toRecord } from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import { createOccurrenceCounter } from '../occurrence';
import {
	buildCsvFields,
	buildDeduplicationGroupKey,
	buildDeduplicationKey,
	hashFingerprint,
	refusalCellValue,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';

/**
 * Which FOLDED header fills each role, once something upstream has decided.
 *
 * Folded, because `toRecord` keys the record by the folded header and a lookup through an
 * unfolded name silently finds nothing: the row imports with a blank label and an invalid date
 * rather than failing loudly. `applyColumnMapping` deliberately returns the file's own spelling,
 * for the recap screen, so the mapped caller folds before calling here.
 */
export interface ResolvedColumnNames {
	date: string;
	label: string;
	amount: string;
	/** Null when no column carries one, which is normal: the transaction takes the sentinel. */
	category: string | null;
}

export interface ResolvedRowsInput {
	rows: ParsedCsvRow[];
	/** The folded header line, as used to build each row record. */
	headers: string[];
	columns: ResolvedColumnNames;
	/** The folded header declaring a currency, when the file has one. */
	currencyColumn: string | undefined;
	acceptedCurrency: string;
	profile: ResolvedCsvImportProfile;
	warnings: string[];
	categorizationRules: CategorizationRuleInput[];
}

/**
 * The row loop shared by every profile that resolves its columns rather than fixing them.
 *
 * ## Why this is a function rather than a copy in each profile
 *
 * `generic` and `mapped` differ ONLY in how the four column names were decided: an alias table on
 * one side, a stored mapping on the other. Everything after that decision (the per-row currency
 * check, the date and amount validation, the occurrence ordinal, the deduplication key, the
 * categorisation, the summary) is the same work, and two copies of it is where the two quietly
 * stop agreeing. This repository has measured that shape several times over, most recently on a
 * deduplication key whose fifth field turned out to be a different thing in each of five profiles,
 * which made a test named "cross-profile deduplication" impossible to fail for years.
 *
 * The cost is stated rather than discovered: a shared helper's blind spot is inherited by every
 * caller at once and no caller's own tests can see it, because they all agree. What that buys is
 * that the blind spot is in ONE place, findable, and fixable once.
 */
export function parseResolvedRows({
	rows,
	headers,
	columns,
	currencyColumn,
	acceptedCurrency,
	profile,
	warnings,
	categorizationRules
}: ResolvedRowsInput): CsvImportResult {
	const resolvedFields = [columns.date, columns.label, columns.amount, columns.category].filter(
		(field): field is string => Boolean(field)
	);

	const transactions: ImportedTransaction[] = [];
	// One counter per parse, never shared between files: see occurrence.ts.
	const nextOccurrence = createOccurrenceCounter();
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
		// Read through the RESOLVED column name, not a hardcoded one: that indirection is the
		// whole widening. `columns.date` is `dateop` for a Boursorama file, `started date` for a
		// Revolut one, and whatever the user designated for a mapped one.
		const amountCents = parseAmountCents(record[columns.amount] ?? '');
		const date = normalizeDate(record[columns.date] ?? '');
		const label = sanitizeImportedText(record[columns.label] ?? '');
		const category = sanitizeImportedText(
			(columns.category ? record[columns.category] : '') || UNCLASSIFIED_CATEGORY
		);

		// Per row, like `revolut.ts`, because the column is per row and a file may mix. Checked
		// BEFORE the date and the amount so the refusal names the reason the row cannot be
		// imported at all, rather than a downstream complaint about a value we were never going
		// to keep.
		if (currencyColumn) {
			const declared = sanitizeImportedText(record[currencyColumn] ?? '');
			// An EMPTY cell is not a declaration. A file with the column present and the value
			// blank is the same situation as a file with no column, and must still import.
			if (declared && declared.toUpperCase() !== acceptedCurrency) {
				addRefusal(
					refusals,
					{ kind: 'row', line },
					{ code: 'unsupported-currency', currency: refusalCellValue(declared) },
					currencyColumn
				);
				return;
			}
		}

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
		// The ordinal is what makes two identical rows two transactions rather than one. Before
		// it, this loop collapsed them here and counted the second as a duplicate, so a file
		// carrying the same coffee twice imported one of them and reported the other as already
		// present. The in-file skip is gone with it: within one source a repeated row is now
		// occurrence 1, and the only authority on duplicates is the unique constraint in the
		// database, which is where a duplicate ACROSS sources has always been decided.
		const group = { date, label, amountCents, type };
		const fingerprint = buildDeduplicationKey({
			...group,
			occurrence: nextOccurrence(buildDeduplicationGroupKey(group))
		});
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
			profile,
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
