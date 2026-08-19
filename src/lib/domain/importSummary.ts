import type { CsvRefusalFact, CsvRefusalScope } from '$lib/server/import/refusals';

/**
 * The shape of an import summary, named once so both routes that produce one produce the same.
 *
 * Type-only import from `$lib/server`, as `$lib/i18n/refusalLabel.ts` already does: a refusal fact
 * is a domain vocabulary that happens to be declared beside the parsers, and types are erased, so
 * nothing server-side reaches the bundle.
 *
 * ## Why this is a named type rather than two inferred ones
 *
 * `/import` and `/import/columns` both build this payload and one panel draws it. While the shape
 * was inferred separately at each site, the two drifted by exactly the field that mattered: the
 * designation route returned the COUNT of rejected rows and not the rows, so the one import path
 * where the user had just chosen the columns by hand was the only one that could not say which
 * rows those choices rejected. A shared name makes that drift a type error. See #338.
 */
export interface ImportInvalidRowDetail {
	/**
	 * Identity for the render's keyed each block, and nothing else.
	 *
	 * It used to be the line number, which worked only because header level complaints were
	 * given an invented `index + 1` (#291). Removing that invention without changing the key
	 * would give every header complaint the same key, which is a runtime crash rather than a
	 * type error, because the dependency lives in markup. A position in this list is stable:
	 * it is never reordered or filtered on the client.
	 */
	key: number;
	scope: CsvRefusalScope;
	fact: CsvRefusalFact;
	/** Absent when the refusal names no field. Never defaulted: the scope carries what the old `?? 'ligne'` fallback used to imply. */
	field?: string;
	profile: string;
	preview: string;
}

export interface ImportSummaryResult {
	fileName: string;
	profile: string;
	totalRows: number;
	importedRows: number;
	/** ROWS refused, one per row. Never a complaint about the header, which is not a row. */
	invalidRows: number;
	/**
	 * Complaints about the file or its header, stated in words above the counters rather than
	 * drawn as a fifth number: three missing roles is three things wrong with one line, and that
	 * line is not among the rows read.
	 */
	fileLevelRefusals: number;
	duplicateRows: number;
	/**
	 * Rows the user's own categorization rules rewrote immediately after the import, which is a
	 * thing the application did to their money that nothing on the file asked for.
	 *
	 * Zero is the ordinary case and renders nothing. It is deliberately not folded into
	 * `importedRows`: those rows WERE imported, and this says what happened to them next.
	 */
	autoCategorizedRows: number;
	totalDebitCents: number;
	totalCreditCents: number;
	period: { from: string | null; to: string | null };
	batchId: string;
	/** The rejected rows themselves, capped; `hiddenInvalidRowsCount` carries the remainder. */
	invalidRowDetails: ImportInvalidRowDetail[];
	hiddenInvalidRowsCount: number;
	/**
	 * Whether a chosen destination account was applied or ignored, and null when none was chosen.
	 * Always null from the designation route, which carries no such field.
	 */
	netWorthLinkStatus: 'applied' | 'ignored' | null;
}
