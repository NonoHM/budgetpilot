import {
	DESIGNATION_ROW_FACTS,
	type DesignationFile,
	type DesignationRowFacts,
	type ResolvedDesignationFile
} from './columnDesignation';

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
 * ## And the facts the first repair left behind (#735)
 *
 * That repair moved the count and the preview and nothing else. The Date column's state, the row's
 * first line, the cards and their readings, and the coverage went on describing the file with line 1
 * skipped: a headerless file whose only date proof was on line 1 was asked how its dates read, the
 * row stated a conversion the import did not write, and the answer was discarded at the import.
 * Every per-row fact now follows the answer, by SWAPPING in the set the server computed for it
 * (`DesignationFile.otherHeaderRowFacts`), never by recomputing one here: the column verdict needs
 * the whole column, which the browser does not hold, and a second implementation here would be a
 * second answer. `DESIGNATION_ROW_FACTS` is the list swapped.
 */
export function readWithHeaderRow(
	file: DesignationFile,
	hasHeaderRow: boolean
): ResolvedDesignationFile {
	const {
		detectedHeaderRow: _guess,
		otherHeaderRowFacts: _other,
		...rest
	} = declareHeaderRow(file, hasHeaderRow);
	return { ...rest, hasHeaderRow };
}

/**
 * The same file with `hasHeaderRow` as its detection: the per-row facts swapped with the other set,
 * and the count moved by the one line that changed sides.
 *
 * Exported for the duplicate-statement repost, which reopens the screen with the user's answer as
 * the guess. Rewriting only `detectedHeaderRow` there left every fact describing the other reading,
 * with nothing on screen able to tell.
 *
 * ## The count moves by one line, both ways
 *
 * `rowCount` is the parse's own count and the payload cannot rebuild it for the other answer, so it
 * moves by the line that changed sides: one more when line 1 becomes data, one fewer when it becomes
 * headers again.
 */
export function declareHeaderRow(file: DesignationFile, hasHeaderRow: boolean): DesignationFile {
	if (hasHeaderRow === file.detectedHeaderRow) return file;
	const current = rowFactsOf(file);
	const other = file.otherHeaderRowFacts ?? unknownRowFacts(file);
	return {
		...file,
		...other,
		otherHeaderRowFacts: current,
		detectedHeaderRow: hasHeaderRow,
		rowCount: Math.max(0, file.rowCount + (hasHeaderRow ? -1 : 1))
	};
}

/** The file's per-row facts, read through the registry so a new one cannot be left behind. */
function rowFactsOf(file: DesignationFile): DesignationRowFacts {
	return Object.fromEntries(
		DESIGNATION_ROW_FACTS.map((fact) => [fact, file[fact]])
	) as DesignationRowFacts;
}

/**
 * What a payload with no facts for the other answer shows once flipped: NO evidence, rather than
 * evidence about the wrong lines. The recap is the only producer without them, and it has no rows.
 */
function unknownRowFacts(file: DesignationFile): DesignationRowFacts {
	return {
		samples: file.headers.map(() => []),
		firstRow: undefined,
		previewRows: undefined,
		coverage: undefined,
		dateStates: undefined,
		dateReadings: undefined
	};
}
