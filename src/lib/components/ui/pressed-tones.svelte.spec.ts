import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import Button from '../Button.svelte';
import CheckboxField from './CheckboxField.svelte';
import IconButton from './IconButton.svelte';
import ListCard from './ListCard.svelte';
import PeriodFilter from './PeriodFilter.svelte';
import TapLink from './TapLink.svelte';

/**
 * The tone table of Planche 5a, measured against the real stylesheet in a real browser.
 *
 * ## What each case separates, and why it is not one assertion written nine times
 *
 * `data-pressed` is the STATE and the computed colour is how it PAINTS. Both halves are asserted,
 * because they fail for different reasons: a missing action leaves the attribute off, and a missing
 * token leaves the attribute on with nothing behind it. A class-string assertion would see neither,
 * since a class list cannot show a rule that failed to compile.
 *
 * ## Colours are compared against a PROBE, never against a literal
 *
 * Tailwind 4 emits theme colours as `oklch(...)`, so a hand-written `rgb(...)` matches nothing and
 * a hand-written oklch triple is a number nobody can check by eye. Each case therefore compares the
 * pressed element against a probe carrying the utility THE DESIGN NAMES, written here independently
 * of the token the component composes. The two sides have different sources on purpose: the design
 * says zinc-100, the probe says `bg-zinc-100`, the component says `pressNeutral`. Point `pressNeutral`
 * at zinc-200 and this reddens, which is the whole reason not to read the token back.
 *
 * ## The fixture reads two instants, not a duration
 *
 * Resting, then pressed. The minimum-display floor and the cancel path belong to `$lib/press.ts` and
 * are asserted there on a controlled clock; a duration assertion here would be an assertion about
 * the runner. What is asserted in this file is which ELEMENT answers a press and what colour it
 * takes, which is the half that lives in the components.
 */

