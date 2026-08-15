import { describe, expect, it } from 'vitest';
import { applyColumnMapping } from './apply';
import type { ColumnMappingInput } from './model';

/**
 * The header cells here are FILE CONTENT, not identifiers, which is why several are French: they
 * are the literal bytes a French bank writes in its header row.
 */
const REMEMBERED: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'date operation',
	labelColumn: 'intitule',
	amountColumn: 'montant',
	categoryColumn: 'categorie',
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 4
};

const POSITIONAL: ColumnMappingInput = {
	matchBy: 'position',
	dateColumn: null,
	labelColumn: null,
	amountColumn: null,
	categoryColumn: null,
	dateIndex: 0,
	labelIndex: 1,
	amountIndex: 2,
	categoryIndex: null,
	columnCount: 4
};

/**
 * BREAK MATRIX, read per test, 2026-08-14. The break: resolve each role from the REMEMBERED
 * spelling instead of looking it up in the file, which is how this regression would really arrive
 * ("the fingerprint already proved it is the same shape, so the lookup is redundant work").
 *
 * Five red: the three 3b tests, 3c, and `returns the FILE spelling`.
 *
 * **Eight green, and two of them are a finding about themselves.** `resolves every remembered
 * column` and `is unbothered by a column inserted in the middle` both stay green, because in their
 * fixtures the remembered spelling and the file spelling are byte identical, so the broken version
 * and the correct one agree. Those are the two tests anybody would point at as covering state 3,
 * and neither can see the check that makes state 3 safe.
 *
 * So within state 3 the ONLY guard is `returns the FILE spelling, being the only state 3 fixture
 * whose two spellings differ`. It reads like a cosmetic assertion about case and trimming and it is
 * not: it is the one fixture where the two spellings differ, which is the only condition under
 * which the lookup is observable. It was renamed after this matrix was read, because its old name
 * described what it looked like rather than what made it load bearing, and the keep-out now sits in
 * the test itself rather than only up here where a reader tidying one test will not be looking.
 *
 * The remaining greens are correct for their own reasons: the positional tests take another code
 * path entirely, and `is not reached by a mapping that never stored a category` asserts
 * `recognised`, which both versions produce.
 */
describe('state 3: the file is recognised and the screen never opens', () => {
	it('resolves every remembered column, whatever order the bank writes them in', () => {
		const verdict = applyColumnMapping(REMEMBERED, [
			'montant',
			'categorie',
			'date operation',
			'intitule'
		]);

		expect(verdict).toEqual({
			kind: 'recognised',
			columns: {
				date: 'date operation',
				label: 'intitule',
				amount: 'montant',
				category: 'categorie'
			}
		});
	});

	it('returns the FILE spelling, being the only state 3 fixture whose two spellings differ', () => {
		// DO NOT DELETE THIS AS REDUNDANT WITH THE FIRST TEST, and do not "simplify" the fixture to
		// match the remembered spelling. The name says what makes it load bearing rather than what
		// it looks like: it reads as a cosmetic assertion about case and trimming and it is not.
		//
		// Every other test in this describe uses a fixture where the remembered spelling and the
		// file spelling are byte identical, so an implementation that skipped the lookup entirely
		// and echoed the remembered spelling back would pass all of them. This is the one fixture
		// where the two differ, which is the only condition under which the lookup is observable at
		// all, so within state 3 this test is the whole of the guard. Measured in the break matrix
		// at the top of this file: under that break, this goes red and the other two stay green.
		//
		// The returned value is what the parser will look up in each row, so it has to be the
		// header exactly as this file writes it, not the remembered spelling. Returning the
		// remembered one passes every equality test above and then finds nothing.
		const verdict = applyColumnMapping(REMEMBERED, [
			'  Date Operation ',
			'INTITULE',
			'Montant',
			'Categorie'
		]);

		expect(verdict).toEqual({
			kind: 'recognised',
			columns: {
				date: '  Date Operation ',
				label: 'INTITULE',
				amount: 'Montant',
				category: 'Categorie'
			}
		});
	});

	it('is unbothered by a column inserted in the middle', () => {
		const verdict = applyColumnMapping(REMEMBERED, [
			'date operation',
			'reference',
			'intitule',
			'montant',
			'categorie'
		]);

		expect(verdict.kind).toBe('recognised');
	});
});

