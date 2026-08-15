import type { RoleAssignment } from '$lib/domain/columnDesignation';
import type { CollidingBatchView, CollisionFigures } from '$lib/domain/importCollision';

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
		assignment: RoleAssignment;
		remember: boolean;
		hasHeaderRow: boolean;
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
