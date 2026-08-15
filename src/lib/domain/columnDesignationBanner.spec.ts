import { describe, expect, it } from 'vitest';
import { bannerFor, fileMetaLine, submitLabel } from './columnDesignationBanner';
import { EMPTY_ASSIGNMENT, type RoleAssignment } from './columnDesignation';

/**
 * The four sentences that interpolate a COUNT, asserted on the rendered French string.
 *
 * #349: four sites shipped « 1 colonnes seront ignorées », « Ce fichier a 1 colonnes » and
 * « 1 colonnes · 1 lignes ». Every assertion below names the whole visible string rather than
 * re-deriving `n > 1`, because a test that recomputes the rule is a second copy of the rule and
 * agrees with the implementation by construction.
 *
 * **The boundary is n = 1**, the single value where `> 1` and `>= 1` disagree, so every site is
 * asserted at 1 AND at 2. The n >= 2 assertions are the ones that carry the risk in THIS change:
 * the change makes the app say less at zero and differently at one, so the loss lives on the plural
 * side, and a suite that only checked the new singular would pass with the plural deleted. Each
 * n >= 2 string below was copied from `git show HEAD~:messages/fr.json` and is byte-identical to
 * what shipped before this fix.
 *
 * BREAK MATRIX per site is recorded in the PR, one matrix per site rather than one for the file.
 */

const COMPLETE_WITH_CATEGORY: RoleAssignment = { date: 0, label: 1, amount: 2, category: 3 };
const COMPLETE_WITHOUT_CATEGORY: RoleAssignment = { date: 0, label: 1, amount: 2, category: null };

function consequenceOf(assignment: RoleAssignment, columnCount: number): string {
	return bannerFor({ state: 'complete', assignment, columnCount }).consequence;
}

describe('the ignored-columns sentence', () => {
	describe('with the category designated', () => {
		it('is singular at one ignored column', () => {
			// 5 columns, 4 designated: exactly one left over.
			expect(consequenceOf(COMPLETE_WITH_CATEGORY, 5)).toBe(
				'Catégorie incluse. 1 colonne sera ignorée.'
			);
		});

		it('is unchanged from what shipped at two ignored columns', () => {
			expect(consequenceOf(COMPLETE_WITH_CATEGORY, 6)).toBe(
				'Catégorie incluse. 2 colonnes seront ignorées.'
			);
		});

		it('omits the sentence entirely at zero, keeping the category clause', () => {
			// Asserted POSITIVELY on the whole consequence, not with `not.toContain`: the consequence
			// is a concatenation, so a negative assertion over it is satisfied by the wrong string as
			// easily as by the right one.
			expect(consequenceOf(COMPLETE_WITH_CATEGORY, 4)).toBe('Catégorie incluse.');
		});
	});

	describe('without the category', () => {
		it('is singular at one ignored column', () => {
			expect(consequenceOf(COMPLETE_WITHOUT_CATEGORY, 4)).toBe(
				'Catégorie ignorée. 1 colonne sera ignorée.'
			);
		});

		it('is unchanged from what shipped at two ignored columns', () => {
			expect(consequenceOf(COMPLETE_WITHOUT_CATEGORY, 5)).toBe(
				'Catégorie ignorée. 2 colonnes seront ignorées.'
			);
		});

		it('omits the sentence entirely at zero, keeping the category clause', () => {
			// Reachable on a real file: three columns, all three required roles designated.
			expect(consequenceOf(COMPLETE_WITHOUT_CATEGORY, 3)).toBe('Catégorie ignorée.');
		});
	});

	it('says nothing about ignored columns while submitting, at either count', () => {
		// `submitting` replaces line 2 wholesale. Asserted at both sides of the boundary so a plural
		// leaking into this branch would be visible.
		const one = bannerFor({
			state: 'submitting',
			assignment: COMPLETE_WITH_CATEGORY,
			columnCount: 5
		}).consequence;
		const two = bannerFor({
			state: 'submitting',
			assignment: COMPLETE_WITH_CATEGORY,
			columnCount: 6
		}).consequence;

		expect(one).toBe(two);
	});
});

describe('the too-few-columns label', () => {
	it('is singular at one column', () => {
		expect(
			bannerFor({ state: 'tooFewColumns', assignment: EMPTY_ASSIGNMENT, columnCount: 1 }).label
		).toBe('Ce fichier a 1 colonne');
	});

	it('is unchanged from what shipped at two columns', () => {
		expect(
			bannerFor({ state: 'tooFewColumns', assignment: EMPTY_ASSIGNMENT, columnCount: 2 }).label
		).toBe('Ce fichier a 2 colonnes');
	});

	it('still names the three missing roles whatever the count', () => {
		// The consequence carries no count and must not move when the label's branch does.
		expect(
			bannerFor({ state: 'tooFewColumns', assignment: EMPTY_ASSIGNMENT, columnCount: 1 })
				.consequence
		).toBe('Il en faut trois : une date, un libellé, un montant.');
	});
});

describe('the file meta line', () => {
	const HEADERS = 'en-têtes détectés';

	it('is singular on both counts at one column and one row', () => {
		expect(fileMetaLine({ columns: 1, rows: 1, headers: HEADERS })).toBe(
			'1 colonne · 1 ligne · en-têtes détectés'
		);
	});

	it('is unchanged from what shipped at two columns and two rows', () => {
		expect(fileMetaLine({ columns: 2, rows: 2, headers: HEADERS })).toBe(
			'2 colonnes · 2 lignes · en-têtes détectés'
		);
	});

	it('pluralises the two counts independently', () => {
		// The distinguishing fixture: a single ternary driving both counts, or a copied one that
		// reads the wrong variable, is invisible whenever the two numbers agree. These two cases are
		// the only ones where the columns and rows branches disagree.
		expect(fileMetaLine({ columns: 1, rows: 2, headers: HEADERS })).toBe(
			'1 colonne · 2 lignes · en-têtes détectés'
		);
		expect(fileMetaLine({ columns: 2, rows: 1, headers: HEADERS })).toBe(
			'2 colonnes · 1 ligne · en-têtes détectés'
		);
	});

	it('passes the headers fragment through untouched', () => {
		expect(fileMetaLine({ columns: 1, rows: 1, headers: 'aucun en-tête' })).toBe(
			'1 colonne · 1 ligne · aucun en-tête'
		);
	});
});

/**
 * The fifth plural site, found in a wave 2 verification screenshot rather than by reading the
 * catalogue: a one-row statement rendered « Importer 1 lignes » on the largest control of the
 * screen. A one-row statement is not exotic.
 */
describe('submitLabel', () => {
	it('agrees with a single row', () => {
		expect(submitLabel(1)).toBe('Importer 1 ligne');
	});

	it('is unchanged above one, which is the direction this fix is not moving in', () => {
		expect(submitLabel(2)).toBe('Importer 2 lignes');
		expect(submitLabel(132)).toBe('Importer 132 lignes');
	});

	/**
	 * Zero takes the singular in French. Reachable only through the correction path, which returns
	 * its designation payload before parsing and so can open the screen on a file with no data rows.
	 * Asserted rather than left to chance, because that path is filed and not yet closed.
	 */
	it('takes the singular at zero', () => {
		expect(submitLabel(0)).toBe('Importer 0 ligne');
	});
});
