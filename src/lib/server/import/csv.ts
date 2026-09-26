import { resolveProfile } from './registry';
import { mappedDateColumns, parseMappedRows } from './profiles/mapped';
import { decideDateOrder, detectDateOrder } from './dateOrder';
import { findDiscriminantColumn } from './discriminant';
import { SAMPLE_PADDING } from '$lib/domain/columnDesignation';
import type {
	CsvImportOptions,
	CsvImportProfile,
	CsvImportResult,
	CsvImportSummary,
	ImportedTransaction,
	ImportedTransactionMetadata,
	ImportedTransactionType,
	ParsedCsvRow,
	ResolvedCsvImportProfile
} from './types';
import { emptyResult, firstDataRowIndex, normalizeParsedRows, parseRows } from './utils/csv';
import { resolveCsvMaxColumns } from './columnBounds';
import { CSV_MAX_ROWS } from './resourceBounds';
export { CSV_MAX_ROWS };
import { refusalCellValue } from './utils/safety';
export { sanitizeImportedText } from './utils/safety';
export type {
	CsvImportOptions,
	CsvImportProfile,
	CsvImportResult,
	CsvImportSummary,
	ImportedTransaction,
	ImportedTransactionMetadata,
	ImportedTransactionType
};

const DEFAULT_MAX_BYTES = 256_000;

export function parseCsvTransactions(
	content: string,
	options: CsvImportOptions = {}
): CsvImportResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const sizeBytes = new TextEncoder().encode(content).length;

	if (sizeBytes > maxBytes) {
		return emptyResult([{ code: 'file-too-large', bytes: sizeBytes }], []);
	}

	return parseImportRows(parseRows(content), options);
}

export function parseCsvTransactionRows(
	rows: ParsedCsvRow[],
	options: CsvImportOptions = {}
): CsvImportResult {
	return parseImportRows(rows, options);
}

/**
 * The header cells a parse of these rows will actually see.
 *
 * Exported so the route can fingerprint the SAME bytes the parser resolves against. Reading
 * `rows[0].cells` directly is one BOM away from a fingerprint that never matches the mapping it
 * just wrote, and the symptom would be "it forgets my designation", with nothing to point at.
 */
export function importHeaderCells(rows: ParsedCsvRow[]): string[] {
	const normalized = normalizeParsedRows(rows);
	return normalized.length === 0 ? [] : normalized[0].cells;
}

/**
 * `count` DATA values of each column, for the designation screen's cards.
 *
 * ## What the samples are FOR, because leaving it implicit is what produced the defect
 *
 * They are not a preview of the file and not a debugging aid. They exist so that someone can
 * **recognise their own data** on a screen where the header names are unknown or unrecognised by
 * construction — the values are the only evidence the user has. They are therefore **chosen to
 * discriminate, rather than taken from the top**, and any later change that makes them cheaper to
 * compute has to be weighed against that sentence rather than against the shape of this code.
 *
 * ## The defect this exists for, measured
 *
 * These used to be the file's first `count` rows. A Banque Populaire export splits money across a
 * `Debit` and a `Credit` column, and the opening rows of a statement are debits, so `Credit` —
 * carrying 9 values across 66 rows — was rendered « (vide), (vide), (vide) ». A blind usability
 * session read that as dead space, designated `Debit` as the amount, and every credit row was
 * rejected: a whole month of income absent from an import that reported nothing wrong. The screen
 * showed no false statement and did show false evidence. See #342.
 *
 * The first three rows are evidence about the first three rows. Only a value chosen because it
 * exists is evidence about a column.
 *
 * Normalised through the same `normalizeParsedRows` as the header cells, deliberately: the screen
 * shows the user their own file and then designates columns BY INDEX into it, so a preview built
 * from a different normalisation would let someone designate a column whose values they never saw.
 *
 * Padded to `count` per column. A column with two values must render three lines or the card stops
 * being 107 px, and the plate's own answer for the missing one is « (vide) », which the card
 * renders from an empty string. Returning a ragged array would push that decision out to every
 * call site. A column that is genuinely empty throughout still reads « (vide) » three times, which
 * is the honest answer there rather than the misleading one.
 *
 * The pad is `SAMPLE_PADDING`, and any reader that is not `ColumnCard` filters it with
 * `isSamplePadding` rather than restating the comparison (#669).
 */
