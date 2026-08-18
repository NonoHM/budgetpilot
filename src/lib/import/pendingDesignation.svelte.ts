import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * The file, held in the BROWSER, between the import screen and the designation screen.
 *
 * ## Owner ruling 2, and what it refuses
 *
 * The browser keeps the file and re-posts it. Server-side retention was refused, and the reasoning
 * is worth carrying next to the code that implements the alternative: storing the upload between
 * two requests creates an asset with a lifetime, an expiry and a key to protect. That is three
 * problems created to avoid one re-post of a file the user already has on their device, and the
 * file is capped at 256000 bytes, so the re-post costs almost nothing.
 *
 * ## Nothing here is trusted
 *
 * `headers`, `samples` and `rowCount` exist so the screen can DRAW the file. They are not evidence
 * and the server never reads them back: the submit re-posts the file itself, the server re-derives
 * its own header list, and every posted index is validated against that. If this module were
 * tampered with from a console, the worst it produces is a screen that draws the wrong labels and a
 * submit the server refuses.
 *
 * ## Module state, and why the screen tolerates it being empty
 *
 * This lives for as long as the tab does and does not survive a reload, which is correct: a `File`
 * cannot be serialised into `sessionStorage` and a designation screen with no file is a screen that
 * cannot submit. The route redirects back to `/import` when it finds nothing here, which is the
 * honest outcome of a reload rather than an error to report.
 */
export interface PendingDesignation {
	/** The uploaded file itself, re-posted verbatim on submit. */
	file: File;
	/** What the screen draws. Never read back by the server. */
	view: DesignationFile;
	/** What detection worked out, so the screen opens with the unambiguous columns already filled. */
	initialAssignment: RoleAssignment;
	/** Per role, the column indices detection proposes when it will not pick between equals. */
	candidates: Partial<Record<string, number[]>>;
	/**
	 * The correction this designation belongs to, when it is one.
	 *
	 * Carried because the designation request is the one that DELETES, and until this field existed
	 * nothing survived the navigation to tell it so. That absence is why the collision guard fired
	 * against the very batch the user came to fix, and why a correction left two identical imports
	 * behind.
	 *
	 * Not trusted, exactly like the rest of this module. The id is resolved again, server side,
	 * against this user's own batches and against the correspondance being corrected, in the request
	 * that acts on it. Tampering with it from a console selects a batch that is already yours.
	 */
	correction: {
		/**
		 * The correspondance being corrected, carried ONLY so the way out can rebuild the address it
		 * came from.
		 *
		 * It decides nothing. `batchId` below travels to a request that deletes and is re-resolved
		 * there; this one is a NAVIGATION target, and the page it navigates to resolves it again from
		 * its own load before anything is echoed into a form. An id that only rebuilds a URL does not
		 * need the treatment an id that names a delete does, and saying so here is what stops the two
		 * being confused later.
		 *
		 * Without it, abandoning the designation screen landed on a bare `/import`: the correction
		 * notice gone, the checkbox gone, and the obvious next action re-importing the statement
		 * through the very correspondance the user came to fix.
		 */
		mappingId: string;
		batchId: string;
		deleteOldImport: boolean;
	} | null;
}

let pending: PendingDesignation | null = null;

export function setPendingDesignation(next: PendingDesignation): void {
	pending = next;
}

export function takePendingDesignation(): PendingDesignation | null {
	return pending;
}

/**
 * Cleared once the import has been submitted and accepted.
 *
 * Not cleared on a REFUSAL: a server-side refusal returns the user to the same screen with their
 * designations intact, and dropping the file here would turn a correctable mistake into a re-upload.
 */
export function clearPendingDesignation(): void {
	pending = null;
}
