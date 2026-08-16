import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';
import { MAPPING_ROLES, type MappingRole, type UntrustedColumnMapping } from './model';
import { candidateFingerprints } from './fingerprint';
import { foldExactHeader } from '../utils/encoding';

/**
 * A memorised correspondance, drawn on the designation screen with no file in hand.
 *
 * ## Why this adapter exists at all
 *
 * Ruling A1 says the designation screen does not open for a recognised file, and the plate states
 * its accepted cost: the user never re-sees what was memorised, so a correspondance that is ninety
 * percent right repeats unattended forever. `Voir les colonnes` on `/imports` is the path that
 * corrects it, and the recap it opens is a MODE of the same screen rather than a second one.
 *
 * That screen takes a `DesignationFile`, because everything it draws came from an upload. Here
 * there is no upload: the file lived in the browser for the length of one import (owner ruling 2)
 * and nothing kept it. What survives is the mapping and the transactions it produced.
 *
 * ## The value beside each role is what LANDED, not what was read
 *
 * And that is the point rather than a compromise. A correspondance that names the reference column
 * as the label imports every row of every file without one invalid row: no count is wrong, nothing
 * is flagged, and the only evidence anywhere in the application is the label itself. Putting the
 * imported value beside the role is what turns « Champ C » from a name into a mistake the user can
 * see. A sample re-read from a file would say what the column CONTAINS; this says what it BECAME.
 */
export interface RecapSample {
	fileName: string;
	rowCount: number;
	/** One transaction of the batch, rendered, per role. Absent roles draw an empty value. */
	sample: Partial<Record<MappingRole, string>>;
}

export interface RecapDesignation {
	file: DesignationFile;
	assignment: RoleAssignment;
}

/** Trim and lowercase, the fold `fingerprintFor` and `applyColumnMapping` both apply. */
function fold(header: string): string {
	return foldExactHeader(header);
}

function columnOf(mapping: UntrustedColumnMapping, role: MappingRole): string | null {
	if (role === 'date') return mapping.dateColumn;
	if (role === 'label') return mapping.labelColumn;
	if (role === 'amount') return mapping.amountColumn;
	return mapping.categoryColumn;
}

function indexOf(mapping: UntrustedColumnMapping, role: MappingRole): number | null {
	if (role === 'date') return mapping.dateIndex;
	if (role === 'label') return mapping.labelIndex;
	if (role === 'amount') return mapping.amountIndex;
	return mapping.categoryIndex;
}

export function recapDesignation(
	mapping: UntrustedColumnMapping,
	{ fileName, rowCount, sample }: RecapSample
): RecapDesignation {
	return mapping.matchBy === 'position'
		? recapByPosition(mapping, fileName, rowCount, sample)
		: recapByName(mapping, fileName, rowCount, sample);
}

/**
 * The designated roles in role order, in an array padded to the file's real width.
 *
 * A name-matched mapping stores names and no positions, so there is no true index to place a
 * column at, and the recap never draws the column cards (they sit behind `{#if !recap}`) so no
 * index is ever shown. What IS shown is `{columns} colonnes · {rows} lignes`, derived from
 * `headers.length`: a three-role array would tell the user their four-column statement had three
 * columns. The padding costs nothing and keeps that line true.
 */
function recapByName(
	mapping: UntrustedColumnMapping,
	fileName: string,
	rowCount: number,
	sample: Partial<Record<MappingRole, string>>
): RecapDesignation {
	const headers: string[] = [];
	const firstRow: string[] = [];
	// Mutable while it is being filled, `RoleAssignment` on the way out: the exported type is
	// Readonly because the screen owns it once handed over.
	const assignment: Record<MappingRole, number | null> = {
		date: null,
		label: null,
		amount: null,
		category: null
	};

	for (const role of MAPPING_ROLES) {
		const column = columnOf(mapping, role);
		if (column === null) continue;
		assignment[role] = headers.length;
		headers.push(column);
		firstRow.push(sample[role] ?? '');
	}

	while (headers.length < mapping.columnCount) {
		headers.push('');
		firstRow.push('');
	}

	return {
		assignment,
		file: {
			name: fileName,
			headers,
			samples: firstRow.map((value) => [value]),
			firstRow,
			rowCount,
			hasHeaderRow: true
		}
	};
}

