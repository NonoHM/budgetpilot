import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import DateReadingCard from './DateReadingCard.svelte';

/**
 * The stylesheet import is not decoration, same reason as `ColumnCard.svelte.spec.ts`: a geometry
 * spec with no CSS loaded reads plausible numbers off user-agent defaults rather than failing.
 *
 * ColumnCard's second member of one species: a card that shows the user their own data, this time
 * two readings of the same three raw values rather than a column identity. Measured at 350 px width
 * for the same reason ColumnCard is: truncation is what would hold the height under a long value,
 * and truncation only happens at a width.
 */
const BASE = {
	order: 'day-first' as const,
	pairs: [
		{ raw: '03/04/2026', pretty: '3 avril 2026' },
		{ raw: '11/04/2026', pretty: '11 avril 2026' },
		{ raw: '02/04/2026', pretty: '2 avril 2026' }
	],
	current: false
};

function mount(props: Record<string, unknown>) {
	const { container } = render(DateReadingCard, { ...BASE, ...props });
	container.style.width = '350px';
	const card = container.querySelector('[role="option"]') as HTMLElement;
	expect(card).not.toBeNull();
	return { container, card };
}

describe('DateReadingCard.svelte: 107 px at both widths, and it does not move', () => {
	/**
	 * BREAK, run before implementation existed as a module-resolution failure (see report), then
	 * re-run against the real component. Two breaks recorded here, both isolated to the assertion
	 * they targeted:
	 *
	 * 1. `py-3` to `py-2`: separates "the padding is load bearing" from "the height is incidental".
	 * 2. Widen the header row from `h-5` to `h-6`: separates "the header line box is fixed" from
	 *    "any 20px number would have passed".
	 */
	it('is 107 px at 350 px width, with three ordinary pairs', () => {
		// Separates "the geometry holds for a real render" from "the height is a CSS default".
		const { card } = mount({});

		expect(card.getBoundingClientRect().height).toBe(107);
		expect(card.getBoundingClientRect().width).toBe(350);
	});

	it('stays 107 px when the card is the current reading and shows the marker', () => {
		// Separates "the marker line is the same fixed 20px header row" from "the marker adds a row".
		const { card } = mount({ current: true });

		expect(card.getBoundingClientRect().height).toBe(107);
	});

	it('stays 107 px when a converted value is far too long to fit, because the line truncates', () => {
		// Separates "the line is a fixed box that clips" from "a long value grows the card".
		const { card } = mount({
			pairs: [
				{
					raw: '03/04/2026',
					pretty: 'un jour de printemps particulièrement ensoleillé et long'.repeat(4)
				},
				{ raw: '11/04/2026', pretty: '11 avril 2026' },
				{ raw: '02/04/2026', pretty: '2 avril 2026' }
			]
		});

		expect(card.getBoundingClientRect().height).toBe(107);
	});

	it('is 107 px at 1280 px width too, because the card does not scale with the viewport', () => {
		// Separates "the card is evidence, fixed at both widths" from "the card is a row, which
		// scales" (86 -> 74, 68 -> 56 elsewhere on this screen per the plate).
		const { container } = render(DateReadingCard, BASE);
		container.style.width = '1280px';
		const card = container.querySelector('[role="option"]') as HTMLElement;

		expect(card.getBoundingClientRect().height).toBe(107);
	});
});

describe('DateReadingCard.svelte: the title names the reading', () => {
	it('titles the day-first card', () => {
		const { card } = mount({ order: 'day-first' });

		expect(card.textContent).toContain('Jour puis mois');
	});

	it('titles the month-first card', () => {
		const { card } = mount({ order: 'month-first' });

		expect(card.textContent).toContain('Mois puis jour');
	});
});

