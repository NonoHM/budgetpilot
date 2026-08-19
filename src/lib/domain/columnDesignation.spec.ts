import { describe, expect, it } from 'vitest';
import {
	EMPTY_ASSIGNMENT,
	canImport,
	designate,
	designatedRequiredCount,
	ignoredColumnCount,
	isUnavailableFor,
	missingRequiredRoles,
	pageStateOf,
	roleHolding,
	type RoleAssignment
} from './columnDesignation';

const FULL: RoleAssignment = { date: 0, label: 1, amount: 2, category: 3 };

describe('missing roles are named in ROW ORDER, never counted', () => {
	it('lists them in the order the rows are drawn, not in the order they went missing', () => {
		// The plate requires « Il reste la date et le montant » rather than « 2 colonnes manquent ».
		// Naming them in a different order than the rows are drawn in makes the reader hunt, so the
		// order is asserted rather than the membership: a set comparison cannot see an order.
		const assignment: RoleAssignment = { date: null, label: 1, amount: null, category: null };

		expect(missingRequiredRoles(assignment)).toStrictEqual(['date', 'amount']);
	});

	it('never names the optional role, however absent it is', () => {
		// `category` is missing in every fixture above and must appear in none of them, or the
		// count `n sur 3` and the sentence beside it would disagree about what is required.
		expect(missingRequiredRoles(EMPTY_ASSIGNMENT)).toStrictEqual(['date', 'label', 'amount']);
		expect(missingRequiredRoles(FULL)).toStrictEqual([]);
		expect(designatedRequiredCount({ ...FULL, category: null })).toBe(3);
	});
});

describe('the ignored-column count, which is the figure state 2 shows', () => {
	it('counts DISTINCT column indices rather than roles', () => {
		// Counting roles gives the same answer today, because two roles may not share a column, and
		// would go quietly wrong the moment that changes. The fixture makes the two disagree.
		const shared: RoleAssignment = { date: 0, label: 1, amount: 2, category: 1 };

		expect(ignoredColumnCount(shared, 15)).toBe(12);
		expect(ignoredColumnCount(FULL, 15)).toBe(11);
	});

	it('is 11 of 15 with a category and 12 without, which is the plate own pair', () => {
		expect(ignoredColumnCount(FULL, 15)).toBe(11);
		expect(ignoredColumnCount({ ...FULL, category: null }, 15)).toBe(12);
	});

	it('never goes negative on a file with fewer columns than roles', () => {
		expect(ignoredColumnCount(FULL, 2)).toBe(0);
	});
});

describe('designating a column MOVES it, because a conflict has no representation', () => {
	it('takes the column from the role that held it and reports which role that was', () => {
		// Not an error to display: a role holds exactly one column by construction, so what exists
		// is the move. The vacated role is returned rather than flagged, because « Reprise par X »
		// describes the last GESTURE and not the file, and must not survive a reload.
		const { assignment, vacated } = designate(FULL, 'label', 0);

		expect(vacated).toBe('date');
		expect(assignment.date).toBeNull();
		expect(assignment.label).toBe(0);
		// The other two are untouched. A test asserting only the two that moved would pass on an
		// implementation that reset everything, which is the behaviour this state exists to rule out.
		expect(assignment.amount).toBe(2);
		expect(assignment.category).toBe(3);
	});

	it('reports no vacancy when the column was free', () => {
		const { assignment, vacated } = designate(EMPTY_ASSIGNMENT, 'amount', 7);

		expect(vacated).toBeNull();
		expect(assignment.amount).toBe(7);
	});

	it('reports no vacancy when a role is redesignated to the column it already holds', () => {
		// Choosing the already-designated card closes the sheet and changes nothing. Reporting a
		// vacancy here would make the row announce that it had been taken from itself.
		const { assignment, vacated } = designate(FULL, 'date', 0);

		expect(vacated).toBeNull();
		expect(assignment).toStrictEqual(FULL);
	});

	it('does not mutate the assignment it was given', () => {
		// The screen keeps the previous assignment to render the vacated row against. Mutating in
		// place would make the before and after the same object and the comparison always equal.
		const before: RoleAssignment = { ...FULL };
		designate(before, 'label', 0);

		expect(before).toStrictEqual(FULL);
	});
});