export function importSampleValues(
	rows: ParsedCsvRow[],
	count = 3,
	hasHeaderRow?: boolean
): string[][] {
	const normalized = normalizeParsedRows(rows);
	const header = normalized.length === 0 ? [] : normalized[0].cells;
	const samples: string[][] = header.map(() => []);

	// One pass over the file, stopping as soon as every column has its quota. The common case —
	// a dense statement — exits after `count` rows, which is what the old slice did; a sparse
	// column is the case that costs more, and it is the case that was wrong.
	let satisfied = 0;
	for (
		let row = firstDataRowIndex(hasHeaderRow);
		row < normalized.length && satisfied < samples.length;
		row++
	) {
		const cells = normalized[row].cells;
		for (let column = 0; column < samples.length; column++) {
			if (samples[column].length >= count) continue;
			const cell = cells[column] ?? '';
			if (cell.trim() === '') continue;
			samples[column].push(cell);
			if (samples[column].length === count) satisfied++;
		}
	}

	return samples.map((values) =>
		values.length === count
			? values
			: [...values, ...Array(count - values.length).fill(SAMPLE_PADDING)]
	);
}

/**
 * The first DATA row, padded to the header's width, for the designation screen's role rows.
 *
 * ## Deliberately not `importSampleValues`, and the design handoff says why
 *
 * Handoff §3.2: « The four example values all come from the first data row. That is load-bearing:
 * it is why there is no rows-preview at 390 (ruling D2). Do not source the examples from different
 * rows per role — it would silently destroy the only line-level verification the screen offers. »
 *
 * The four role rows are one transaction read vertically, and that is the entire argument for the
 * screen carrying no rows preview at 390: the line is already on it. The picker's cards answer a
 * different question — « which column is this? » — and are chosen to discriminate. Two questions,
 * two sources.
 *
 * Sharing one is what this chantier nearly shipped: once the samples became "first non-empty",
 * designating a sparse column would have put a Montant from row 9 beside a Date from row 1, and
 * the four rows would have described nothing. No test could see it; the plate could.
 *
 * An empty cell stays empty here. The row renders « (vide) », which is honest, and the rows still
 * describe one line of the file.
 */
export function importFirstDataRow(rows: ParsedCsvRow[], hasHeaderRow?: boolean): string[] {
	const normalized = normalizeParsedRows(rows);
	const header = normalized.length === 0 ? [] : normalized[0].cells;
	const first = normalized[firstDataRowIndex(hasHeaderRow)]?.cells ?? [];
	return header.map((_, column) => first[column] ?? '');
}

/**
 * The file's first `count` DATA rows, in file order, each padded to the header's width.
 *
 * ## Why this exists when `importSampleValues` already returns values
 *
 * They answer different questions and only one of them can be drawn as a TABLE. Samples are
 * chosen per column because they discriminate — a sparse column shows its own three values
 * rather than three blanks — so `samples[0][0]` and `samples[1][0]` routinely come from
 * different rows of the file. Laying them out as a grid would invent rows that do not exist in
 * the user's statement, and the plate's own reason for the preview is that it shows the file:
 * reordered or fabricated, it becomes a second source of truth that contradicts the same file
 * opened in a spreadsheet.
 *
 * So the preview reads REAL consecutive rows, in the file's own order, and the samples go on
 * answering the question the picker cards ask.
 *
 * Padded to the header width for the same reason `importFirstDataRow` is: a short row must draw
 * empty cells under the right columns rather than shifting every value one to the left.
 */
export function importPreviewRows(
	rows: ParsedCsvRow[],
	count = 5,
	hasHeaderRow?: boolean
): string[][] {
	const normalized = normalizeParsedRows(rows);
	if (normalized.length === 0) return [];
	const header = normalized[0].cells;
	return normalized
		.slice(firstDataRowIndex(hasHeaderRow), firstDataRowIndex(hasHeaderRow) + Math.max(0, count))
		.map((row) => header.map((_, column) => row.cells[column] ?? ''));
}

