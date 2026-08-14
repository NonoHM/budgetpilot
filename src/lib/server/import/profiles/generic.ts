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

/**
 * The names a file may use to declare what currency its amounts are in.
 *
 * ## Why this exists, and why it REFUSES rather than converts
 *
 * This application holds euros. Every amount is stored as a bare `amountCents` with no currency
 * beside it, and `formatCents` puts a euro symbol on all 121 of its call sites. So a file whose
 * amounts are pounds has nowhere honest to go: importing it writes the right number under the
 * wrong unit, and the user reads « -12,30 € » for a charge that was £12.30.
 *
 * `revolut.ts` has refused a non EUR row since long before this, and it is the MODEL here rather
 * than the outlier. This gives `generic` the same honesty, with the same refusal code, so the two
 * paths say the same thing for the same reason.
 *
 * ## The asymmetry is deliberate: a declared currency is checked, an absent one is assumed
 *
 * A file that DECLARES a currency is making a claim, and ignoring a claim the file makes is the
 * defect. A file that declares nothing makes no claim, so there is nothing to contradict. Refusing
 * on the absence of a signal would refuse almost every real statement, including this
 * application's own export format, which carries no currency column at all.
 *
 * **What that costs, stated rather than left to be discovered: a user whose bank emits no currency
 * column and is not in euros is still silently wrong, and this cannot fix them.** There is nothing
 * to detect. Closing that needs somewhere to store a currency, or asking the user, and both belong
 * to the aggregation issue rather than here.
 *
 * ## Only this profile can see it
 *
 * `maison`, `maison-v2` and `banque-populaire` match on exact ordered equality against a fixed
 * header list, so a file carrying an extra currency column has the wrong column count and never
 * reaches them: it falls through to here. A currency guard in those three would be unreachable,
 * which is a guard in costume rather than a guard. Their EUR assumption is documented instead.
 */
const CURRENCY_COLUMNS = ['currency', 'devise'];
const ACCEPTED_CURRENCY = 'EUR';

export function matchesGenericHeader(): boolean {
	return true;
}

export function parseGenericRows({
	rows,
	warnings,
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

	// Which header, if any, declares the currency. Absent is the common case and is fine.
	const currencyColumn = CURRENCY_COLUMNS.find((name) => headers.includes(name));

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

		// Per row, like `revolut.ts`, because the column is per row and a file may mix. Checked
		// BEFORE the date and the amount so the refusal names the reason the row cannot be
		// imported at all, rather than a downstream complaint about a value we were never going
		// to keep.
		if (currencyColumn) {
			const declared = sanitizeImportedText(record[currencyColumn] ?? '');
			// An EMPTY cell is not a declaration. A file with the column present and the value
			// blank is the same situation as a file with no column, and must still import.
			if (declared && declared.toUpperCase() !== ACCEPTED_CURRENCY) {
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
		const fingerprint = buildDeduplicationKey({
			date,
			label,
			amountCents: Math.abs(amountCents),
			type,
			category
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
