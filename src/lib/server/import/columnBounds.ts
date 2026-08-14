/**
 * How many columns an imported file may declare.
 *
 * ## THE PARSER DOES NOT NEED THIS BOUND, AND THE MEASUREMENT SAYS SO
 *
 * That is stated first because it is the unusual part. Measured 2026-08-14 through the real
 * `parseCsvTransactions`, over the widest shapes the existing byte cap (256 000) and row cap
 * (1 000) allow between them:
 *
 * | columns | rows | bytes   | parse   |
 * | ------- | ---- | ------- | ------- |
 * | 10      | 1000 | 49 041  | 15,9 ms |
 * | 100     | 1000 | 229 401 | 37,0 ms |
 * | 27 000  | 1    | 231 930 | 28,1 ms |
 * | 200     | 700  | 301 201 | unreachable, over the byte cap |
 *
 * The worst reachable parse is 37 ms. The byte and row caps already bound the parser between
 * them, so a column cap justified on parse cost would be a guard against a state that cannot
 * occur, which this repository calls a guard in costume.
 *
 * ## WHAT NEEDS IT IS THE DESIGNATION SCREEN, WHOSE COST IS PER COLUMN
 *
 * The column mapping screen (#316) renders one 107 px card per column and serialises three real
 * cell values into each. The third row of that table is the whole reason this file exists:
 * **27 000 columns in a single row is reachable today**, inside every existing cap, and it would
 * ask that screen for 27 000 cards and 81 000 preview values.
 *
 * So this is a bound taken in advance, for a named consumer that does not exist yet. That is
 * unusual enough to be worth the paragraph: the alternative is that the screen is born without it
 * and acquires one after somebody meets the failure, and a bound retrofitted to a rendered surface
 * is a behaviour change to a screen rather than a validation rule on a file.
 *
 * ## Why 512
 *
 * The design plate states the realistic maximum it must survive: fifteen columns in a bank
 * statement, forty in an accounting package's export. 512 is **12,8 times** the top of that range,
 * so it refuses nothing any real exporter produces, and it bounds the screen at 512 cards and
 * 1 536 preview values.
 *
 * The ceiling is 4 096. Above that the screen's cost stops being bounded in any useful sense
 * (12 288 preview values serialised into one page), and an operator who needs more has a file this
 * application should not be asked to render a picker for.
 *
 * ## Refused rather than clamped, and the reason is not stylistic
 *
 * A value above the ceiling throws at boot rather than being silently reduced, so that **a bound
 * you set is the bound that runs**. Same shape as `BACKUP_MAX_JSON_NODES`, and for the same
 * reason: a clamped limit reads as configured and behaves as something else.
 */
export const CSV_DEFAULT_MAX_COLUMNS = 512;

/** See the docstring above: past this the screen's page weight stops being meaningfully bounded. */
export const CSV_MAX_COLUMNS_CEILING = 4_096;

export const CSV_MAX_COLUMNS_ENV = 'CSV_MAX_COLUMNS';

/**
 * The widest file the design plate says this application must survive: an accounting package's
 * export. Quoted here so the warning below can say what a lowered bound starts refusing.
 */
export const WIDEST_REALISTIC_EXPORT_COLUMNS = 40;

/**
 * Reads the configured bound, or throws. Read per call rather than cached at import, matching
 * `resolveBackupMaxJsonNodes` and the xlsx bound.
 */
export function resolveCsvMaxColumns(): number {
	const raw = process.env[CSV_MAX_COLUMNS_ENV];
	if (raw === undefined || raw.trim() === '') return CSV_DEFAULT_MAX_COLUMNS;

	const columns = Number(raw);
	if (!Number.isInteger(columns) || columns < 1) {
		throw new Error(
			`${CSV_MAX_COLUMNS_ENV} must be a whole number of at least 1 (got ${JSON.stringify(raw)}). It bounds how many columns an imported file may declare. The default is ${CSV_DEFAULT_MAX_COLUMNS}.`
		);
	}

	if (columns > CSV_MAX_COLUMNS_CEILING) {
		throw new Error(
			`${CSV_MAX_COLUMNS_ENV}=${columns} is above the hard ceiling of ${CSV_MAX_COLUMNS_CEILING}. This bounds what the column designation screen has to render: one card and three preview values per column, all serialised into one page. The value is refused rather than clamped so that a bound you set is the bound that runs. The number and the measurements that chose it are in src/lib/server/import/columnBounds.ts.`
		);
	}

	return columns;
}

/**
 * Boot check, called from `hooks.server.ts` beside the backup bound. Refuses to start on an
 * out-of-range value, and reports any departure from the default in both directions.
 */
export function assertCsvColumnBoundConfigured(): void {
	const columns = resolveCsvMaxColumns();
	if (columns === CSV_DEFAULT_MAX_COLUMNS) return;

	console.warn(
		`[budgetpilot] ${CSV_MAX_COLUMNS_ENV}=${columns} differs from the default of ${CSV_DEFAULT_MAX_COLUMNS}. It bounds how many columns an imported file may declare.`
	);

	if (columns > CSV_DEFAULT_MAX_COLUMNS) {
		console.warn(
			`[budgetpilot] ${CSV_MAX_COLUMNS_ENV} is RAISED above the default, so the column designation screen may be asked to render ${columns} cards and ${columns * 3} preview values in one page.`
		);
	} else if (columns < WIDEST_REALISTIC_EXPORT_COLUMNS) {
		console.warn(
			`[budgetpilot] ${CSV_MAX_COLUMNS_ENV} is LOWERED below ${WIDEST_REALISTIC_EXPORT_COLUMNS}, which is the width of an ordinary accounting package export. Files this application should be able to read will now be refused, and the user is told their file has too many columns rather than that a limit was lowered.`
		);
	}
}
