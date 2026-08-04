import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import PeriodFilter from './PeriodFilter.svelte';
import RangeCalendar from './RangeCalendar.svelte';
import { RANGE_CALENDAR_STROKES } from '$lib/domain/rangeCalendar';

/**
 * The calendar's GEOMETRY, measured in a real browser against the real stylesheet.
 *
 * Measured rather than asserted over class strings, deliberately. Every figure here is the output
 * of the Tailwind pipeline plus the cascade plus the box model, and a class-string test proves only
 * that a string was written — it cannot see a `min-height` floor being lifted by a border, which is
 * exactly the 44-vs-46 discrepancy this chantier turned up on the trigger group.
 *
 * CALIBRATION FIRST. Every `describe` here opens by measuring something whose answer was already
 * known before this file existed. A harness whose output cannot be checked by eye must first
 * reproduce a value that can — the alternative is a systematically wrong table that stays plausible,
 * which this repo has already shipped once (a probe that inherited 16px instead of 14px and made
 * every width ~14% too wide, and a space character that measured 0 under `white-space: nowrap`).
 */

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dimensionLabel: 'Période',
		from: '',
		to: '',
		invalid: false,
		locale: 'fr',
		todayIso: '2026-06-17',
		allowCustomRung: true,
		clearAriaLabel: 'Retirer le filtre par Période',
		onApply: vi.fn(),
		onClear: vi.fn(),
		...overrides
	};
}

async function openPanel(surface: 'desktop' | 'mobile') {
	if (surface === 'mobile') await page.viewport(390, 844);
	else await page.viewport(1280, 900);
	const screen = render(
		PeriodFilter,
		base(surface === 'mobile' ? { surface: 'mobile', allowCustomRung: false } : {})
	);
	await screen.getByRole('button', { name: 'Période', exact: true }).click();
	return screen;
}

function firstDayCell(): HTMLElement {
	// The Day element is the sized box, not its <td> wrapper.
	const cell = document.querySelector('[data-bits-day]');
	if (!cell) throw new Error('no calendar day rendered');
	return cell as HTMLElement;
}

function box(el: Element) {
	const r = el.getBoundingClientRect();
	return { w: Math.round(r.width), h: Math.round(r.height) };
}

describe('the mouse grid at 1280', () => {
	it('CALIBRATION — reproduces the trigger group height this file did not set', async () => {
		// 34px is the referential's desktop control height, pinned by a spec that predates this
		// chantier. If this line is wrong, no number below can be trusted.
		const screen = render(PeriodFilter, base());
		await page.viewport(1280, 900);
		await expect
			.element(screen.getByRole('button', { name: 'Période', exact: true }))
			.toBeInTheDocument();
		const group = document.querySelector('[data-testid="period-trigger-group"]')!;
		expect(box(group).h).toBe(34);
	});

	it('renders a 30px square cell', async () => {
		await openPanel('desktop');
		expect(box(firstDayCell())).toEqual({ w: 30, h: 30 });
	});

	it('renders the grid at 210px, which is exactly seven cells and no spacing', async () => {
		await openPanel('desktop');
		const row = document.querySelector('[data-bits-day]')!.closest('tr')!;
		expect(box(row).w).toBe(210);
		expect(box(row).w).toBe(7 * box(firstDayCell()).w);
	});

	it('keeps the cells edge to edge, so the band reads as one segment', async () => {
		await openPanel('desktop');
		const days = [...document.querySelectorAll('[data-bits-day]')].slice(0, 7);
		for (let i = 1; i < days.length; i += 1) {
			const previous = days[i - 1].getBoundingClientRect();
			const current = days[i].getBoundingClientRect();
			expect(Math.round(current.left - previous.right)).toBe(RANGE_CALENDAR_STROKES.cellGap);
		}
	});

	it('always renders six rows, whatever the month holds', async () => {
		// The panel's height must not jump from one month to the next. June 2026 spans five calendar
		// weeks; without `fixedWeeks` this grid would be one row shorter than a six-week month.
		await openPanel('desktop');
		const rows = document.querySelectorAll('tbody tr');
		expect(rows.length).toBe(6);
	});

	it('rounds a placed bound at 10px', async () => {
		await openPanel('desktop');
		await page
			.getByRole('gridcell', { name: /\b10\b/ })
			.first()
			.click();
		const bound = document.querySelector('[data-bits-day][data-selection-start]') as HTMLElement;
		expect(getComputedStyle(bound).borderTopLeftRadius).toBe('10px');
	});
});