/**
 * How many DATA rows carry a value in each column.
 *
 * The other half of « chosen to discriminate ». The samples now show a sparse column its own
 * values, which is what stops it reading as dead space, but three values look identical whether
 * the column holds three or six hundred. This is the number that separates them.
 *
 * Same emptiness predicate as `importSampleValues`, deliberately: a cell the sampler skips must
 * not be counted as carrying a value, or a column would be described as having values beside three
 * « (vide) » lines.
 */
export function importSampleCoverage(rows: ParsedCsvRow[], hasHeaderRow?: boolean): number[] {
	const normalized = normalizeParsedRows(rows);
	const header = normalized.length === 0 ? [] : normalized[0].cells;
	const filled = header.map(() => 0);

	for (let row = firstDataRowIndex(hasHeaderRow); row < normalized.length; row++) {
		const cells = normalized[row].cells;
		for (let column = 0; column < filled.length; column++) {
			if ((cells[column] ?? '').trim() !== '') filled[column]++;
		}
	}

	return filled;
}

export function parseImportRows(
	rows: ParsedCsvRow[],
	options: CsvImportOptions = {}
): CsvImportResult {
	const warnings: string[] = [];
	const maxRows = options.maxRows ?? CSV_MAX_ROWS;
	const normalizedRows = normalizeParsedRows(rows);

	if (normalizedRows.length < 2) return emptyResult([{ code: 'file-empty' }], warnings);

	// The rows a refusal below is about, computed ONCE and used both to decide the cap and to
	// report it. A file refused by a cap used to report zero rows read, which is a statement about
	// the file rather than about the refusal, and the summary had nothing else to say instead. The
	// user's own answer about a title row is honoured here for the same reason it is honoured in
	// the row loop: a headerless file's first line is a transaction, and subtracting it reports a
	// count the user cannot find in their spreadsheet.
	const dataRowCount = normalizedRows.length - firstDataRowIndex(options.hasHeaderRow);

	if (dataRowCount > maxRows)
		return emptyResult(
			[{ code: 'too-many-rows', max: maxRows }],
			warnings,
			'generic',
			dataRowCount
		);

	// Beside the row cap and BEFORE profile resolution: the column count is a property of the
	// file, so the answer must not depend on which profile happened to match. See
	// columnBounds.ts for why the parser does not need this and the designation screen does.
	const maxColumns = options.maxColumns ?? resolveCsvMaxColumns();
	if (normalizedRows[0].cells.length > maxColumns)
		return emptyResult(
			[{ code: 'too-many-columns', max: maxColumns }],
			warnings,
			'generic',
			dataRowCount
		);

	const requestedProfile = options.profile ?? 'auto';

	// `mapped` is routed around the registry, because this profile is chosen by a row in the
	// database rather than by the header line. Keeping it out of `csvProfileParsers` is what makes
	// "a mapping is never auto-detected" structural: registered after `generic`, whose match
	// returns true for everything, it would be unreachable today and reachable the day somebody
	// reorders that list, with nothing able to tell the difference. See `profiles/mapped.ts`.
	//
	// Resolved BEFORE the date order below rather than at its own dispatch, so that both paths
	// reach one detection rather than two. `null` here means `mapped` and nothing else.
	const parser =
		requestedProfile === 'mapped'
			? null
			: resolveProfile(normalizedRows[0].cells, requestedProfile);

	if (!parser && requestedProfile !== 'mapped') {
		const profileLabel = requestedProfile === 'auto' ? 'CSV' : profileErrorLabel(requestedProfile);
		return emptyResult(
			[{ code: 'header-not-recognized', profile: profileLabel }],
			warnings,
			resultProfile(requestedProfile),
			dataRowCount
		);
	}

	/**
	 * THE ONE PLACE THE DATE ORDER IS DECIDED, for every parse path there is.
	 *
	 * ## Why here and not in a profile
	 *
	 * The order is a property of the FILE, and a decision taken per profile is a decision seven
	 * copies of. `normalizeDate` sees one value, and one value reading `06/01/2026` is two valid
	 * dates with nothing to separate them; only the whole column can answer. So the profile
	 * contributes the one thing it alone knows, which columns hold dates, and the answer is taken
	 * here. A profile cannot bypass this, because every parse path passes through this function.
	 *
	 * ## The order of operations is load-bearing, and both halves were paid for
	 *
	 * AFTER the row cap and the column cap above, because this walks cells and a file already
	 * refused for its dimensions must not buy any of that walk: caps firing while the expensive
	 * work ran anyway is the defect #604 measured at 15,123 ms and +2,349 MB on a file the guards
	 * had correctly rejected in 7.9 ms. The walk is bounded twice over by those caps, at the
	 * declared columns (three at most, today) times the accepted rows.
	 *
	 * AFTER the profile resolved, because until then nothing knows which cells are dates, and a
	 * scan of every cell in the file was rejected in #613 for a measured reason: a reference
	 * column carrying something like `12/34/5678` becomes false evidence, and paired with genuine
	 * evidence elsewhere it refuses a file that imports correctly today.
	 *
	 * BEFORE any row is read, because a refusal about the whole file must not arrive after rows
	 * have been accepted under a reading the file contradicts.
	 */
	const dateColumns = parser
		? parser.dateColumns(normalizedRows[0].cells)
		: mappedDateColumns(options.columnMapping, normalizedRows[0].cells);
	const dateCells = dateColumnCells(normalizedRows, dateColumns, options.hasHeaderRow);
	const verdict = detectDateOrder(dateCells.values);
	/**
	 * THE COLUMN THE READING QUESTION IS ABOUT: the one whose cell the verdict's sample came from.
	 * One value, read by the question below and by the summary's disclosure, so the two cannot
	 * name different columns. `dateColumns[0]` (the profile's first-listed column) only where no
	 * question arises, which is where the disclosure reads it and finds nothing to say.
	 *
	 * It used to be `dateColumns[0]` always. On a Banque Populaire file whose `Date operation` is
	 * blank, or a Revolut file whose first row is pending with no `Date de fin`, the evidence came
	 * from a sibling column while the offer pointed at the blank one: the row's line 2 read an
	 * empty cell and the sheet's cards were empty (#667). The reading applied is unaffected either
	 * way: one column's evidence settles every declared column, as `detectDateOrder` records.
	 */
	const questionColumn =
		verdict.kind === 'ambiguous' ? dateCells.columns[verdict.sampleIndex] : dateColumns[0];

	const decision = decideDateOrder(verdict, options.dateOrder);

	// Through `refusalCellValue`, exactly as every other refusal in this directory names a cell.
	// The evidence a verdict carries is the WHOLE trimmed cell, because `AMBIGUOUS_DATE_PATTERN`
	// ends in `([\s\S]*)`: a date is only its first ten characters. Measured while this was being
	// written, with the raw value: a 5,010 character cell reached the fact at 5,010 characters,
	// and a tab survived into the page's data. A refusal fact is serialised into the page on every
	// failed import, so an unbounded cell is a user's own upload choosing what goes there.
	if (decision.kind === 'refuse')
		return emptyResult(
			[
				{
					code: 'mixed-date-order',
					dayFirst: refusalCellValue(decision.dayFirst),
					monthFirst: refusalCellValue(decision.monthFirst)
				}
			],
			warnings,
			parser ? parser.profile : 'mapped',
			dataRowCount
		);

	const parsed = !parser
		? parseMappedRows({
				rows: normalizedRows,
				warnings,
				sourceName: options.sourceName,
				categorizationRules: options.categorizationRules ?? [],
				columnMapping: options.columnMapping,
				hasHeaderRow: options.hasHeaderRow,
				dateOrder: decision.order
			})
		: parser.parse({
				rows: normalizedRows,
				warnings,
				sourceName: options.sourceName,
				categorizationRules: options.categorizationRules ?? [],
				dateOrder: decision.order
			});

	/**
	 * #485. AFTER the parse, same reason as the date-order block below: asking or refusing about
	 * an account column is pointless for a file a structural or per-row refusal has already killed.
	 * BEFORE the date-order block, deliberately: a PROVEN multi-account file (`kind: 'contradictory'`) can
	 * never be resolved by answering the date question either, so it is at least as severe as a
	 * structural refusal and wins ahead of it, exactly the reasoning that already puts structural
	 * refusals ahead of `ambiguous-date-order`. MEASURED rather than decided in the abstract
	 * (`multiAccountRefusal.spec.ts`'s "order against #433" cases): the cost this pays is that a
	 * file carrying BOTH an unproven account column and an ambiguous date column asks its two
	 * questions one at a time rather than together, because nothing here can ask both at once.
	 *
	 * No `alreadyPromptedClientSide`-shaped flag, unlike the date-order block: `/import`'s auto
	 * path and `/import/columns`'s designation path both reach this door with no PRIOR mechanism
	 * that has ever asked whether a file covers more than one account (the designation screen picks
	 * one destination account; it does not read the file's own account column), so #485's fix
	 * applies identically to both with no exclusion to draw.
	 */
	const discriminant = findDiscriminantColumn(normalizedRows);
	if (
		(discriminant.kind === 'contradictory' || discriminant.kind === 'ambiguous') &&
		parsed.transactions.length > 0 &&
		parsed.summary.fileLevelRefusals === 0
	) {
		// UNMEASURED, #485: neither this repository's fixture corpus nor a DB query could answer how
		// often this fires on a real file (`multiAccountFile` was computed and discarded, never
		// stored, and the raw file is not retained either). A `console.warn` here would not close that
		// gap: this app ships as a distroless container with no log aggregation configured, so a line
		// written to stdout reaches nobody and is indistinguishable from never having run. The gap is
		// recorded on the issue instead of manufactured as a log line nothing reads.
		if (discriminant.kind === 'contradictory' || options.accountColumnAnswer === 'is-account') {
			return emptyResult(
				[{ code: 'multi-account-file', column: discriminant.index }],
				warnings,
				parser ? parser.profile : 'mapped',
				dataRowCount
			);
		}
		if (options.accountColumnAnswer !== 'not-account') {
			return emptyResult(
				[
					{
						code: 'ambiguous-account-column',
						column: discriminant.index,
						sample: refusalCellValue(normalizedRows[1]?.cells[discriminant.index] ?? '')
					}
				],
				warnings,
				parser ? parser.profile : 'mapped',
				dataRowCount
			);
		}
		// 'not-account': the column is confirmed noise, and `parsed` proceeds untouched, exactly as
		// a `kind: 'nothing-to-decide'` verdict would have.
	}

	/**
	 * THE FOURTH OUTCOME, #433's auto-path remainder (plate 7l). AFTER the parse rather than before
	 * it, deliberately: a structural refusal (`duplicate-column`, `missing-required-column`,
	 * `bad-column-count`, ...) or a per-row one over EVERY row must win, because asking about a
	 * reading is pointless for a file that cannot be imported at all regardless of the answer.
	 * MEASURED while writing this: checking the verdict alone, before the parse, made an ambiguous
	 * date column preempt `duplicate-column` on a fixture that carried both — the file needed a
	 * different repair and got asked the wrong question. Gating on the RESULT is what a period
	 * range like `01/01/2026 au 31/01/2026` also needed: `AMBIGUOUS_DATE_PATTERN`'s trailing
	 * `[\s\S]*` matches it as ambiguous evidence, but every row referencing it still fails
	 * `invalid-date`, so `parsed.transactions.length` stays zero and this branch correctly leaves
	 * that refusal alone.
	 *
	 * `!options.dateOrderPromptedClientSide`, NOT `parser` truthy: #433's contradiction pass found
	 * that "mapped" does not mean "already asked". `/import`'s own action also parses with
	 * `profile: 'mapped'` when it silently reapplies a `ColumnMapping` remembered from a PREVIOUS
	 * designation (`useMapping`, by header fingerprint), and that reuse shows no screen at all —
	 * `ColumnMapping` carries no `dateOrder` field, so nothing was ever asked or remembered for
	 * this file. Only `/import/columns`, backed by the designation screen (#639), sets the flag,
	 * because it alone is trusted to have deferred its own close until the question was answered
	 * or waived (plate 7b) — `columns/page.server.spec.ts`'s baseline test locks that path's
	 * existing day-first default for an unanswered column, and this flag is what lets this branch
	 * leave it alone without also leaving the silent `mapped` reuse unasked forever.
	 *
	 * `questionColumn`, one column rather than every declared one: the reading offer's
	 * `assignment.date` points at one column, and it must be the column whose cell raised the
	 * question (#667, see `questionColumn`'s own comment above).
	 */
	if (
		verdict.kind === 'ambiguous' &&
		!options.dateOrder &&
		!options.dateOrderPromptedClientSide &&
		parsed.transactions.length > 0 &&
		parsed.summary.fileLevelRefusals === 0
	) {
		return emptyResult(
			[
				{
					code: 'ambiguous-date-order',
					column: questionColumn,
					sample: refusalCellValue(verdict.sample)
				}
			],
			warnings,
			parser ? parser.profile : 'mapped',
			dataRowCount
		);
	}

	// THE APPLIED ORDER LEAVES THE DOOR THAT DECIDED IT, and it is attached here rather than inside
	// each profile for the reason the decision itself is taken here: seven profiles would be seven
	// copies, and the one that forgot would write a batch claiming a reading it did not use.
	//
	// `ImportBatch.dateOrder` is what consumes it. That column has existed on all three engines
	// since 2026-08-22 with no writer, so every stored row says « not recoverable » about an import
	// whose order was in fact decided. This closes that, and plate 7l's summary line rests on it.
	//
	// PLATE 7L'S DISCLOSURE, computed at the one door that knows both halves it needs: which column
	// (`questionColumn`, the one the question named) and what became of the ANSWER, which
	// `decideDateOrder` reports and this reads rather than restating: `applied` is the one branch an
	// override settles, `overruled` is an answer the file's proof contradicted (#619). A proven
	// column with no disagreeing answer, or a defaulted one, leaves this undefined, never a value
	// the summary would have to know not to render. ONE fact, so the two lines can never both show.
	//
	// The header text is left undisclosed (not synthesised) for a headerless file on the answered
	// line: there is no message variant for that combination in 7i. The overruled line names the
	// proving cell instead of a column, so it needs no header and shows on a headerless file too.
	// The cell is untrusted and serialised into the page, so it is bounded like every refusal cell.
	const dateOrderHeader =
		options.hasHeaderRow !== false ? (normalizedRows[0].cells[questionColumn] ?? '').trim() : '';
	const dateOrderDisclosure: CsvImportSummary['dateOrderDisclosure'] =
		decision.answer === 'overruled'
			? { kind: 'overruled', order: decision.order, proof: refusalCellValue(decision.proof) }
			: decision.answer === 'applied' && dateOrderHeader
				? { kind: 'answered', header: dateOrderHeader, order: decision.order }
				: undefined;

	return {
		...parsed,
		summary: { ...parsed.summary, dateOrder: decision.order, dateOrderDisclosure }
	};
}

