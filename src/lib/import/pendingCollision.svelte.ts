import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';
import type { CollidingBatchView, CollisionFigures } from '$lib/domain/importCollision';
import type { PendingDesignation } from './pendingDesignation.svelte';

/**
 * A designated run the server refused to write until the user answers for it, carried back to
 * `/import` to be asked there.
 *
 * ## Why the question is not asked on the designation screen
 *
 * The design handoff is explicit on both halves of this. §5.5 lists what that screen does not
 * contain, and `ConfirmDialog` is on the list, with one named exception that is not this one. §5.2
 * settles the general shape for the same reason: on a server refusal « this screen does not own this
 * state », the user returns to it exactly as they left it and the report appears on the screen that
 * owns outcomes.
 *
 * The collision question is a refusal of exactly that kind. It says nothing about the designation,
 * which may well be correct; it says the resulting import would duplicate money already stored. So
 * the designation screen keeps its answers, hands the question over, and `/import` asks it beside
 * the summary it already draws for every run that screen performs.
 *
 * ## Why the file travels with it
 *
 * Same reason `pendingDesignation` carries one, and the same owner ruling 2: the browser holds the
 * upload and re-posts it, rather than the server keeping an asset with a lifetime, an expiry and a
 * key to protect. Answering « Importer quand même » is a second POST to the designation screen's own
 * action, so everything that action needs has to survive the navigation. Nothing here is evidence:
 * the server re-reads the file and re-resolves every index against its own header list.
 */
export interface PendingCollision {
	/** Everything the `/import/columns` action needs to run the same import again, plus the answer. */
	repost: {
		file: File;
		/**
		 * What the designation screen DRAWS, carried so that declining can give it back.
		 *
		 * Not needed to re-post: the server re-reads the file and re-derives its own header list, and
		 * nothing here is ever read back as evidence. It is needed to REOPEN the screen, because a
		 * `DesignationFile` cannot be reconstructed from a file name and an assignment. Rebuilding it
		 * would mean inventing headers, which is the one thing this screen must never do.
		 */
		view: DesignationFile;
		assignment: RoleAssignment;
		remember: boolean;
		hasHeaderRow: boolean;
		/**
		 * The correction this run belongs to, when it is one. Carried WHOLE rather than as a batch
		 * id, and the difference is what the dialog reads.
		 *
		 * A correction CAN reach this dialog, and only since the guard learned to exclude the batch
		 * being replaced: what fires now is a THIRD batch that also matches, a genuine earlier import
		 * of the same statement. Without this field the confirmation would import the corrected rows
		 * and leave the batch it was launched from in place, which is the doubled state the whole
		 * wave exists to remove, reached through the one screen that had just warned about doubling.
		 *
		 * A BATCH ID ALONE CANNOT SAY WHAT THE DIALOG HAS TO SAY. It is only posted when the control
		 * was left ticked, so "unticked correction" and "not a correction" would arrive here as the
		 * same absence, and the dialog would tell a user who deliberately kept their old import that
		 * this is an ordinary duplicate. The choice is part of the state, not a consequence of it.
		 *
		 * It is also what makes « Ne pas importer » able to give the designation screen back: the
		 * screen has to reopen knowing it is still a correction, or the next attempt loses the
		 * replacement.
		 */
		/**
		 * Typed FROM the designation store rather than restated, because this value is carried through
		 * the dialog and handed straight back to it. Two hand-written copies of one shape drift the
		 * moment a field is added to either, and the field just added — the correspondance id the way
		 * out needs — is exactly the kind that would have been added to one of them.
		 */
		correction: PendingDesignation['correction'];
	};
	/** The already-imported batch this run appears to repeat. */
	existing: CollidingBatchView;
	/** The same three figures for the file in hand. Equal to the other side's, which is the evidence. */
	incoming: CollisionFigures;
}

let pending: PendingCollision | null = null;

export function setPendingCollision(next: PendingCollision): void {
	pending = next;
}

/**
 * Read, not consumed.
 *
 * The question can be answered twice: « Ne pas importer » leaves the run unwritten and the user on
 * `/import`, where choosing another file must not resurrect it, and a failed confirmation must leave
 * the dialog answerable again. `/import` clears it explicitly at each of those points rather than
 * having the read do it silently.
 */
export function takePendingCollision(): PendingCollision | null {
	return pending;
}

export function clearPendingCollision(): void {
	pending = null;
}