describe('the touch grid at 390', () => {
	it('CALIBRATION — reproduces the 44px sheet action height asserted elsewhere', async () => {
		await openPanel('mobile');
		const clear = page.getByRole('button', { name: 'Effacer' }).element();
		expect(box(clear).h).toBe(44);
	});

	it('renders a 48px square cell', async () => {
		await openPanel('mobile');
		expect(box(firstDayCell())).toEqual({ w: 48, h: 48 });
	});

	it('renders the grid at 336px, which is exactly seven touch cells', async () => {
		await openPanel('mobile');
		const row = document.querySelector('[data-bits-day]')!.closest('tr')!;
		expect(box(row).w).toBe(336);
		expect(box(row).w).toBe(7 * 48);
	});

	it('rounds a placed bound at 14px, not at cell/3', async () => {
		await openPanel('mobile');
		await page
			.getByRole('gridcell', { name: /\b10\b/ })
			.first()
			.click();
		const bound = document.querySelector('[data-bits-day][data-selection-start]') as HTMLElement;
		// 14, against the 16 that "un tiers de la cellule" would give. The design's figures are
		// normative; its stated rationale is arithmetically wrong at this size.
		expect(getComputedStyle(bound).borderTopLeftRadius).toBe('14px');
		expect(getComputedStyle(bound).borderTopLeftRadius).not.toBe('16px');
	});

	it('keeps the cells edge to edge at the touch size too', async () => {
		await openPanel('mobile');
		const days = [...document.querySelectorAll('[data-bits-day]')].slice(0, 7);
		for (let i = 1; i < days.length; i += 1) {
			expect(
				Math.round(days[i].getBoundingClientRect().left - days[i - 1].getBoundingClientRect().right)
			).toBe(0);
		}
	});
});

describe('what refuses to scale between the two sizes', () => {
	/**
	 * The design's central claim, measured on rendered pixels rather than read off the token table.
	 * `rangeCalendar.spec.ts` asserts the TABLE is right; this asserts the table is what reaches the
	 * screen. Both are needed: a correct table wired to nothing renders a 1px dash as whatever the
	 * cascade felt like.
	 */
	async function measureAt(surface: 'desktop' | 'mobile') {
		await openPanel(surface);
		await page
			.getByRole('gridcell', { name: /\b10\b/ })
			.first()
			.click();
		const bound = document.querySelector('[data-bits-day][data-selection-start]') as HTMLElement;
		const today = document.querySelector('[data-rc-today]') as HTMLElement | null;
		return {
			cell: box(firstDayCell()).w,
			radius: getComputedStyle(bound).borderTopLeftRadius,
			todayUnderline: today ? getComputedStyle(today).borderBottomWidth : null
		};
	}

	it('grows the target and the radius at the mouse size', async () => {
		const mouse = await measureAt('desktop');
		expect(mouse.cell).toBe(30);
		expect(mouse.radius).toBe('10px');
		// The non-scaling half. todayIso is inside the visible month, so this genuinely measures
		// something — a null here would mean the assertion never ran.
		expect(mouse.todayUnderline).toBe(`${RANGE_CALENDAR_STROKES.todayUnderline}px`);
	});

	it('grows the target and the radius at the touch size, leaving the stroke alone', async () => {
		// Split from the case above rather than measured together: two renders in one test put two
		// copies of the component in the container and every locator becomes ambiguous.
		const touch = await measureAt('mobile');
		expect(touch.cell).toBe(48);
		expect(touch.radius).toBe('14px');
		expect(touch.todayUnderline).toBe(`${RANGE_CALENDAR_STROKES.todayUnderline}px`);
	});
});

