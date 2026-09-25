import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ColumnCard from './ColumnCard.svelte';

/**
 * The stylesheet import above is not decoration. A geometry spec without it reads plausible numbers
 * rather than failing: this repository has measured 44 px as 24, and an 18-of-18 green on a
 * deliberately broken height, purely because nothing loaded the stylesheet. Every height assertion
 * below is ABSOLUTE for the same reason: a purely comparative assertion is satisfied when both
 * sides fall back to the same user-agent defaults, which is exactly the world with no CSS in it.
 *
 * The card is measured at its real width, 350, because truncation is what holds the height and
 * truncation only happens at a width.
 */
const BASE = {
	header: 'Date operation',
	index: 0,
	values: ['24/06/2026', '22/06/2026', '21/06/2026'],
	forRole: 'date'
} as const;

/**
 * THE VIEWPORT IS SET, NOT INHERITED (#720, the same finding as #709 on `DateReadingCard`). A
 * container width moves the card and never a media query, so an `lg:` class applies only when the
 * VIEWPORT is at `lg`. `page.viewport` also persists from one test to the next in this file, so a
 * mount that set nothing would measure whichever width the previous test left behind. Every mount
 * here is the 390 phone, holding a 350 px card; the 1280 test sets its own viewport.
 */
async function mount(props: Record<string, unknown>, viewport: 390 | 1280 = 390) {
	await page.viewport(viewport, viewport === 390 ? 844 : 800);
	expect(window.innerWidth).toBe(viewport);
	const { container } = await render(ColumnCard, { ...BASE, ...props });
	container.style.width = '350px';
	const card = container.querySelector('[role="option"]') as HTMLElement;
	expect(card).not.toBeNull();
	return { container, card };
}

describe('ColumnCard.svelte: 107 px, and it does not move', () => {
	/**
	 * BREAK MATRIX, read per test, run 2026-08-15. Four breaks, and two of them came back green,
	 * which is where the reading was.
	 *
	 * 1. `py-3` to `py-2`: **all four red at 99.** The padding is load bearing and these see it.
	 * 2. Remove `h-[17px]` from the value lines: **all seventeen GREEN.** A fact about the break, not
	 *    about the tests: `leading-[17px]` alone already fixes the line box, so the height never
	 *    moved. `h-[17px]` is belt to that braces.
	 * 3. Remove `whitespace-nowrap`, which is how this would really arrive ("show the whole value"):
	 *    **all seventeen GREEN, and that is a finding about the height assertions.** With a fixed
	 *    17 px box and `overflow-hidden`, a value that wraps is CLIPPED rather than growing, so the
	 *    card is still 107 while the second line of every long value has silently disappeared. A
	 *    fixed size that prevents a defect also hides it. That green is why
	 *    `truncates rather than wrapping` below exists and asserts `scrollWidth` against
	 *    `clientWidth` instead of measuring the card: overflow is observable, absence of wrap is not.
	 *    Under break 3 that test goes red.
	 * 4. Remove `leading-[17px]` and `h-[17px]` together: **three red at 116.75 and 113.5.** This is
	 *    the break the height assertions are actually for.
	 */
	it('is 107 px with three ordinary values', async () => {
		const { card } = await mount({});

		expect(card.getBoundingClientRect().height).toBe(107);
	});

	it('is 107 px when a value is far too long to fit, because the value truncates', async () => {
		const { card } = await mount({ values: ['x'.repeat(400), 'y'.repeat(400), 'z'.repeat(400)] });

		expect(card.getBoundingClientRect().height).toBe(107);
		// The absolute figure beside the invariance: a card that rendered nothing at all would also
		// hold still. Its width is the one the measurement was taken at.
		expect(card.getBoundingClientRect().width).toBe(350);
	});

	it('is 107 px when every value is empty, and says so rather than showing three blank lines', async () => {
		const { card } = await mount({ values: ['', '  ', ''] });

		expect(card.getBoundingClientRect().height).toBe(107);
		// Three of them, not one: a component that rendered `(vide)` for the first cell only would
		// pass a `toBeInTheDocument` and still show two blank lines.
		expect(card.querySelectorAll('span')).toBeDefined();
		expect(card.textContent?.match(/\(vide\)/g)?.length).toBe(3);
	});

	it('is 107 px with an unreadable header, whose raw bytes replace the third value', async () => {
		const { card } = await mount({
			header: 'M�ntant',
			headerUnreadable: true,
			values: ['24,90', '18,00', '5,10']
		});

		expect(card.getBoundingClientRect().height).toBe(107);
		// The raw text is kept verbatim and never repaired, and it REPLACES the third value rather
		// than being added under it. Both halves asserted: the presence of the raw bytes, and the
		// absence of the value they displaced. The second is what holds the 107.
		expect(card.textContent).toContain('M�ntant');
		expect(card.textContent).not.toContain('5,10');
	});

	it('is 107 px at a 1280 px viewport too, because a data card does not scale with the viewport', async () => {
		// Planche 7b, registered in the design referential: « rows scale, data cards do not ». A row
		// is a target and shrinks at 1280 (68 -> 56, 86 -> 74); this card is evidence and holds 107.
		// The card keeps its 350 px width so that the VIEWPORT is the only thing this test moves.
		//
		// #720, break-checked on 2026-09-25, one clause each, against the four 390 tests above:
		// `lg:py-2` on the card (a card that scales at `lg`) left all 18 tests green before this test
		// existed, and now reddens this test alone, 99 px; `max-lg:py-2` (a card that changes below
		// `lg` only) reddens the four 390 tests and leaves this one green.
		const { card } = await mount({}, 1280);

		expect(card.getBoundingClientRect().height).toBe(107);
		expect(card.getBoundingClientRect().width).toBe(350);
	});
});

