import type { ImportSummaryResult } from '$lib/domain/importSummary';

/**
 * The summary of an import that was performed on `/import/columns`, handed to `/import` to draw.
 *
 * ## The defect this exists for, measured
 *
 * A blind usability session imported a real bank statement by designating its columns. 57 of 66
 * rows landed, 9 were rejected, and the screen said nothing at all: the route posted its action,
 * discarded the response, and navigated to `/import`, which had no `form` data of its own and so
 * rendered a bare upload form. The tester only found the loss by comparing transaction totals
 * before and after.
 *
 * The asymmetry was the sharp part. `/import` reports; the designation route did not; and the
 * SECOND import of the same file — now recognised through the memorised mapping — reports again.
 * So the evidence did arrive, one run late, detached from the choice that caused it, on a screen
 * the user cannot return to. The silent run was also the run that wrote the mapping. See #338.
 *
 * ## Why module state rather than a redirect or a store
 *
 * The action lives on `/import/columns`; the panel that draws its result lives on `/import`. A
 * SvelteKit action result reaches the page that owns the action, so it cannot arrive as `form`
 * here. Rebuilding it on `/import` from the database is not possible either: raw file contents are
 * deliberately not stored, so the rejected rows and their previews exist only in that response.
 *
 * This is the same mechanism, and the same lifetime, that already carries the FILE in the other
 * direction (`pendingDesignation.svelte.ts`): module state for as long as the tab lives, gone on
 * reload. A summary lost to a reload is the honest outcome; the import itself is already recorded
 * in the history at `/imports`.
 */
export interface CompletedImport {
	/** What the columns action returned under `importResult`, drawn by `/import` unchanged. */
	importResult: ImportSummaryResult;
	/** True when the mapping could not be memorised because the per-account cap was reached. */
	capReached: boolean;
	/**
	 * Whether the designation screen can be reopened on this import, in state 2 with the
	 * designations intact.
	 *
	 * Plate §1q table B: the invalid-rows screen takes exactly one addition, a TapLink
	 * « Revoir les colonnes », « sans ce chemin de retour, 130 dates mal lues obligent à
	 * recommencer l'import ». It is only offered when the file is still in the browser AND rows
	 * actually failed: a link back from a clean import would be an invitation to change an answer
	 * that just worked.
	 */
	canRevisit: boolean;
	/**
	 * What became of the batch this run was correcting, when it was correcting one.
	 *
	 * Three states rather than a boolean, because « nothing was replaced » and « the replacement was
	 * withheld » are different things to say and the second one has to RETRACT a promise: two
	 * screens announce the replacement before any row is counted, so a run that then withholds owes
	 * the user the name of the import it did not delete.
	 *
	 * `replacedAt` is that name, the same timestamp discriminant the delete confirmation uses.
	 */
	replaced: ReplaceOutcome;
}

/**
 * What became of the batch a correction was replacing.
 *
 * Declared here rather than beside the action, because both the action that produces it and the page
 * that draws it name this type, and a page cannot import from `$lib/server`.
 */
export type ReplaceOutcome =
	| { kind: 'none' }
	| { kind: 'deleted'; replacedAt: string }
	| { kind: 'withheld'; replacedAt: string; replacedRows: number; importedRows: number };

let completed: CompletedImport | null = null;

export function setCompletedImport(next: CompletedImport): void {
	completed = next;
}

/**
 * Read once, and cleared by reading.
 *
 * Taking rather than peeking is what stops a later visit to `/import` from re-displaying the
 * summary of an import the user has already seen and moved on from.
 */
export function takeCompletedImport(): CompletedImport | null {
	const value = completed;
	completed = null;
	return value;
}
