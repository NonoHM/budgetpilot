import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import * as m from '$lib/paraglide/messages';
import type { PageData } from './$types';

// Same recorder as the other page specs: the page's own submit functions stay under test, and
// nothing here drives one — these assertions are about what the list PRINTS.
vi.mock('$app/forms', () => ({ enhance: () => ({}) }));

function buildData(names: string[]): PageData {
	return {
		categories: names.map((name, index) => ({
			id: `category-${index}`,
			name,
			transactionCount: 3,
			pausedRuleCount: 0,
			nature: null,
			mappingId: null
		})),
		natureOptions: ['income', 'spending', 'transfer', 'investment', 'refund', 'fee'],
		renamePrompt: null
	} as unknown as PageData;
}

/**
 * The RENDERED text, not the DOM's. Both breakpoint chromes are in the tree at every width (one
 * `hidden lg:block`, one `lg:hidden`), so `textContent` at 390 also reads the desktop table and the
 * viewport parameter separates nothing — measured: breaking the desktop cell alone reddened the
 * 390 case too. `innerText` is what the browser actually paints, so each width now answers for its
 * own markup.
 */
function visibleText(container: HTMLElement): string {
	return container.innerText;
}

/**
 * `UNCLASSIFIED_CATEGORY` is the technical slug `uncategorized`, stored so that "unclassified" is a
 * real row a transaction can point at, and never a name (domain/categories.ts). Measured on 0.14.0:
 * the system row printed the slug in the list while the page's own explanatory sentence, twelve
 * lines further down the same file, already printed « Non catégorisé » through
 * `categoryDisplayName`. One screen, two answers.
 *
 * Both widths are asserted because they are different markup — a table cell at 1280, a `ListCard`
 * at 390 — so a fix to one leaves the other shipping.
 */
describe('/categories — the unclassified sentinel is never printed raw', () => {
	/**
	 * Separates "the row prints the stored slug" from "the row prints its display name". The
	 * positive assertion is what makes the negative one a finding: a page rendering no rows at all
	 * satisfies `not.toContain` on its own, which is the emptiness trap this repo has hit before.
	 */
	it.each([
		[1280, 900],
		[390, 844]
	])('shows the display name, not the slug, at %ix%i', async (width, height) => {
		expect.assertions(2);
		await page.viewport(width, height);

		const { container } = render(Page, {
			data: buildData([UNCLASSIFIED_CATEGORY, 'Alimentation']),
			form: null
		});

		const rendered = visibleText(container as HTMLElement);
		expect(rendered).toContain(m.common_category_uncategorized());
		expect(rendered).not.toContain(UNCLASSIFIED_CATEGORY);
	});

	/**
	 * The other half, and it is what stops the fix becoming a rename: since #162 a stored category
	 * name IS the name, shown as-is. Separates "only the sentinel is translated" from "every row is
	 * put through a translation table", which the assertion above cannot tell apart on its own.
	 */
	it('leaves an ordinary category name exactly as stored', async () => {
		await page.viewport(1280, 900);

		const { container } = render(Page, { data: buildData(['Alimentation']), form: null });

		expect(visibleText(container as HTMLElement)).toContain('Alimentation');
	});

	/**
	 * The identifier half of the same rule, and it is the one that would cost data rather than
	 * legibility: every form on this page posts `categoryName`, which the server resolves against
	 * the STORED name. Translating that value would send « Non catégorisé » to a lookup that only
	 * knows `uncategorized`. See CLAUDE.md, "join on an identifier, never on displayed text" —
	 * renaming a category once took a page from 5000 cents to 0.
	 */
	it('keeps the stored slug as the posted identifier', async () => {
		await page.viewport(1280, 900);

		const { container } = render(Page, { data: buildData([UNCLASSIFIED_CATEGORY]), form: null });

		const posted = [...container.querySelectorAll('input[name="categoryName"]')].map(
			(node) => (node as HTMLInputElement).value
		);
		expect(posted.length).toBeGreaterThan(0);
		expect(posted.every((value) => value === UNCLASSIFIED_CATEGORY)).toBe(true);
	});
});