describe('DateReadingCard.svelte: the three lines, raw then pretty', () => {
	it('renders each pair as raw, an arrow, then the converted value, in that order', () => {
		const { card } = mount({});

		const text = card.textContent ?? '';
		// Separates "raw precedes pretty on each line" from "both are present in any order": each
		// pair's own arrow sits strictly between its own two values.
		for (const pair of BASE.pairs) {
			const rawAt = text.indexOf(pair.raw);
			const arrowAt = text.indexOf('→', rawAt);
			const prettyAt = text.indexOf(pair.pretty, arrowAt);
			expect(rawAt).toBeGreaterThanOrEqual(0);
			expect(arrowAt).toBeGreaterThan(rawAt);
			expect(prettyAt).toBeGreaterThan(arrowAt);
		}
	});

	it('applies tabular-nums to the raw side only, never to the converted prose', () => {
		// Separates "digits align down the column" (raw) from "tabular figures inside prose read as
		// a table that is not there" (pretty). Both spans are read, not just one, per the
		// fixture-blindness rule: a probe that only checked the raw side would pass a component that
		// also (wrongly) put tabular-nums on the pretty side.
		const { card } = mount({});

		const rawSpans = [...card.querySelectorAll('span')].filter(
			(el) => el.textContent?.trim() === BASE.pairs[0].raw
		);
		const prettySpans = [...card.querySelectorAll('span')].filter(
			(el) => el.textContent?.trim() === BASE.pairs[0].pretty
		);
		expect(rawSpans.length).toBeGreaterThan(0);
		expect(prettySpans.length).toBeGreaterThan(0);
		expect(getComputedStyle(rawSpans[0]).fontVariantNumeric).toContain('tabular-nums');
		expect(getComputedStyle(prettySpans[0]).fontVariantNumeric).not.toContain('tabular-nums');
	});

	it('truncates a long line rather than wrapping it, asserted where the height cannot see it', () => {
		// Same reasoning as ColumnCard's identical test: a fixed 17px line box with overflow-hidden
		// CLIPS a wrapped second line instead of growing, so the height assertion above cannot tell
		// truncation from wrapping-then-clipping. scrollWidth vs clientWidth can.
		const { card } = mount({
			pairs: [
				{
					raw: '03/04/2026',
					pretty: 'un jour de printemps particulièrement ensoleillé et long'.repeat(4)
				},
				{ raw: '11/04/2026', pretty: '11 avril 2026' },
				{ raw: '02/04/2026', pretty: '2 avril 2026' }
			]
		});

		const lines = card.querySelectorAll('[data-testid="date-reading-card-lines"] > span');
		const line = lines[0] as HTMLElement;
		expect(getComputedStyle(line).whiteSpace).toBe('nowrap');
		expect(line.scrollWidth).toBeGreaterThan(line.clientWidth);
		expect(line.clientWidth).toBeGreaterThan(200);
	});
});

describe('DateReadingCard.svelte: the current marker', () => {
	it('shows the retained-reading marker only when current', () => {
		const { card: current } = mount({ current: true });
		const { card: notCurrent } = mount({ current: false });

		expect(current.textContent).toContain('Lecture retenue');
		expect(notCurrent.textContent).not.toContain('Lecture retenue');
	});

	it('reflects current on aria-selected, so the state exists in the tree and not only on screen', () => {
		const { card: current } = mount({ current: true });
		const { card: notCurrent } = mount({ current: false });

		expect(current.getAttribute('aria-selected')).toBe('true');
		expect(notCurrent.getAttribute('aria-selected')).toBe('false');
	});
});

describe('DateReadingCard.svelte: the accessible name announces converted values only', () => {
	it('composes order and the three PRETTY values, never the raw ones', () => {
		const { card } = mount({});

		const label = card.getAttribute('aria-label') ?? '';
		// U+202F (narrow no-break space) before the colon, not an ASCII space: French typography,
		// the same character the catalogue already uses in `import_columns_card_aria_examples`.
		expect(label).toBe(
			'Jour puis mois. Trois exemples : 3 avril 2026, 11 avril 2026, 2 avril 2026.'
		);
		// Separates "announces converted values" from "announces everything": the raw side is
		// identical between the two cards and would spend three values distinguishing nothing.
		for (const pair of BASE.pairs) {
			expect(label).not.toContain(pair.raw);
		}
	});

	it('carries no role word, because assistive technology contributes the role', () => {
		const { card } = mount({});

		const label = card.getAttribute('aria-label') ?? '';
		expect(label.toLowerCase()).not.toContain('option');
		expect(label.toLowerCase()).not.toContain('bouton');
		expect(label.toLowerCase()).not.toContain('button');
	});

	it('hides the visual block from the accessibility tree, so the label is not walked twice', () => {
		const { card } = mount({});

		expect(card.querySelector('[aria-hidden="true"]')).not.toBeNull();
	});
});

describe('DateReadingCard.svelte: it is an option in a listbox, not a button', () => {
	it('is never a tab stop, whatever the container decides to focus', () => {
		const { card } = mount({});

		expect(card.getAttribute('role')).toBe('option');
		expect(card.getAttribute('tabindex')).toBe('-1');
		expect(page.getByRole('button').elements().length).toBe(0);
	});

	it('fires onSelect on click', () => {
		const onSelect = vi.fn();
		const { card } = mount({ onSelect });

		card.click();
		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});

describe('DateReadingCard.svelte: hover exists only at lg, matching AccountRow', () => {
	it('carries lg:hover:bg-zinc-50 as its own class token and no bare hover token below lg', () => {
		// Split on whitespace rather than `.toContain('hover:bg-zinc-50')`, which would be satisfied
		// by the substring inside `lg:hover:bg-zinc-50` itself and could never fail.
		const { card } = mount({});

		const tokens = card.className.split(/\s+/);
		expect(tokens).toContain('lg:hover:bg-zinc-50');
		expect(tokens).not.toContain('hover:bg-zinc-50');
	});
});
