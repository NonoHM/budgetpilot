import { afterEach, describe, expect, it } from 'vitest';
import { locales, overwriteGetLocale } from '$lib/paraglide/runtime';
import { DEFAULT_CATEGORY_LABELS } from '$lib/domain/categoryLabels';
import { DEFAULT_CATEGORIES } from './defaults';
import { planDefaultCategoryRenames } from './renamePrompt';

/**
 * vitest.server.setup.ts pins the locale to 'fr' for every server spec, so each test that needs
 * the other one says so, and afterEach puts the pin back.
 */
afterEach(() => {
	overwriteGetLocale(() => 'fr');
});

const seeded = (...names: string[]) => names.map((name, index) => ({ id: `cat-${index}`, name }));

const allSeeded = () => DEFAULT_CATEGORIES.map((entry) => ({ id: entry.key, name: entry.name }));

describe('planDefaultCategoryRenames', () => {
	it('offers nothing on a French install, and that is the no-op #162 promised', () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'fr');

		// THE PROPERTY THE WHOLE MIGRATION RESTS ON, asserted rather than assumed. All fourteen
		// seeded names are stored exactly as the French catalogue renders them, so clearing
		// `defaultKey` changed nothing a French reader can see and there is nothing to offer them.
		// If a future catalogue edit breaks that, this goes red and the migration's "genuine no-op"
		// claim stops being true on the same day.
		const plan = planDefaultCategoryRenames(allSeeded());

		expect(plan.proposals).toEqual([]);
		expect(plan.blockedByExistingName).toBe(0);
	});

	it('offers exactly the twelve English labels that differ from their stored name', () => {
		expect.assertions(3);
		overwriteGetLocale(() => 'en');

		const plan = planDefaultCategoryRenames(allSeeded());

		// Twelve, not fourteen. "Transport" and "Shopping" are spelled the same in both catalogues,
		// so proposing them would be a rename that changes nothing. Measured against the catalogue
		// rather than hardcoded to 12, so a translation edit moves the expectation with it.
		const differing = DEFAULT_CATEGORIES.filter(
			(entry) => DEFAULT_CATEGORY_LABELS[entry.key]() !== entry.name
		);
		expect(plan.proposals).toHaveLength(differing.length);
		expect(plan.proposals.map((p) => p.proposedName)).toContain('Groceries');
		expect(plan.proposals.map((p) => p.currentName)).not.toContain('Transport');
	});

	it('matches a seeded row through the fold, not through raw text', () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		// A row stored as "alimentation" IS the seeded "Alimentation" everywhere else in this
		// directory, so it has to be here too. A raw equality would answer differently on MariaDB
		// than on the other two engines, which is the divergence renameCategoryReferences documents.
		const plan = planDefaultCategoryRenames(seeded('alimentation'));

		expect(plan.proposals).toHaveLength(1);
		expect(plan.proposals[0].proposedName).toBe('Groceries');
	});

	it('leaves a category the user renamed alone', () => {
		expect.assertions(1);
		overwriteGetLocale(() => 'en');

		// The fourteen are suggestions, not a protected class. Once renamed, a row is ordinary and
		// nothing may offer to rename it again: the prompt has no memory of which rows were seeded,
		// deliberately, because that memory is exactly the second identity #162 removed.
		expect(planDefaultCategoryRenames(seeded('Mes courses')).proposals).toEqual([]);
	});

	it('refuses a proposal whose name the user already owns, and counts it', () => {
		expect.assertions(3);
		overwriteGetLocale(() => 'en');

		// Renaming "Alimentation" to "Groceries" beside an existing "Groceries" would either break
		// on the unique constraint or read as a request to merge two categories. Neither is what a
		// rename prompt is allowed to mean, so it is dropped and reported.
		const plan = planDefaultCategoryRenames(seeded('Alimentation', 'Groceries', 'Voyage'));

		expect(plan.blockedByExistingName).toBe(1);
		expect(plan.proposals).toHaveLength(1);
		expect(plan.proposals[0].proposedName).toBe('Travel');
	});

	it('does not count an unchanged name as blocked', () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		// The ordering trap inside the implementation, pinned. "Transport" renders as "Transport",
		// so the proposed name is in the user's own category set by construction. Checking the
		// collision before checking "did the name actually change" would report every such row as
		// blocked, and the banner would tell the user something was in their way when nothing was.
		const plan = planDefaultCategoryRenames(seeded('Transport'));

		expect(plan.proposals).toEqual([]);
		expect(plan.blockedByExistingName).toBe(0);
	});

	it('gives an answer that depends on the locale, which is the one place that is intended', () => {
		expect.assertions(locales.length);

		// The mirror of nameMatch.spec.ts's locale-INDEPENDENCE test, and the contrast is the point.
		// Whether a name is already taken must not depend on the reader's language; what to OFFER
		// to rename it to must, because the offer is "put this in your language". So this is the one
		// module in the directory whose answer is allowed to move, and it moves by construction
		// rather than by a special case: on a locale whose catalogue matches the stored names, the
		// plan is empty.
		for (const locale of locales) {
			overwriteGetLocale(() => locale);
			const plan = planDefaultCategoryRenames(allSeeded());
			const expected = DEFAULT_CATEGORIES.filter(
				(entry) => DEFAULT_CATEGORY_LABELS[entry.key]() !== entry.name
			).length;
			expect(plan.proposals).toHaveLength(expected);
		}
	});

	it('is idempotent: the plan is empty once its own proposals have been applied', () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		// What makes `?/adoptDefaultNames` safe to replay. It recomputes the plan from the database
		// rather than trusting a form payload, so a second submission of a stale page finds nothing
		// to do instead of renaming something twice.
		const first = planDefaultCategoryRenames(allSeeded());
		const applied = allSeeded().map((category) => {
			const proposal = first.proposals.find((p) => p.currentName === category.name);
			return proposal ? { ...category, name: proposal.proposedName } : category;
		});

		expect(first.proposals.length).toBeGreaterThan(0);
		expect(planDefaultCategoryRenames(applied).proposals).toEqual([]);
	});
});