describe('ColumnCard.svelte: what truncates and what does not', () => {
	it('never truncates the header, because it is the identifier, and truncates the value', async () => {
		// `Date operation` against `Date valeur` is the whole reason. A header that ellipsed to
		// `Date...` would make the two columns indistinguishable in the one place a user compares
		// them.
		const { card } = await mount({
			header: 'Date de comptabilisation de operation bancaire',
			values: ['24/06/2026 valeur au 25/06/2026 reference 998877665544332211', 'b', 'c']
		});

		const title = card.querySelector('span') as HTMLElement;
		expect(title.textContent?.trim()).toBe('Date de comptabilisation de operation bancaire');
		expect(getComputedStyle(title).flexShrink).toBe('0');
	});

	it('truncates the value rather than wrapping it, asserted where the height cannot see it', async () => {
		// Break 3 in the matrix above is why this test is not a height assertion. Removing
		// `whitespace-nowrap` leaves all four heights at exactly 107, because the fixed line box
		// CLIPS the second line instead of growing, so the card holds still while half the value
		// vanishes. `scrollWidth > clientWidth` separates the two states the height cannot:
		// overflowing on one line, versus wrapped and cut off.
		const { card } = await mount({
			values: ['CARTE 22/06 CARREFOUR MARKET BORDEAUX CENTRE REFERENCE 99887766', 'b', 'c']
		});

		const value = card.querySelector('[data-testid="column-card-values"] > span') as HTMLElement;
		expect(value.textContent?.trim()).toContain('CARREFOUR MARKET');
		expect(getComputedStyle(value).whiteSpace).toBe('nowrap');
		expect(value.scrollWidth).toBeGreaterThan(value.clientWidth);
		// The absolute figure beside the comparison: a zero-width element satisfies "greater than"
		// against nothing at all.
		expect(value.clientWidth).toBeGreaterThan(200);
	});
});

describe('ColumnCard.svelte: the four markers', () => {
	it('marks the card designated for THIS role, with the role named in the accessible label', async () => {
		const { card } = await mount({ marker: 'designated', forRole: 'amount', selected: true });

		expect(card.textContent).toContain('Désignée');
		expect(card.getAttribute('aria-selected')).toBe('true');
		// The plate specifies this sentence verbatim. `marker: 'designated'` alone cannot produce it:
		// it says "designated for this role" without saying which role, which is why `forRole` exists.
		expect(card.getAttribute('aria-label')).toContain('Actuellement désignée comme Montant.');
	});

	it('names the OTHER role when the column is already held, rather than saying it is unavailable', async () => {
		// « Deja utilisee » would be true and useless: it tells the user they cannot have it without
		// telling them what to take it from.
		const { card } = await mount({ marker: 'heldBy', heldByRole: 'label' });

		expect(card.textContent).toContain('Actuellement : Libellé');
		expect(card.getAttribute('aria-label')).toContain('Actuellement : Libellé');
	});

	it('carries no badge when merely proposed, because the group heading already said so', async () => {
		const { card } = await mount({ marker: 'proposed' });

		expect(card.textContent).not.toContain('Désignée');
		expect(card.textContent).not.toContain('Actuellement');
	});

	it('falls back to a positional title, and the fallback counts from one', async () => {
		// index is zero based and « Colonne 0 » is a sentence no user has ever needed.
		const { card } = await mount({ header: null, index: 6, headerUnreadable: false });

		expect(card.textContent).toContain('Colonne 7');
	});
});