/**
 * The REAL positions, kept, because position is the whole of what this mapping knows.
 *
 * Compacting three roles onto columns 1, 2 and 3 would draw a correspondance that does not exist.
 * The plate makes a positional mapping announce itself for a precise reason: a reordered export
 * silently puts amounts in the date column, and the position is the only check the user has.
 */
function recapByPosition(
	mapping: UntrustedColumnMapping,
	fileName: string,
	rowCount: number,
	sample: Partial<Record<MappingRole, string>>
): RecapDesignation {
	const width = Math.max(0, mapping.columnCount);
	const headers = Array.from({ length: width }, () => '');
	const firstRow = Array.from({ length: width }, () => '');
	// Mutable while it is being filled, `RoleAssignment` on the way out: the exported type is
	// Readonly because the screen owns it once handed over.
	const assignment: Record<MappingRole, number | null> = {
		date: null,
		label: null,
		amount: null,
		category: null
	};

	for (const role of MAPPING_ROLES) {
		const index = indexOf(mapping, role);
		if (index === null || !Number.isInteger(index) || index < 0 || index >= width) continue;
		assignment[role] = index;
		firstRow[index] = sample[role] ?? '';
	}

	return {
		assignment,
		file: {
			name: fileName,
			headers,
			samples: firstRow.map((value) => [value]),
			firstRow,
			rowCount,
			// Named by position on the rows, which is what a mapping « mémorisée par position » is.
			hasHeaderRow: false
		}
	};
}

/**
 * Where each remembered role sits in a file the user has just handed back.
 *
 * « État 2, désignations intactes » is the plate's own wording for what the correction screen
 * opens as, and it is the half that matters: the user came to change ONE row. Arriving at an empty
 * screen would make the correction a re-designation, which is the work they already did once.
 *
 * A role whose column is gone stays NULL. Picking a neighbour by proximity would put the money
 * column somewhere plausible and silent, and silent-and-plausible is the failure this whole path
 * exists to remove.
 */
export function designationAssignment(
	mapping: UntrustedColumnMapping,
	headers: readonly string[]
): RoleAssignment {
	// Mutable while it is being filled, `RoleAssignment` on the way out: the exported type is
	// Readonly because the screen owns it once handed over.
	const assignment: Record<MappingRole, number | null> = {
		date: null,
		label: null,
		amount: null,
		category: null
	};
	// An unrecognised `matchBy` resolves nothing, exactly as `applyColumnMapping` refuses it. A
	// stored record must not get the name treatment by being malformed.
	if (mapping.matchBy !== 'name' && mapping.matchBy !== 'position') return assignment;

	if (mapping.matchBy === 'position') {
		for (const role of MAPPING_ROLES) {
			const index = indexOf(mapping, role);
			if (index === null || !Number.isInteger(index) || index < 0 || index >= headers.length)
				continue;
			assignment[role] = index;
		}
		return assignment;
	}

	const present = new Map(headers.map((header, index) => [fold(header), index]));
	for (const role of MAPPING_ROLES) {
		const column = columnOf(mapping, role);
		if (column === null) continue;
		assignment[role] = present.get(fold(column)) ?? null;
	}
	return assignment;
}

/**
 * Whether the file just offered for a correction is the file the correspondance was made for.
 *
 * The correction path asks for a file back, and the user can hand over the wrong one. What follows
 * is silent by construction: the screen opens, the user designates, and the mapping written is a
 * NEW one under the new file's fingerprint. It is correct for the file they picked, it leaves the
 * wrong correspondance they came to fix exactly where it was, and nothing anywhere says so. The
 * user's next statement of the original shape is read through the same mistake.
 *
 * BOTH canonicalisations are compared rather than the one matching `matchBy`. A correspondance
 * « mémorisée par position » is fingerprinted over the ordered cells and one remembered by name
 * over the sorted ones; testing only the stored `matchBy` would be right, and testing both is
 * right and cannot be wrong when a stored row carries a `matchBy` its fingerprint disagrees with.
 */
export function correctionMatchesFile(
	mapping: { fingerprint: string },
	headers: string[]
): boolean {
	return candidateFingerprints(headers).includes(mapping.fingerprint);
}