describe('owner ruling 1: Categorie may not take a column a required role holds', () => {
	it('marks the column unavailable in the Categorie picker, naming its holder', () => {
		expect(isUnavailableFor(FULL, 'category', 1)).toBe(true);
		expect(roleHolding(FULL, 1)).toBe('label');
	});

	it('leaves the SAME column choosable for a required role, which is the displacement', () => {
		// The two halves pull opposite ways and neither covers the other: displacement stays between
		// the three required roles and is unchanged, and only the optional role is constrained.
		// A test asserting only the refusal would pass on an implementation that froze every column.
		expect(isUnavailableFor(FULL, 'amount', 1)).toBe(false);
		expect(isUnavailableFor(FULL, 'date', 1)).toBe(false);
	});

	it('leaves the column Categorie itself holds choosable, so it can be reselected', () => {
		expect(isUnavailableFor(FULL, 'category', 3)).toBe(false);
	});

	it('leaves an unheld column choosable for Categorie', () => {
		expect(isUnavailableFor(FULL, 'category', 9)).toBe(false);
	});
});

describe('the page state is derived, so it cannot disagree with the assignment', () => {
	it('is nothingDesignated, partial then complete as the three required roles fill', () => {
		const at = (assignment: RoleAssignment) => pageStateOf({ assignment, columnCount: 15 });

		expect(at(EMPTY_ASSIGNMENT)).toBe('nothingDesignated');
		expect(at({ ...EMPTY_ASSIGNMENT, date: 0 })).toBe('partial');
		expect(at({ ...EMPTY_ASSIGNMENT, date: 0, label: 1 })).toBe('partial');
		expect(at({ ...EMPTY_ASSIGNMENT, date: 0, label: 1, amount: 2 })).toBe('complete');
	});

	it('is complete without a category, because the category is optional', () => {
		// The `3 sur 3` that has to explain why there are four rows. If this returned `partial`, the
		// optional row would be required in fact while being labelled optional on screen.
		expect(pageStateOf({ assignment: { ...FULL, category: null }, columnCount: 15 })).toBe(
			'complete'
		);
	});

	it('refuses a file with fewer than three columns BEFORE anything else', () => {
		// The one honest refusal on this screen, and it is checked first because no designation can
		// repair it. Asserted against an assignment that would otherwise read `complete`, so the
		// ordering is what the test observes rather than the emptiness.
		expect(pageStateOf({ assignment: FULL, columnCount: 2 })).toBe('tooFewColumns');
	});

	// `analysing` USED TO SHARE THIS TEST and is gone with the state itself (Planche 5f): it drew a
	// skeleton on a screen that structurally cannot show one, and no route ever set it. What remains
	// is the half that still has a producer, and its precedence still matters for the same reason.
	it('puts submitting ahead of the assignment, since it does not derive from it', () => {
		expect(pageStateOf({ assignment: FULL, columnCount: 15, submitting: true })).toBe('submitting');
	});

	it('reports signaturePartial ahead of the count, because 3b is not a partial designation', () => {
		// State 3b has its own banner copy and its own count. Falling through to `partial` would
		// show « Colonnes à désigner » on a file whose columns the user already designated once.
		expect(
			pageStateOf({
				assignment: { ...FULL, label: null },
				columnCount: 16,
				signaturePartial: true
			})
		).toBe('signaturePartial');
	});
});

describe('canImport reads the three columns, never the state name', () => {
	it('is true exactly when the three required roles hold a column', () => {
		expect(canImport(EMPTY_ASSIGNMENT, 15)).toBe(false);
		expect(canImport({ ...FULL, amount: null }, 15)).toBe(false);
		expect(canImport({ ...FULL, category: null }, 15)).toBe(true);
		expect(canImport(FULL, 15)).toBe(true);
	});

	it('stays true in state 3b, where the state name says otherwise', () => {
		// The reason this is not `pageStateOf(...) === 'complete'`. In 3b the screen shows the
		// redesignation banner, and if every required role still holds a column the import is
		// genuinely available. Reading the state name would switch the primary off for a reason
		// about presentation.
		const state = pageStateOf({ assignment: FULL, columnCount: 16, signaturePartial: true });

		expect(state).toBe('signaturePartial');
		expect(canImport(FULL, 16)).toBe(true);
	});

	it('is false on a two-column file even when every role somehow holds one', () => {
		expect(canImport(FULL, 2)).toBe(false);
	});
});