describe('ColumnCard.svelte: unavailable is aria-disabled, never disabled', () => {
	it('stays announced, stays out of the tab order, and does not fire', async () => {
		// Clicked DIRECTLY rather than through `userEvent`. Playwright and vitest-browser both treat
		// `aria-disabled="true"` as NOT ENABLED and wait for it to become enabled, which never
		// happens: the failure is a 15 second timeout that reads like a missing element. Do not
		// "fix" this back into a userEvent call.
		const onSelect = vi.fn();
		const { card } = await mount({
			marker: 'heldBy',
			heldByRole: 'amount',
			unavailable: true,
			onSelect
		});

		expect(card.getAttribute('aria-disabled')).toBe('true');
		expect(card.hasAttribute('disabled')).toBe(false);
		// Reachable, so its reason stays readable. That is the whole difference from `disabled`.
		expect(card.getAttribute('aria-label')).toContain('Actuellement : Montant');

		card.click();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('fires when it is available, so the test above is about `unavailable` and not about the click', async () => {
		// The presence half. Without it, a component with no handler at all passes the test above.
		const onSelect = vi.fn();
		const { card } = await mount({ onSelect });

		card.click();
		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});

describe('ColumnCard.svelte: one composed label over an aria-hidden block', () => {
	it('announces the header and all three examples in a single string', async () => {
		const { card } = await mount({});

		expect(card.getAttribute('aria-label')).toBe(
			'Date operation. Trois exemples : 24/06/2026, 22/06/2026, 21/06/2026.'
		);
		// The visual block is hidden so the same text cannot be walked a second time, node by node.
		expect(card.querySelector('[aria-hidden="true"]')).not.toBeNull();
	});

	it('speaks a leading minus as a word, because a screen reader otherwise says "tiret"', async () => {
		// The most repeated character on a bank statement. Both spellings are folded: the ASCII
		// hyphen and U+2212, since which one arrives is the bank's choice.
		const { card } = await mount({ values: ['-24,90', '−118,00', '5,10'] });

		expect(card.getAttribute('aria-label')).toContain('moins 24,90, moins 118,00, 5,10');
	});

	it('speaks an empty cell as (vide) rather than skipping it, keeping three examples three', async () => {
		const { card } = await mount({ values: ['24,90', '', '5,10'] });

		expect(card.getAttribute('aria-label')).toContain('24,90, (vide), 5,10');
	});
});

describe('ColumnCard.svelte: no monospace, and where alignment comes from instead', () => {
	it('applies tabular-nums only when the caller says the three values are numeric', async () => {
		const { card } = await mount({ numeric: true, values: ['24,90', '118,00', '5,10'] });

		const grid = card.querySelector('.tabular-nums');
		expect(grid).not.toBeNull();
		expect(getComputedStyle(grid as HTMLElement).fontVariantNumeric).toContain('tabular-nums');
	});

	it('uses no second font family anywhere, monospace included', async () => {
		// An absence assertion, so it carries a presence first: the detector is pointed at a value
		// line that really has a family, and only then asked whether any family is a monospace one.
		const { card } = await mount({ numeric: true });

		const families = [...card.querySelectorAll('span')].map(
			(el) => getComputedStyle(el).fontFamily
		);
		expect(families.length).toBeGreaterThan(3);
		expect(families.every((f) => f.length > 0)).toBe(true);
		expect(families.some((f) => /mono/i.test(f))).toBe(false);
	});
});

describe('ColumnCard.svelte: it is an option in a listbox, not a button', () => {
	it('is never a tab stop, whatever the column count', async () => {
		// Fifteen columns must not be fifteen tab stops. The listbox holds the one stop and moves
		// `aria-activedescendant`, which is why the id prop exists.
		const { card } = await mount({ id: 'column-option-3' });

		expect(card.getAttribute('role')).toBe('option');
		expect(card.getAttribute('tabindex')).toBe('-1');
		expect(card.getAttribute('id')).toBe('column-option-3');
		expect(page.getByRole('button').elements().length).toBe(0);
	});
});