describe('the semantics that no geometry test could see', () => {
	/**
	 * Every case here corresponds to a defect that shipped green through a suite measuring only
	 * boxes. Each one was invisible for the same reason: the markup READ correctly in the template,
	 * and a third-party primitive overrode it at merge time or the handler was never wired to the
	 * element that needed it. So these assert the RENDERED accessibility tree, not the source.
	 */

	it('leaves the month caption readable — a live region must not be aria-hidden', async () => {
		await openPanel('desktop');
		const caption = document.querySelector('[data-testid="rc-month-caption"]')!;

		expect(caption.getAttribute('aria-live')).toBe('polite');
		// The defect: bits-ui's own Heading sets aria-hidden="true" unconditionally and wins the
		// prop merge, which does not weaken the announcement — it removes the node from the
		// accessibility tree entirely, so no screen reader ever reads it. A live region that is
		// aria-hidden announces NOTHING, and the markup looks perfect.
		expect(caption.getAttribute('aria-hidden')).toBeNull();
		expect(caption.closest('[aria-hidden="true"]')).toBeNull();
	});

	it('names the two bounds, through a description that survives the prop merge', async () => {
		await openPanel('desktop');
		await page
			.getByRole('gridcell', { name: /\b10\b/ })
			.first()
			.click();
		await page
			.getByRole('gridcell', { name: /\b15\b/ })
			.first()
			.click();

		for (const [attr, expected] of [
			['[data-bits-day][data-selection-start]', 'début de la plage'],
			['[data-bits-day][data-selection-end]', 'fin de la plage']
		] as const) {
			const cell = document.querySelector(attr)!;
			const describedBy = cell.getAttribute('aria-describedby');
			expect(describedBy).toBeTruthy();
			// Resolve it, rather than trusting the attribute: an id pointing at nothing reads as
			// nothing, and that failure is invisible in the markup.
			expect(document.getElementById(describedBy!)?.textContent?.trim()).toBe(expected);
		}
	});

	it('closes on Escape pressed from inside the grid, not only from the fields', async () => {
		// The handler used to sit on the trigger and the two inputs only, so a keyboard user who had
		// tabbed into the grid — the component under review — pressed Escape and nothing happened.
		await openPanel('desktop');
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();

		const day = document.querySelector('[data-bits-day]') as HTMLElement;
		day.focus();
		await userEvent.keyboard('{Escape}');

		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('puts the opening focus on the grid, not on the Du field', async () => {
		// Design 6: focus goes to the range start if one exists, else today. Landing in a text input
		// left the calendar undiscoverable for exactly the users the grid was built for.
		await openPanel('desktop');
		await expect
			.poll(() => document.activeElement?.getAttribute('data-bits-day'))
			.not.toBeUndefined();
		expect(document.activeElement?.hasAttribute('data-bits-day')).toBe(true);
	});
});

describe('unavailable days and the min/max bounds — the props Période never passes', () => {
	/**
	 * `isDateUnavailable`, `minIso` and `maxIso` are wired but UNUSED by the only consumer today:
	 * /transactions places no floor on how far back a period may reach. The design does specify the
	 * state ("les jours indisponibles sont barrés... et restent atteignables aux flèches"), and
	 * /reports is expected to adopt this component, so leaving them unexercised would mean shipping
	 * a documented capability nobody has ever seen render.
	 *
	 * Mounts RangeCalendar DIRECTLY rather than through PeriodFilter, because going through the
	 * consumer is exactly what cannot reach these props.
	 */
	const copy = {
		rangeStart: 'début de la plage',
		rangeEnd: 'fin de la plage',
		awaitingEnd: ({ date }: { date: string }) => `Début au ${date}.`,
		rangeSelected: ({ from, to, days }: { from: string; to: string; days: number }) =>
			`Du ${from} au ${to}, ${days} jours.`,
		empty: 'Aucune période choisie.'
	};

	function mountCalendar(props: Record<string, unknown> = {}) {
		return render(RangeCalendar, {
			value: { start: null, end: null },
			onValueChange: vi.fn(),
			size: 'mouse',
			locale: 'fr',
			todayIso: '2026-06-17',
			anchorIso: '2026-06-17',
			copy,
			formatLongDate: (iso: string) => iso,
			formatMonthCaption: (iso: string) => iso.slice(0, 7),
			gridLabel: 'Calendrier',
			previousMonthLabel: 'Mois précédent',
			nextMonthLabel: 'Mois suivant',
			...props
		});
	}

	it('marks an unavailable day aria-disabled and strikes it through, without removing it', async () => {
		await page.viewport(1280, 900);
		mountCalendar({ isDateUnavailable: (iso: string) => iso === '2026-06-11' });

		const cell = document.querySelector('[data-bits-day][data-value="2026-06-11"]') as HTMLElement;
		expect(cell).not.toBeNull();
		expect(cell.getAttribute('aria-disabled')).toBe('true');
		expect(getComputedStyle(cell).textDecorationLine).toContain('line-through');

		// Still rendered and still reachable: skipping it would hide the limit instead of explaining
		// it, and a blank cell would break the grid's shape.
		expect(cell.textContent?.trim()).toBe('11');
		expect(cell.hasAttribute('data-unavailable')).toBe(true);
	});

	it('does not select an unavailable day when it is clicked', async () => {
		await page.viewport(1280, 900);
		const onValueChange = vi.fn();
		mountCalendar({ isDateUnavailable: (iso: string) => iso === '2026-06-11', onValueChange });

		(document.querySelector('[data-bits-day][data-value="2026-06-11"]') as HTMLElement).click();
		expect(onValueChange).not.toHaveBeenCalled();
	});

	it('disables days outside minIso/maxIso while keeping the month rendered', async () => {
		await page.viewport(1280, 900);
		mountCalendar({ minIso: '2026-06-10', maxIso: '2026-06-20' });

		const before = document.querySelector(
			'[data-bits-day][data-value="2026-06-05"]'
		) as HTMLElement;
		const inside = document.querySelector(
			'[data-bits-day][data-value="2026-06-15"]'
		) as HTMLElement;
		const after = document.querySelector('[data-bits-day][data-value="2026-06-25"]') as HTMLElement;

		expect(before.hasAttribute('data-disabled')).toBe(true);
		expect(after.hasAttribute('data-disabled')).toBe(true);
		expect(inside.hasAttribute('data-disabled')).toBe(false);
		// The whole month still renders — the bound narrows what is selectable, not what is shown.
		expect(document.querySelectorAll('tbody tr').length).toBe(6);
	});
});
