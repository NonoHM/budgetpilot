import {
	MAPPING_ROLES,
	REQUIRED_MAPPING_ROLES,
	type MappingRole
} from '$lib/server/import/mapping/model';

/**
 * The designation screen's state, derived rather than stored.
 *
 * **Is this a fact about the past or a verdict on the present?** It is a verdict: which page state
 * the screen is in follows entirely from which roles hold a column, so it is recomputed and can
 * never disagree with the assignment it describes. A stored `state` field would be a second source
 * of truth for something already fully determined, and the day the two disagree nothing is watching.
 *
 * The screen iterates over the FOUR ROLES, never over the N columns. That is the structural decision
 * the whole design rests on: column count is unbounded and role count is closed at four, so the
 * layout's height is a constant and a fifteen-column file costs the same vertical space as a
 * three-column one.
 */

/** Which column index, if any, each role currently holds. */
export type RoleAssignment = Readonly<Record<MappingRole, number | null>>;

export const EMPTY_ASSIGNMENT: RoleAssignment = {
	date: null,
	label: null,
	amount: null,
	category: null
};

export interface DesignationFile {
	/** The uploaded file's name, shown on the file block's first line and ellipsed there. */
	name: string;
	/** Header cells as the file writes them. Empty string where the file has no readable header. */
	headers: readonly string[];
	/** Per column, the first three data values in file order. Short columns are padded with ''. */
	samples: readonly (readonly string[])[];
	/** Data rows, excluding the header row. Displayed, and used in the primary's label. */
	rowCount: number;
	/** False when the first line is data rather than headers. Card titles become positions. */
	hasHeaderRow: boolean;
}

/**
 * The page states, from the plate's own inventory. `analysing` and `submitting` are the two that are
 * not a function of the assignment, which is why they are passed in rather than derived.
 */
export type DesignationPageState =
	| 'analysing'
	| 'submitting'
	| 'tooFewColumns'
	| 'nothingDesignated'
	| 'partial'
	| 'complete'
	| 'signaturePartial';

/**
 * The three roles a transaction cannot be built without, in ROW ORDER.
 *
 * Row order is not cosmetic here. The plate requires the missing-roles sentence to name them
 * ("Il reste la date et le montant") rather than count them ("2 colonnes manquent"), and naming
 * them in a different order than the rows are drawn in makes the reader hunt.
 */
export function missingRequiredRoles(assignment: RoleAssignment): MappingRole[] {
	return REQUIRED_MAPPING_ROLES.filter((role) => assignment[role] === null);
}

export function designatedRequiredCount(assignment: RoleAssignment): number {
	return REQUIRED_MAPPING_ROLES.length - missingRequiredRoles(assignment).length;
}

/**
 * How many of the file's columns no role uses.
 *
 * The plate puts this in state 2's sentence ("11 colonnes seront ignorées") and the number is the
 * point: on a fifteen-column statement, eleven ignored columns is the NORMAL outcome, and saying so
 * is what stops a user hunting for a way to use them.
 *
 * Counted over DISTINCT column indices, not over roles. Two roles may not share a column today, but
 * counting roles would make this figure wrong the moment that changes, and wrong quietly.
 */
export function ignoredColumnCount(assignment: RoleAssignment, columnCount: number): number {
	const used = new Set<number>();
	for (const role of MAPPING_ROLES) {
		const index = assignment[role];
		if (index !== null) used.add(index);
	}
	return Math.max(0, columnCount - used.size);
}

/**
 * The role, if any, that currently holds this column.
 *
 * Drives the picker's « Actuellement : Date » marker. Returns the FIRST match in role order, which
 * is unambiguous today because `validateColumnMapping` refuses two roles sharing a column, and the
 * refusal is enforced on the server rather than only here.
 */
export function roleHolding(assignment: RoleAssignment, columnIndex: number): MappingRole | null {
	return MAPPING_ROLES.find((role) => assignment[role] === columnIndex) ?? null;
}

/**
 * Owner ruling 1. Categorie may never take a column a REQUIRED role holds.
 *
 * The card stays in the Categorie picker carrying « Actuellement : Libellé » and is not choosable,
 * rather than being hidden: removing it would send the user hunting for a column that is visibly in
 * their own file. This is the affordance; `validateColumnMapping` is the control.
 */
export function isUnavailableFor(
	assignment: RoleAssignment,
	role: MappingRole,
	columnIndex: number
): boolean {
	if (role !== 'category') return false;
	const holder = roleHolding(assignment, columnIndex);
	return holder !== null && holder !== 'category';
}

/**
 * Designate a column, MOVING it when another role already holds it.
 *
 * The plate is explicit that a conflict has no representation in the model: a role holds exactly one
 * column by construction, so what exists is the move, not an error to display. The role that loses
 * its column is reported back so the screen can render « Reprise par X » on it, which is a
 * TRANSIENT display state and deliberately not stored: it describes the last gesture, not the file.
 *
 * Returns the vacated role rather than mutating a flag, so the caller decides how long to show it.
 */
export function designate(
	assignment: RoleAssignment,
	role: MappingRole,
	columnIndex: number
): { assignment: RoleAssignment; vacated: MappingRole | null } {
	const previousHolder = roleHolding(assignment, columnIndex);
	const next: Record<MappingRole, number | null> = { ...assignment };

	if (previousHolder !== null && previousHolder !== role) {
		next[previousHolder] = null;
	}
	next[role] = columnIndex;

	return {
		assignment: next,
		vacated: previousHolder !== null && previousHolder !== role ? previousHolder : null
	};
}

/**
 * The page state, given the assignment and the two conditions that are not derived from it.
 *
 * `tooFewColumns` is checked FIRST and is the one honest refusal on this screen: a file with fewer
 * than three columns cannot carry a transaction whatever the user designates. Zinc, never rose, in
 * the render: the user did nothing wrong, the file is incomplete.
 */
export function pageStateOf(input: {
	assignment: RoleAssignment;
	columnCount: number;
	analysing?: boolean;
	submitting?: boolean;
	/** At least one remembered column was found by name and at least one was lost. Plate state 3b. */
	signaturePartial?: boolean;
}): DesignationPageState {
	if (input.analysing) return 'analysing';
	if (input.submitting) return 'submitting';
	if (input.columnCount < REQUIRED_MAPPING_ROLES.length) return 'tooFewColumns';
	if (input.signaturePartial) return 'signaturePartial';

	const designated = designatedRequiredCount(input.assignment);
	if (designated === 0) return 'nothingDesignated';
	if (designated < REQUIRED_MAPPING_ROLES.length) return 'partial';
	return 'complete';
}

/**
 * Whether the import may be attempted. The primary reads this and nothing else.
 *
 * Deliberately NOT `pageStateOf(...) === 'complete'`: state 3c presents as `nothingDesignated` and
 * `submitting` presents as itself, and reading the state name would make this true or false for
 * reasons about presentation rather than about the three columns being designated.
 */
export function canImport(assignment: RoleAssignment, columnCount: number): boolean {
	return (
		columnCount >= REQUIRED_MAPPING_ROLES.length && missingRequiredRoles(assignment).length === 0
	);
}