describe('state 3b: one column moved and the rest did not', () => {
	it('keeps the two intact roles and names only the one that is gone', () => {
		// The plate's whole argument for remembering by NAME: nothing is reset. A test asserting
		// only `kind === 'partial'` would pass on an implementation that threw the other two away,
		// which is the behaviour this state exists to rule out.
		const verdict = applyColumnMapping(REMEMBERED, [
			'date operation',
			'montant',
			'libelle complet',
			'categorie'
		]);

		expect(verdict).toEqual({
			kind: 'partial',
			columns: {
				date: 'date operation',
				amount: 'montant',
				category: 'categorie'
			},
			lostRoles: ['label']
		});
	});

	it('names the lost roles in row order when two are gone', () => {
		const verdict = applyColumnMapping(REMEMBERED, ['jour', 'montant', 'objet', 'categorie']);

		expect(verdict).toMatchObject({ kind: 'partial', lostRoles: ['date', 'label'] });
	});

	it('treats a vanished CATEGORY column as partial rather than as recognised', () => {
		// A decision, not a fallout, and it is written here because the opposite is defensible.
		// The category role is optional when a mapping is CREATED, so a file missing it could be
		// imported straight through. It is reported instead: a category column that disappears
		// silently changes what every future import of this shape records, and the user is the
		// only one who can say whether the bank renamed it or dropped it.
		const verdict = applyColumnMapping(REMEMBERED, ['date operation', 'intitule', 'montant']);

		expect(verdict).toEqual({
			kind: 'partial',
			columns: { date: 'date operation', label: 'intitule', amount: 'montant' },
			lostRoles: ['category']
		});
	});

	it('is not reached by a mapping that never stored a category', () => {
		// The presence half of the test above: a mapping with no category column must still be
		// `recognised`, or every mapping made without one would open the screen forever.
		const noCategory: ColumnMappingInput = { ...REMEMBERED, categoryColumn: null };
		const verdict = applyColumnMapping(noCategory, ['date operation', 'intitule', 'montant']);

		expect(verdict).toEqual({
			kind: 'recognised',
			columns: { date: 'date operation', label: 'intitule', amount: 'montant', category: null }
		});
	});
});

describe('state 3c: nothing remembered is still here', () => {
	it('applies nothing at all rather than applying what it can', () => {
		const verdict = applyColumnMapping(REMEMBERED, ['a', 'b', 'c', 'd']);

		expect(verdict).toEqual({ kind: 'lost' });
	});
});

describe('the positional path, which has no integrity check and is weaker on purpose', () => {
	it('applies to a file of the same column count', () => {
		const verdict = applyColumnMapping(POSITIONAL, ['jour', 'objet', 'somme', 'note']);

		expect(verdict).toEqual({
			kind: 'recognised',
			columns: { date: 'jour', label: 'objet', amount: 'somme', category: null }
		});
	});

	it('falls to lost when the column count differs, which is the only check available', () => {
		// There are no names to verify against the file, so a mapping applied to a file of a
		// different shape would read whatever now sits at index 2. The count is a weaker guarantee
		// than the name check, not an equivalent one, and this test is the whole of it.
		expect(applyColumnMapping(POSITIONAL, ['jour', 'objet', 'somme'])).toEqual({ kind: 'lost' });
		expect(applyColumnMapping(POSITIONAL, ['jour', 'objet', 'somme', 'note', 'x'])).toEqual({
			kind: 'lost'
		});
	});

	it('applies to a REORDERED file of the same count, which the fingerprint is what prevents', () => {
		// Recorded rather than fixed here. This function cannot tell a reordered file from a
		// different one, because a positional mapping carries no names. What keeps this out of the
		// user's way is `fingerprintFor(headers, 'position')`, which is order sensitive, so a
		// reordered file never finds this mapping in the first place. The two halves are separate
		// and neither covers the other: if the fingerprint ever stopped being ordered, this
		// function would apply the mapping and nothing here would object.
		const reordered = applyColumnMapping(POSITIONAL, ['somme', 'objet', 'jour', 'note']);

		expect(reordered).toEqual({
			kind: 'recognised',
			columns: { date: 'somme', label: 'objet', amount: 'jour', category: null }
		});
	});

	it('refuses an index that no longer addresses a column', () => {
		// Belt and braces against a mapping whose columnCount agrees with the file while an index
		// does not, which is reachable through a restored backup written before the validator.
		const broken: ColumnMappingInput = { ...POSITIONAL, amountIndex: 9 };

		expect(applyColumnMapping(broken, ['jour', 'objet', 'somme', 'note'])).toEqual({
			kind: 'lost'
		});
	});
});

describe('the file with no header row at all', () => {
	it('resolves nothing, because there is nothing to resolve', () => {
		// A headerless file's first line is data. There is no stable text to match and no stable
		// shape to promise, which is why the design forbids offering to memorise one: a promise we
		// know cannot be kept is not made and then quietly broken, it is not made.
		expect(applyColumnMapping(REMEMBERED, [])).toEqual({ kind: 'lost' });
		expect(applyColumnMapping(POSITIONAL, [])).toEqual({ kind: 'lost' });
	});
});
