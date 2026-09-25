import { validateTransaction } from '$lib/domain/transaction';
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
import type { DateOrder } from '../dateOrder';
import { addRefusal, buildSummary, firstDataRowIndex, readDateCell, toRecord } from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildCsvFields,
	buildPreviewRowId,
	hasStrandedControlCharacter,
	refusalCellValue,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';
import { acceptedDeclarations, amountHeaderCurrency, currencyOfCell } from '../currencyDeclaration';

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
	/** False when row 0 is a transaction rather than a title row. Defaults to true. */
	hasHeaderRow?: boolean;
	columns: ResolvedColumnNames;
	/** How an ambiguous date cell is read. Absent reads day-first. */
	dateOrder?: DateOrder;
	/** EVERY folded header declaring a currency (`currencyColumnsIn`), empty when the file has none.
	 *  A list since #600's F3: reading only the first let a blank `currency` hide `devise`. */
	currencyColumns: string[];
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
	hasHeaderRow,
	dateOrder,
	columns,
	currencyColumns,
	acceptedCurrency,
	profile,
	warnings,
	categorizationRules
}: ResolvedRowsInput): CsvImportResult {
	const resolvedFields = [columns.date, columns.label, columns.amount, columns.category].filter(
		(field): field is string => Boolean(field)
	);

	const transactions: ImportedTransaction[] = [];
	const refusals: CsvRefusal[] = [];
	// Kept at zero and still reported: within one file nothing is a duplicate any more, and
	// saying so in the summary is what stops a reader inferring the counter was forgotten.
	const duplicateRows = 0;
	let totalDebitCents = 0;
	let totalCreditCents = 0;
	const validDates: string[] = [];

	// Row 0 is skipped only when it IS a header. A headerless file's first line is a transaction,
	// and slicing it away unconditionally is what ate one row per import.
	const dataRows = rows.slice(firstDataRowIndex(hasHeaderRow));

	// THE FILE'S DECLARATION, read off EVERY data row before any row is judged (#600, contradiction
	// pass F2). A row refused below for its date or its amount still said which currency the file is
	// in. Rows of the wrong width are left out: their cells do not sit under the header they would be
	// read through. See `currencyDeclaration.ts`.
	// Every declaring column, F3, and the amount column's own NAME, F1: N26's `Amount (EUR)`, and its
	// legacy `Montant (EUR)` and `Betrag (EUR)`, declare EUR for every row under them, exactly as a
	// `currency` column reading EUR would (`amountHeaderCurrency`, one rule, any language).
	const amountDeclares = amountHeaderCurrency(columns.amount);
	const declarationIndices = currencyColumns.map((column) => headers.indexOf(column));
	const declaredCurrencies = acceptedDeclarations(
		[
			...(amountDeclares ? [amountDeclares] : []),
			...dataRows
				.filter((parsedRow) => parsedRow.cells.length === headers.length)
				.flatMap((parsedRow) => declarationIndices.map((index) => parsedRow.cells[index] ?? ''))
		],
		acceptedCurrency
	);

	dataRows.forEach((parsedRow) => {
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
		// Through the SHARED predicate, not a local composition of `normalizeDate` and
		// `isValidIsoDate`. The designation screen asks the same question about the same column,
		// and two compositions would let it state a reading this loop then refuses. See
		// `readDateCell`.
		const date = readDateCell(record[columns.date] ?? '', dateOrder);
		// Checked on the RAW cell, before sanitizing strips it: #652, a control character reaching
		// a stored label crashes the write on PostgreSQL, and this refuses the row rather than
		// silently importing an altered one. See `hasStrandedControlCharacter`'s own docstring.
		if (hasStrandedControlCharacter(record[columns.label] ?? '')) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'control-character' }, columns.label);
			return;
		}
		const label = sanitizeImportedText(record[columns.label] ?? '');
		const category = sanitizeImportedText(
			(columns.category ? record[columns.category] : '') || UNCLASSIFIED_CATEGORY
		);

		// Per row, like `revolut.ts`, because the column is per row and a file may mix. Checked
		// BEFORE the date and the amount so the refusal names the reason the row cannot be
		// imported at all, rather than a downstream complaint about a value we were never going
		// to keep.
		//
		// EVERY declaring column (#600, F3). A row whose columns disagree names a currency the
		// profile does not accept in at least one of them, and is refused on that value, exactly as
		// a row whose single column names it: same code, same scope.
		// The amount header's declaration applies to every row. A header naming a currency the
		// profile does not accept is refused on every row, as a `currency` column naming it is; a
		// declaring column may still refuse the row below.
		if (amountDeclares && amountDeclares !== acceptedCurrency) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'unsupported-currency', currency: refusalCellValue(amountDeclares) },
				columns.amount
			);
			return;
		}
		let declaredCurrency: string | undefined = amountDeclares;
		for (const currencyColumn of currencyColumns) {
			// Read through `currencyOfCell`, the one reading of a currency cell: `€`, `Euro` and a
			// code wrapped in invisible spaces are EUR, a blank cell is null (#600, F4).
			const cell = record[currencyColumn] ?? '';
			const code = currencyOfCell(cell);
			// An EMPTY cell is not a declaration. A file with the column present and the value
			// blank is the same situation as a file with no column, and must still import.
			if (code && code !== acceptedCurrency) {
				addRefusal(
					refusals,
					{ kind: 'row', line },
					{ code: 'unsupported-currency', currency: refusalCellValue(cell) },
					currencyColumn
				);
				return;
			}
			// The declaration LEAVES the parse (#600). It used to stop at the check above, so the row
			// was then denominated by whatever account it landed in.
			if (code) declaredCurrency = acceptedCurrency;
		}

		if (date === null) {
			// The RESOLVED column, like every other read in this loop. A Boursorama file names
			// `dateop` and a mapped one names whatever the user designated, so a hardcoded `date`
			// would point at a column their file does not contain.
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{
					code: 'invalid-date',
					column: columns.date,
					value: refusalCellValue(record[columns.date] ?? '')
				},
				columns.date
			);
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
		const categorization = applyCategorizationRules({ label, category, type }, categorizationRules);

		const transaction: ImportedTransaction = {
			id: buildPreviewRowId('csv', line, date, label, amountCents),
			date,
			label,
			amountCents,
			category: categorization.category,
			source: 'csv',
			// Spread so an undeclared row carries no key at all, the same absence as a file with no
			// currency column.
			...(declaredCurrency ? { declaredCurrency } : {}),
			metadata: {
				reference: '',
				notes: label,
				type,
				// The RESOLVED names, not a fixed list: with a fixed one a Boursorama file would
				// store no date at all, because its column is `dateop`. `columns.amount` is
				// exempted from `sanitizeImportedText` by its own resolved name, whatever a
				// user's file happens to call it, so a lowercase `montant` amount column is
				// exempted exactly like `Montant` would be. #466.
				csvFields: buildCsvFields(record, resolvedFields, new Set([columns.amount]))
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
		summary: {
			...buildSummary({
				profile,
				// The rows the parser actually READ, which is every row when there is no header.
				totalRows: dataRows.length,
				validRows: transactions.length,
				invalidRows: refusals.length,
				// Every refusal this loop produces is scoped to a row and every row produces at most
				// one, so there is nothing here that is not a row.
				fileLevelRefusals: 0,
				duplicateRows,
				totalDebitCents,
				totalCreditCents,
				dates: validDates
			}),
			declaredCurrencies
		}
	};
}
