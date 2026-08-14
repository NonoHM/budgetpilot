import { MAPPING_ROLES, type ColumnMappingInput, type MappingRole } from './model';

/**
 * Which header of THIS file fills each role, or null where the role was never mapped.
 *
 * The values are the file's own spelling, never the remembered one, because the parser looks each
 * one up in the row records it built from this file's header line.
 */
export type ResolvedColumns = Record<MappingRole, string | null>;

/**
 * What a remembered mapping is worth against the file in front of it.
 *
 * The three kinds are the design plate's states 3, 3b and 3c, in that order.
 */
export type MappingVerdict =
	| { kind: 'recognised'; columns: ResolvedColumns }
	| { kind: 'partial'; columns: Partial<Record<MappingRole, string>>; lostRoles: MappingRole[] }
	| { kind: 'lost' };

/** Trim and lowercase, the same fold `fingerprintFor` applies, so the two never disagree. */
function fold(header: string): string {
	return header.trim().toLowerCase();
}

/**
 * Which of a remembered mapping's columns are still in this file.
 *
 * ## The name check is load-bearing TWICE, and neither reason is redundant with the fingerprint
 *
 * As DESIGN it is the plate's states 3b and 3c: a bank that renames one column breaks one row and
 * leaves the others standing, and a bank that changes its format entirely asks again. That is the
 * entire argument for remembering by name rather than by position.
 *
 * As a CONTROL it is what stops a stored record silently redirecting money. A mapping that is
 * stale, restored from a backup, or simply mis-designated once and then remembered would otherwise
 * read whatever column now sits where the amount used to be. It is also what makes a fingerprint
 * collision survivable rather than silent: two colliding shapes have different column names, so
 * the file falls to state 3c instead of importing wrongly.
 *
 * **Do not remove it as redundant with the fingerprint.** The fingerprint says "this looks like a
 * file we have seen". This says "and the columns we were told about are still here". A hash cannot
 * answer the second question, because it threw the names away.
 *
 * ## The positional path is weaker, and saying so is part of the contract
 *
 * When `matchBy` is `position` there are no names to verify, so the control above cannot exist
 * here at all. What can be checked is the shape: a file whose column count differs from the one
 * the mapping was made against falls straight to `lost` rather than being applied by index into a
 * different file, and an index that does not address a column does the same.
 *
 * That is a WEAKER guarantee, not an equivalent one. A file reordered without changing its column
 * count would be applied, and what keeps it away is `fingerprintFor(headers, 'position')` being
 * order sensitive, which lives in the other file. Neither half covers the other, and the recap
 * screen has to say « mémorisée par position » for exactly this reason.
 */
export function applyColumnMapping(mapping: ColumnMappingInput, headers: string[]): MappingVerdict {
	if (headers.length === 0) return { kind: 'lost' };

	return mapping.matchBy === 'position'
		? applyByPosition(mapping, headers)
		: applyByName(mapping, headers);
}

function applyByName(mapping: ColumnMappingInput, headers: string[]): MappingVerdict {
	const remembered: Record<MappingRole, string | null> = {
		date: mapping.dateColumn,
		label: mapping.labelColumn,
		amount: mapping.amountColumn,
		category: mapping.categoryColumn
	};

	const present = new Map(headers.map((header) => [fold(header), header]));

	const columns: ResolvedColumns = { date: null, label: null, amount: null, category: null };
	const lostRoles: MappingRole[] = [];
	let mappedRoles = 0;

	// MAPPING_ROLES order rather than object order: the plate requires the lost roles to be named
	// in row order, and a message built from an unordered set reads differently every time.
	for (const role of MAPPING_ROLES) {
		const name = remembered[role];
		if (name === null) continue;

		mappedRoles += 1;
		const found = present.get(fold(name));
		if (found === undefined) lostRoles.push(role);
		else columns[role] = found;
	}

	if (mappedRoles === 0) return { kind: 'lost' };
	if (lostRoles.length === 0) return { kind: 'recognised', columns };
	if (lostRoles.length === mappedRoles) return { kind: 'lost' };

	const kept: Partial<Record<MappingRole, string>> = {};
	for (const role of MAPPING_ROLES) {
		const column = columns[role];
		if (column !== null) kept[role] = column;
	}
	return { kind: 'partial', columns: kept, lostRoles };
}

function applyByPosition(mapping: ColumnMappingInput, headers: string[]): MappingVerdict {
	// The shape check, which is the whole of what this path can verify. See the docstring.
	if (mapping.columnCount !== headers.length) return { kind: 'lost' };

	const indices: Record<MappingRole, number | null> = {
		date: mapping.dateIndex,
		label: mapping.labelIndex,
		amount: mapping.amountIndex,
		category: mapping.categoryIndex
	};

	const columns: ResolvedColumns = { date: null, label: null, amount: null, category: null };
	for (const role of MAPPING_ROLES) {
		const index = indices[role];
		if (index === null) continue;

		// A stored index that does not address a column of this file. `validateColumnMapping`
		// refuses one at write time, so reaching here means a row that predates the validator or a
		// restore that skipped it, and applying it would read `undefined` as a date.
		if (!Number.isInteger(index) || index < 0 || index >= headers.length) return { kind: 'lost' };
		columns[role] = headers[index];
	}

	if (MAPPING_ROLES.every((role) => columns[role] === null)) return { kind: 'lost' };
	return { kind: 'recognised', columns };
}