/**
 * The cells of the declared date columns, in file order, for the detector, and beside each one the
 * column it came from, POSITION FOR POSITION, so the verdict's `sampleIndex` names a column (#667).
 *
 * A column index this file does not carry yields nothing rather than an `undefined` the detector
 * would have to defend against: a declaration naming an absent column is an ordinary state (a
 * remembered mapping whose column the bank renamed, a profile listing three date columns where
 * one is optional), and the file meets its own refusal a few lines later with a sentence the user
 * can act on.
 *
 * The user's answer about a title row is honoured for the same reason the row count honours it: a
 * headerless file's first line is a transaction, and skipping it would drop one cell of evidence
 * from every such file.
 */
function dateColumnCells(
	rows: ParsedCsvRow[],
	columns: number[],
	hasHeaderRow: boolean | undefined
): { values: string[]; columns: number[] } {
	const values: string[] = [];
	const cellColumns: number[] = [];
	for (let row = firstDataRowIndex(hasHeaderRow); row < rows.length; row++)
		for (const column of columns) {
			const cell = rows[row].cells[column];
			if (cell !== undefined) {
				values.push(cell);
				cellColumns.push(column);
			}
		}

	return { values, columns: cellColumns };
}

function profileErrorLabel(profile: CsvImportProfile): string {
	if (profile === 'banque-populaire') return 'Banque Populaire';
	if (profile === 'revolut') return 'Revolut';
	return 'CSV';
}

function resultProfile(profile: CsvImportProfile): ResolvedCsvImportProfile {
	return profile === 'auto' ? 'generic' : profile;
}
