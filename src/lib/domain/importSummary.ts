import type { CsvRefusalFact, CsvRefusalScope } from '$lib/server/import/refusals';
import type { DateOrder } from '$lib/domain/dateReading';

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
	 * The account these rows landed in, as a person reads it, or null when it could not be named.
	 *
	 * Not the same field the destination control used to produce, and the difference is the whole
	 * point of #372: that one asked which patrimoine line a bucket feeds, on a screen about a file.
	 * This one answers the question the screen actually asks, « where did my rows go », with the
	 * account the user chose two steps earlier.
	 *
	 * Null is a real state rather than a placeholder: a rendering rule that cannot name the account
	 * says nothing instead of naming the wrong one.
	 */
	accountName: string | null;
	/**
	 * REMOVED, #485, and the reason is decided rather than a side effect of the fix.
	 *
	 * This carried « the file named several accounts and the rows all landed in one » so a
	 * successful import could at least say so after the fact. #485's fix moved the question BEFORE
	 * the write: a file `discriminant.ts` calls `contradictory` now refuses outright and never
	 * reaches this object at all. A file it calls `ambiguous` only reaches a SUCCESSFUL import
	 * after the user has just answered `accountColumnAnswer: 'not-account'` — and re-running
	 * `findDiscriminantColumn` here would still report `ambiguous`, unchanged, because the raw
	 * grammar over the file's cells has not moved. Showing this notice in that surviving case would
	 * not inform the user of anything new: it would CONTRADICT the answer they gave thirty seconds
	 * earlier. There is no remaining state on a successful import for this field to describe
	 * honestly, so it is deleted rather than left reporting `false` forever.
	 */
	/**
	 * THIS IMPORT stored a column correspondance that later files of the same shape will reuse.
	 *
	 * Here because the sentence saying so MOVED OFF the designation screen. It used to sit in that
	 * screen's body beside its opt-out link, where it cost 38 px in the one state that has the least
	 * room, and the Date row's reading line needed 18 of them. The opt-out link stayed behind: the
	 * consent must be in reach BEFORE the write, and this surface is after it.
	 *
	 * So the split is deliberate and the two halves say different things. The link is the choice,
	 * offered while it can still be made. This is the disclosure, and it is past tense in substance:
	 * it reports what the import did.
	 *
	 * A BOOLEAN AND NOT AN ASSUMPTION. A user who opted out must not be told their correspondance
	 * will be reused, which would be a false claim on the screen that reports what happened. One
	 * production writer memorises (`import/columns`'s action, the only `saveColumnMapping` call site
	 * outside the db-smoke), and it is false everywhere else, including the automatic path, which
	 * USES a correspondance and never creates one.
	 */
	rememberedMapping: boolean;
	/**
	 * The column and reading to state on the summary, plate 7l. Null unless the reading was CHOSEN
	 * rather than proven or defaulted: `CsvImportSummary.dateOrderDisclosure`'s docstring holds the
	 * one rule, and this is the same fact carried across the server/client boundary.
	 *
	 * Null and not absent, unlike its server-side source: this interface is a wire shape rather
	 * than an internal one, and `satisfies` catches an omitted field but not a forgotten optional
	 * one left implicitly undefined.
	 */
	dateOrderDisclosure: { header: string; order: DateOrder } | null;
}