function textSnippet(text: string) {
	return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

function pointerDown(el: Element) {
	el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
}

let probe: HTMLElement | null = null;

/**
 * The computed colour of the utility the DESIGN names, read off a throwaway element.
 *
 * `property` is either `backgroundColor` or `color`, and the probe carries the matching utility so
 * the same pipeline that paints the component paints the reference. What it is NOT is a read of the
 * component's own token: that would be a comparison whose two sides share a source, which reads as
 * a check and is an identity.
 */
function designColour(utility: string, property: 'backgroundColor' | 'color'): string {
	probe?.remove();
	const el = document.createElement('div');
	el.className = utility;
	document.body.appendChild(el);
	probe = el;
	return getComputedStyle(el)[property];
}

afterEach(() => {
	probe?.remove();
	probe = null;
	vi.useRealTimers();
});

describe('the pressed state paints, tone by tone', () => {
	// CALIBRATION, and it runs first for a reason. Before any tone is believed, one control proves
	// the harness can tell a resting element from a pressed one. Without it, nine green cases could
	// all be reading the same transparent background and agreeing about nothing.
	//
	// The calibration is a POSITIVE and a NEGATIVE in one: `designColour` must return two different
	// answers for two different utilities, and TapLink's background must not move under a press,
	// since brique 4 forbids it a surface.
	it('the probe distinguishes two tints, and a stroke-only tone moves no surface', async () => {
		expect(designColour('bg-zinc-100', 'backgroundColor')).not.toBe(
			designColour('bg-zinc-200', 'backgroundColor')
		);

		const screen = render(TapLink, { children: textSnippet('Calibration') });
		const el = await screen.getByRole('button').element();
		const resting = getComputedStyle(el).backgroundColor;

		pointerDown(el);
		expect(getComputedStyle(el).backgroundColor).toBe(resting);
	});

	// zinc-100 fill, zinc-900 glyph. Brique 1's own hover pair, moved onto the press: nothing to
	// revalidate.
	it('IconButton neutral presses to zinc-100', async () => {
		const screen = render(IconButton, { label: 'Modifier', children: textSnippet('x') });
		const el = await screen.getByRole('button', { name: 'Modifier' }).element();
		expect(getComputedStyle(el).backgroundColor).toBe('rgba(0, 0, 0, 0)');

		pointerDown(el);
		expect((el as HTMLElement).dataset.pressed).toBe('');
		expect(getComputedStyle(el).backgroundColor).toBe(
			designColour('bg-zinc-100', 'backgroundColor')
		);
	});

	// rose-50 / rose-700 = 5.4:1, already measured by brique 1 for its hover state.
	it('IconButton danger presses to the brick-1 rose pair', async () => {
		const screen = render(IconButton, {
			tone: 'danger',
			label: 'Supprimer',
			children: textSnippet('x')
		});
		const el = await screen.getByRole('button', { name: 'Supprimer' }).element();

		pointerDown(el);
		expect(getComputedStyle(el).backgroundColor).toBe(
			designColour('bg-rose-50', 'backgroundColor')
		);
		expect(getComputedStyle(el).color).toBe(designColour('text-rose-700', 'color'));
	});

	// A fill cannot lighten without changing tone, so it presses by sinking. White on pure black is
	// 21:1, and the inset shadow survives prefers-reduced-motion where a transform would not.
	it('a filled neutral button presses to pure black with an inset', async () => {
		const screen = render(Button, { children: textSnippet('Importer') });
		const el = await screen.getByRole('button', { name: 'Importer' }).element();
		const resting = getComputedStyle(el).backgroundColor;

		pointerDown(el);
		expect(getComputedStyle(el).backgroundColor).toBe('rgb(0, 0, 0)');
		expect(getComputedStyle(el).backgroundColor).not.toBe(resting);
		expect(getComputedStyle(el).boxShadow).toContain('inset');
	});

	// THE ONLY NEW TINT OF THE PLATE: rose-800 #9f1239. White on it is 7.6:1. An arbitrary hex, so
	// it computes to rgb and the literal is checkable by eye against the plate.
	it('a filled rose button presses to rose-800', async () => {
		const screen = render(Button, { variant: 'danger', children: textSnippet('Supprimer') });
		const el = await screen.getByRole('button', { name: 'Supprimer' }).element();
		const resting = getComputedStyle(el).backgroundColor;

		pointerDown(el);
		expect(getComputedStyle(el).backgroundColor).toBe('rgb(159, 18, 57)');
		expect(getComputedStyle(el).backgroundColor).not.toBe(resting);
	});

	// Brique 4 forbids a fill and a border, so the press cannot be a surface. It is the underline
	// the brick removed from the resting state, handed back where it is transient. A stroke.
	it('TapLink presses to an underline and never to a surface', async () => {
		const screen = render(TapLink, { children: textSnippet('Modifier les colonnes') });
		const el = await screen.getByRole('button').element();
		expect(getComputedStyle(el).textDecorationLine).toBe('none');

		pointerDown(el);
		expect(getComputedStyle(el).textDecorationLine).toBe('underline');
		expect(getComputedStyle(el).backgroundColor).toBe('rgba(0, 0, 0, 0)');
	});

	// The same stroke in rose-800, so the darkening is perceptible against a rose-700 rest.
	it('TapLink danger darkens to rose-800 under the same stroke', async () => {
		const screen = render(TapLink, {
			tone: 'danger',
			children: textSnippet('Supprimer cet import')
		});
		const el = await screen.getByRole('button').element();
		expect(getComputedStyle(el).color).toBe(designColour('text-rose-700', 'color'));

		pointerDown(el);
		expect(getComputedStyle(el).textDecorationLine).toBe('underline');
		expect(getComputedStyle(el).color).toBe('rgb(159, 18, 57)');
	});

	// Full width, zinc-100. zinc-50 was tried and set aside: at 2% difference it is not perceptible
	// in daylight on a phone screen.
	it('a ListCard row presses full width in zinc-100', async () => {
		const screen = render(ListCard, { href: '/imports', children: textSnippet('Une ligne') });
		const el = await screen.getByRole('link').element();

		pointerDown(el);
		expect((el as HTMLElement).dataset.pressed).toBe('');
		expect(getComputedStyle(el).backgroundColor).toBe(
			designColour('bg-zinc-100', 'backgroundColor')
		);
	});

	// THE ROW PRESSES, NOT THE BOX. The target is the whole row; sinking a 22 px box would flash an
	// object smaller than the finger touching it.
	it('a checkbox row presses as a row, and the box itself does not', async () => {
		const screen = render(CheckboxField, {
			name: 'deleteOldImport',
			label: "Supprimer l'ancien import",
			checked: true
		});
		const box = await screen.getByRole('checkbox').element();
		const row = box.closest('label') as HTMLElement;

		pointerDown(row);
		expect(row.dataset.pressed).toBe('');
		expect((box as HTMLElement).dataset.pressed).toBeUndefined();
		expect(getComputedStyle(row).backgroundColor).toBe(
			designColour('bg-zinc-100', 'backgroundColor')
		);
	});

	// The one tone where zinc-100 is already taken, by "in range". The press drops one step to
	// zinc-200 so it stays distinct from the eleven states the V2 additions already registered.
	//
	// Reached through `PeriodFilter` rather than by rendering the calendar directly: its days are
	// rendered by bits-ui and its props are a dozen formatters, so the panel is how the application
	// itself produces this control. That is also the route-produces-it check, paid here rather than
	// deferred.
	it('a calendar cell presses to zinc-200, one step below the band', async () => {
		await page.viewport(1280, 900);
		render(PeriodFilter, {
			dimensionLabel: 'Période',
			from: '',
			to: '',
			invalid: false,
			locale: 'fr',
			todayIso: '2026-06-17',
			allowCustomRung: true,
			clearAriaLabel: 'Retirer le filtre par Période',
			onApply: vi.fn(),
			onClear: vi.fn()
		});
		await page.getByRole('button', { name: 'Période', exact: true }).click();
		const cell = document.querySelector('[data-bits-day]') as HTMLElement;
		expect(cell).not.toBeNull();

		const resting = getComputedStyle(cell).backgroundColor;

		pointerDown(cell);
		expect(cell.dataset.pressed).toBe('');
		// A LITERAL HERE, and it is the one case where the probe would compare two notations for one
		// colour. `RangeCalendar`'s eleven states are a stylesheet of literal hex values by a recorded
		// decision of that component ("a token indirection is one more place for the palette to drift
		// out from under a contrast claim"), so the cell computes to rgb while a `bg-zinc-200` probe
		// computes to oklch. #e4e4e7 IS zinc-200, and written out it is checkable by eye against the
		// plate.
		expect(getComputedStyle(cell).backgroundColor).toBe('rgb(228, 228, 231)');
		expect(getComputedStyle(cell).backgroundColor).not.toBe(resting);
		// THE DISCRIMINATING ASSERTION of this case: distinct from « dans la plage », which is the
		// state that already owns zinc-100 and the whole reason the press descends a step.
		expect(getComputedStyle(cell).backgroundColor).not.toBe('rgb(244, 244, 245)');
	});
});
