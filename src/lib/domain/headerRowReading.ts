import type { DesignationFile, ResolvedDesignationFile } from './columnDesignation';

/**
 * The file AS THE USER HAS DECLARED IT, rather than as detection guessed it.
 *
 * ## The defect this closes, measured in a browser
 *
 * The designation screen let the user say « the first line is data » and then went on describing
 * the file the other way. Walked end to end on a four-column, three-line file: the picker relabelled
 * its cards to « Colonne 1…4 », and the screen still read « 2 lignes », the preview table still
 * named the columns « Zone A…D », and the primary still said « Importer 2 lignes ». The import then
 * reported « 3 lignes lues dans ce fichier ».
 *
 * A button promising two rows to a server that reads three is a false figure on the primary of this
 * path, and it is the same family as the counters the previous wave repaired.
 *
 * ## One direction, because only one exists
 *
 * `/import`'s action always sends `hasHeaderRow: true` and a `rowCount` already reduced by that
 * header line, so the user can only ever flip it to « data ». The opposite flip is unrepresentable
 * from this route, and inventing a branch for it would be a state no route produces.
 *
 * ## What the client already holds is enough
 *
 * `headers` IS the first line when detection read one, so declaring it data means putting it back at
 * the top of the preview and counting it. Nothing has to be re-read from the server, which matters:
 * the file lives in the browser for the length of one import and there is no second request to make.
 */
export function readWithHeaderRow(
	file: DesignationFile,
	hasHeaderRow: boolean
): ResolvedDesignationFile {
	const { detectedHeaderRow, ...rest } = file;
	if (hasHeaderRow === detectedHeaderRow) return { ...rest, hasHeaderRow };
	if (hasHeaderRow) {
		// Unreachable from `/import`, which always declares a header row, and the invariant is
		// ASSERTED in that route's own spec rather than trusted here: the day the payload sends
		// `false`, the test that names the precondition reddens where the cause is, instead of this
		// branch silently returning a reading that is wrong in the other direction.
		return { ...rest, hasHeaderRow };
	}
	return {
		...rest,
		hasHeaderRow,
		rowCount: file.rowCount + 1,
		previewRows: [file.headers, ...(file.previewRows ?? [])]
	};
}
