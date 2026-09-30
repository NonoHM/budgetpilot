import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import DateReadingCard from './DateReadingCard.svelte';
import * as m from '$lib/paraglide/messages';

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

/**
 * THE VIEWPORT IS SET, NOT INHERITED (#709). A container width moves the card and never a media
 * query, so an `lg:` class applies only when the VIEWPORT is at `lg`. `page.viewport` also persists
 * from one test to the next in this file, so a mount that set nothing would measure whichever width
 * the previous test left behind. Every mount here is the 390 phone, holding a 350 px card.
 */
async function mount(props: Record<string, unknown>) {
	await page.viewport(390, 844);
	expect(window.innerWidth).toBe(390);
	const { container } = await render(DateReadingCard, { ...BASE, ...props });
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
	it('is 107 px at 350 px width, with three ordinary pairs', async () => {
		// Separates "the geometry holds for a real render" from "the height is a CSS default".
		const { card } = await mount({});

		expect(card.getBoundingClientRect().height).toBe(107);
		expect(card.getBoundingClientRect().width).toBe(350);
	});

	it('stays 107 px on a short column with two pairs, because the third line is reserved (#669)', async () => {
		// Separates "a short column reserves its missing line" from "the card shrinks by one line
		// box", which is 88 px and moves the second card under a finger already on the glass.
		const { card } = await mount({ pairs: BASE.pairs.slice(0, 2) });

		expect(card.getBoundingClientRect().height).toBe(107);
	});

	it('stays 107 px when the card is the current reading and shows the marker', async () => {
		// Separates "the marker line is the same fixed 20px header row" from "the marker adds a row".
		const { card } = await mount({ current: true });

		expect(card.getBoundingClientRect().height).toBe(107);
	});

	it('stays 107 px when a converted value is far too long to fit, because the line truncates', async () => {
		// Separates "the line is a fixed box that clips" from "a long value grows the card".
		const { card } = await mount({
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

	it('is 107 px at 1280 px width too, because the card does not scale with the viewport', async () => {
		// Separates "the card is evidence, fixed at both widths" from "the card is a row, which
		// scales" (86 -> 74, 68 -> 56 elsewhere on this screen per the plate).
		//
		// #709: this used to widen the CONTAINER and set no viewport, so no `lg:` class could apply
		// and the test measured the phone twice. Break-checked on 2026-09-24, one clause each:
		// `lg:py-2` on the card (a card that scales at `lg`) was green before and is red here, 99 px,
		// with the 390 tests above green; `max-lg:py-2` (a card that changes below `lg` only) reddened
		// this test too before the fix, because it ran below `lg`, and now reddens the 390 tests and
		// leaves this one green.
		await page.viewport(1280, 800);
		expect(window.innerWidth).toBe(1280);
		const { container } = await render(DateReadingCard, BASE);
		container.style.width = '1280px';
		const card = container.querySelector('[role="option"]') as HTMLElement;

		expect(card.getBoundingClientRect().height).toBe(107);
	});
});

describe('DateReadingCard.svelte: the title names the reading', () => {
	it('titles the day-first card', async () => {
		const { card } = await mount({ order: 'day-first' });

		expect(card.textContent).toContain('Jour puis mois');
	});

	it('titles the month-first card', async () => {
		const { card } = await mount({ order: 'month-first' });

		expect(card.textContent).toContain('Mois puis jour');
	});
});

describe('DateReadingCard.svelte: the three lines, raw then pretty', () => {
	it('renders each pair as raw, an arrow, then the converted value, in that order', async () => {
		const { card } = await mount({});

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

	it('applies tabular-nums to the raw side only, never to the converted prose', async () => {
		// Separates "digits align down the column" (raw) from "tabular figures inside prose read as
		// a table that is not there" (pretty). Both spans are read, not just one, per the
		// fixture-blindness rule: a probe that only checked the raw side would pass a component that
		// also (wrongly) put tabular-nums on the pretty side.
		const { card } = await mount({});

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

	it('truncates a long line rather than wrapping it, asserted where the height cannot see it', async () => {
		// Same reasoning as ColumnCard's identical test: a fixed 17px line box with overflow-hidden
		// CLIPS a wrapped second line instead of growing, so the height assertion above cannot tell
		// truncation from wrapping-then-clipping. scrollWidth vs clientWidth can.
		const { card } = await mount({
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
	it('shows the retained-reading marker only when current', async () => {
		const { card: current } = await mount({ current: true });
		const { card: notCurrent } = await mount({ current: false });

		expect(current.textContent).toContain('Lecture retenue');
		expect(notCurrent.textContent).not.toContain('Lecture retenue');
	});

	it('reflects current on aria-selected, so the state exists in the tree and not only on screen', async () => {
		const { card: current } = await mount({ current: true });
		const { card: notCurrent } = await mount({ current: false });

		expect(current.getAttribute('aria-selected')).toBe('true');
		expect(notCurrent.getAttribute('aria-selected')).toBe('false');
	});
});

describe('DateReadingCard.svelte: the accessible name announces converted values only', () => {
	it('composes order and the PRETTY values, never the raw ones', async () => {
		const { card } = await mount({});

		const label = card.getAttribute('aria-label') ?? '';
		// U+202F (narrow no-break space) before the colon, not an ASCII space: French typography,
		// the same character the catalogue already uses in `import_columns_card_aria_examples`.
		expect(label).toBe('Jour puis mois. Exemples : 3 avril 2026, 11 avril 2026, 2 avril 2026.');
		// Separates "announces converted values" from "announces everything": the raw side is
		// identical between the two cards and would spend three values distinguishing nothing.
		for (const pair of BASE.pairs) {
			expect(label).not.toContain(pair.raw);
		}
	});

	it('carries no role word, because assistive technology contributes the role', async () => {
		const { card } = await mount({});

		const label = card.getAttribute('aria-label') ?? '';
		expect(label.toLowerCase()).not.toContain('option');
		expect(label.toLowerCase()).not.toContain('bouton');
		expect(label.toLowerCase()).not.toContain('button');
	});

	it('hides the visual block from the accessibility tree, so the label is not walked twice', async () => {
		const { card } = await mount({});

		expect(card.querySelector('[aria-hidden="true"]')).not.toBeNull();
	});
});

/**
 * #705. A REAL cell (not padding, which #669 removed upstream) that does not convert under this
 * reading reaches the card as `pretty: ''`, the producers' contract for "not a date read this way".
 * The card used to print that empty string on both surfaces: a bare arrow on screen, and an empty
 * slot in the spoken list, « Mois puis jour. Exemples : 1 décembre 2026, , 1 février 2026. ».
 *
 * `13/01/2026` is the cell: a date day first, no month 13 month first. The SENTENCE is compared
 * whole, never a fragment, because every `toContain` still finds both real dates in the name that
 * carries the gap.
 *
 * Padding coming back is NOT this block's to catch: it is dropped upstream, and the two #669 tests
 * in `ColumnPicker.svelte.spec.ts` redden when that filter is removed (break-checked 2026-09-24).
 * Since #705 it would read « pas une date » here rather than a gap, a false verdict on a cell the
 * file does not contain, so that filter matters more now, not less.
 */
describe('#705: a real cell that is not a date under this reading is named, never an empty slot', () => {
	const MONTH_FIRST_WITH_A_NON_DATE = {
		order: 'month-first' as const,
		pairs: [
			{ raw: '12/01/2026', pretty: '1 décembre 2026' },
			{ raw: '13/01/2026', pretty: '' },
			{ raw: '02/01/2026', pretty: '1 février 2026' }
		]
	};

	function drawnLines(card: HTMLElement) {
		return [...card.querySelectorAll('[data-testid="date-reading-card-lines"] > span')]
			.map((line) => (line.textContent ?? '').replace(/\s+/g, ' ').trim())
			.filter((text) => text !== '');
	}

	it('separates a named slot from an empty one: the whole spoken sentence', async () => {
		// Break: speak `pair.pretty` raw again in the name. Red, the empty slot comes back.
		const { card } = await mount(MONTH_FIRST_WITH_A_NON_DATE);

		expect(card.getAttribute('aria-label')).toBe(
			'Mois puis jour. Exemples : 1 décembre 2026, pas une date, 1 février 2026.'
		);
	});

	it('separates a named line from a bare arrow: every drawn line, whole', async () => {
		// Break: draw `pair.pretty` raw again in the line. Red, « 13/01/2026 → » comes back.
		const { card } = await mount(MONTH_FIRST_WITH_A_NON_DATE);

		expect(drawnLines(card)).toEqual([
			'12/01/2026 → 1 décembre 2026',
			'13/01/2026 → pas une date',
			'02/01/2026 → 1 février 2026'
		]);
	});

	it('separates a name that says what the card shows from one that disagrees with it', async () => {
		// The name is rebuilt from what the EYE reads after each arrow, through the production
		// message, so the two surfaces are compared with each other rather than each with a literal.
		// Break-checked 2026-09-24: another word for the gap in the name only, red here and in the
		// whole-sentence test; the line drawn from `pair.pretty` again, red here and in the line
		// test. Never red alone while both literals stand: what it adds is that it survives a
		// catalogue rewording, which reddens both literals and leaves this one meaningful.
		const { card } = await mount(MONTH_FIRST_WITH_A_NON_DATE);

		const afterArrow = drawnLines(card).map((line) => line.slice(line.indexOf('→') + 1).trim());
		expect(card.getAttribute('aria-label')).toBe(
			m.import_datesheet_option_aria({
				order: m.import_datesheet_option_month_first(),
				examples: afterArrow.join(', ')
			})
		);
	});

	function spansOf(card: HTMLElement) {
		const spans = [...card.querySelectorAll('span')];
		const find = (text: string) => {
			const found = spans.find((el) => el.textContent?.trim() === text);
			expect(found, text).toBeDefined();
			return getComputedStyle(found!);
		};
		return {
			verdict: find('pas une date'),
			date: find('1 décembre 2026'),
			raw: find('13/01/2026')
		};
	}

	it('separates a verdict from a value by colour: the raw side’s grey, not the date’s ink', async () => {
		// Canvas « Carte de lecture, valeur non convertible »: zinc-500, the raw side's grey, 4.8:1
		// on white. Break: give the verdict the date's `text-zinc-900`. Red.
		const { verdict, date, raw } = spansOf((await mount(MONTH_FIRST_WITH_A_NON_DATE)).card);

		expect(verdict.color).toBe(raw.color);
		expect(verdict.color).not.toBe(date.color);
	});

	it('separates a verdict from a value by shape, so colour is not the only means (WCAG 1.4.1)', async () => {
		// Break: drop `italic` from the verdict. Red here alone, and the colour break is red in the
		// colour test alone (break-checked 2026-09-24): two clauses, two tests.
		const { verdict, date } = spansOf((await mount(MONTH_FIRST_WITH_A_NON_DATE)).card);

		expect(verdict.fontStyle).toBe('italic');
		expect(date.fontStyle).toBe('normal');
	});
});

describe('DateReadingCard.svelte: it is an option in a listbox, not a button', () => {
	it('is never a tab stop, whatever the container decides to focus', async () => {
		const { card } = await mount({});

		expect(card.getAttribute('role')).toBe('option');
		expect(card.getAttribute('tabindex')).toBe('-1');
		expect(page.getByRole('button').elements().length).toBe(0);
	});

	it('fires onSelect on click', async () => {
		const onSelect = vi.fn();
		const { card } = await mount({ onSelect });

		card.click();
		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});

describe('DateReadingCard.svelte: hover exists only at lg, matching AccountRow', () => {
	it('carries lg:hover:bg-zinc-50 as its own class token and no bare hover token below lg', async () => {
		// Split on whitespace rather than `.toContain('hover:bg-zinc-50')`, which would be satisfied
		// by the substring inside `lg:hover:bg-zinc-50` itself and could never fail.
		const { card } = await mount({});

		const tokens = card.className.split(/\s+/);
		expect(tokens).toContain('lg:hover:bg-zinc-50');
		expect(tokens).not.toContain('hover:bg-zinc-50');
	});
});
