import type { PendingDesignation } from './pendingDesignation.svelte';
import type { PendingCollision } from './pendingCollision.svelte';
import type { RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * What a run hands to the duplicate-statement dialog so that answering it can re-post the SAME run.
 *
 * ## Why this is a function rather than an object literal in the route
 *
 * The defect it exists to prevent was a one-word confusion between two values that are both called
 * `hasHeaderRow`: the one DETECTION guessed, carried on the view, and the one the USER answered,
 * carried on the submit. `/import`'s action always sends the first as `true`, so reading it back
 * hard-coded `true` into the repost. Answering « Importer quand même » then re-posted a header row
 * against a file the user had declared headerless, and the server ate its first line as a header.
 *
 * That is the eaten transaction, in the sibling branch of the function whose ordinary path was
 * repaired for it, and it was invisible because every collision fixture kept the two values equal.
 *
 * Pulled out of the route because the route reaches this branch only through a serialised
 * `ActionResult`, which a component test cannot construct faithfully: the transport, not the
 * mapping, is what made the seam untestable. The mapping is the part that can be wrong.
 */
export function buildCollisionRepost(
	pending: PendingDesignation,
	result: {
		accountId: string;
		assignment: RoleAssignment;
		remember: boolean;
		hasHeaderRow: boolean;
		deleteOldImport: boolean;
	}
): PendingCollision['repost'] {
	return {
		file: pending.file,
		// The view carries the USER's answer, not detection's, so declining the dialog reopens the
		// designation screen the way they left it rather than the way it was guessed.
		view: { ...pending.view, detectedHeaderRow: result.hasHeaderRow },
		assignment: result.assignment,
		// The user's own choice, carried on BOTH legs: confirming re-posts it, declining reopens the
		// screen already showing it. Re-deriving it from `resolution` on the way back would replace
		// their answer with the application's on the one screen built to stop that.
		accountId: result.accountId,
		account: pending.account && { ...pending.account, chosenId: result.accountId },
		remember: result.remember,
		hasHeaderRow: result.hasHeaderRow,
		// The pending correction WHOLE, plus the answer just given. The three naming fields travel so
		// declining can reopen the screen able to ask again; `deleteOldImport` travels because
		// answering re-posts the same run, and a correction that lost it here would import beside the
		// import it came to replace, or delete one the user had chosen to keep.
		correction: pending.correction
			? { ...pending.correction, deleteOldImport: result.deleteOldImport }
			: null
	};
}
