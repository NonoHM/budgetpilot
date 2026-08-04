import { page, userEvent } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import '../../../routes/layout.css';
import PeriodFilter from './PeriodFilter.svelte';

/**
 * PeriodFilter — the Période dimension of the /transactions filter bar.
 *
 * A sibling of FilterDropdown.svelte, not a mode on it (see the long comment at the top of the
 * component). Rendered in a real browser rather than asserted over class strings: what is under
 * test is measured geometry (the 34px desktop / 46px mobile trigger group, the 24px/44px targets)
 * and the accessible names a reader actually gets, both of which are computed properties of live
 * nodes.
 */

type Props = Record<string, unknown>;

const footerSnippet = createRawSnippet(() => ({
	render: () => '<a data-testid="footer-probe" href="/settings#tags">Gérer dans Paramètres</a>'
}));

function base(overrides: Props = {}): Props {
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

describe('PeriodFilter — the trigger grammar', () => {
	it('at rest the trigger reads only the dimension name, and there is no clear button', async () => {
		expect.assertions(2);
		render(PeriodFilter, base());

		await expect.element(page.getByRole('button', { name: 'Période' })).toBeInTheDocument();
		expect(page.getByRole('button', { name: /Retirer le filtre/ }).elements().length).toBe(0);
	});

	it('active renders "Période", ":" and the value, as two adjoined buttons', async () => {
		expect.assertions(4);
		render(PeriodFilter, base({ from: '2026-03-03', to: '2026-06-12' }));

		const group = page.getByTestId('period-trigger-group').element() as HTMLElement;
		const buttons = group.querySelectorAll('button');
		// Two buttons, never one nested inside the other: nested buttons are invalid HTML, and the
		// design requires two independent targets of at least 24px.
		expect(buttons).toHaveLength(2);
		for (const button of buttons) {
			expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
		}
		expect(group.textContent).toContain('Période');
	});

	it('the trigger group is 34px tall on desktop and neither button falls under 24px', async () => {
		expect.assertions(3);
		render(PeriodFilter, base({ from: '2026-03-03', to: '2026-06-12' }));

		const group = page.getByTestId('period-trigger-group').element() as HTMLElement;
		const buttons = [...group.querySelectorAll('button')];

		// MEASURED, not read off a class list — CLAUDE.md records this exact family of mistake twice.
		expect(Math.round(group.getBoundingClientRect().height)).toBe(34);
		for (const button of buttons) {
			expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
		}
	});

	it('on mobile each button is a full 44px target, matching the other filter-bar triggers (design 6I)', async () => {
		expect.assertions(3);
		render(PeriodFilter, base({ from: '2026-03-03', to: '2026-06-12', surface: 'mobile' }));

		const group = page.getByTestId('period-trigger-group').element() as HTMLElement;
		const buttons = [...group.querySelectorAll('button')];

		// Design section 6I: the TAP TARGET is 44px visually, not merely reachable via the previous
		// `min-h-[44px] -my-1` transparent-overflow trick. `min-h-11` on both the group and each
		// button is the exact pattern +page.svelte's Catégorie/Étiquette groups already use, and it
		// measures 46px on the group: `min-height` applies to the border-box (Tailwind's global
		// `border-box` preflight), so a group whose child floors at 44px must itself reach
		// 44px(child) + 2px(its own 1px top/bottom border) = 46px to contain it — its own `min-h-11`
		// is a FLOOR the browser then exceeds, not a cap. The button carries no border of its own, so
		// its 44px floor is exact. Asserting 46 on the group pins that shape rather than fighting it.
		expect(Math.round(group.getBoundingClientRect().height)).toBe(46);
		for (const button of buttons) {
			expect(Math.round(button.getBoundingClientRect().height)).toBe(44);
		}
	});

	it('caps the value slot at 190px WITHOUT an ellipsis', async () => {
		expect.assertions(3);
		render(PeriodFilter, base({ from: '2026-03-03', to: '2026-06-12' }));

		const value = page.getByTestId('period-value').element() as HTMLElement;
		expect(value.className).toContain('max-w-[190px]');
		// Période is exempt from the bar's ellipsis convention: a truncated range is a DIFFERENT
		// period, and nothing on screen says which one is real. If this ever goes green with
		// `truncate` present, the ladder in periodLabel.ts has been silently bypassed.
		expect(value.className).not.toContain('truncate');
		expect(value.className).toContain('tabular-nums');
	});

	it('always carries the unabridged form in the accessible name, whichever rung renders', async () => {
		expect.assertions(1);
		render(PeriodFilter, base({ from: '2026-09-30', to: '2027-02-28' }));

		await expect
			.element(page.getByRole('button', { name: /30 septembre 2026 → 28 février 2027/ }))
			.toBeInTheDocument();
	});

	it('marks a shortened value with a Tooltip and a dotted underline, never a title attribute', async () => {
		expect.assertions(4);
		// This range's `full` form ("30 septembre 2026 → 28 février 2027") does not fit the 190px cap
		// under the measured character table, so the ladder shortens it and `shortened` is true.
		render(PeriodFilter, base({ from: '2026-09-30', to: '2027-02-28' }));

		const value = page.getByTestId('period-value').element() as HTMLElement;
		expect(value.className).toContain('decoration-dotted');
		// `title` fires on mouse hover only, leaving a sighted keyboard user with no way to read the
		// unabridged form — the Tooltip component is the only accessible carrier for it.
		expect(value.getAttribute('title')).toBeNull();
		const tooltipWrapper = value.closest('[aria-describedby]');
		expect(tooltipWrapper).not.toBeNull();

		// The previous version of this test stopped at "a describedby wrapper exists somewhere as an
		// ancestor" and passed against a Tooltip nested INSIDE the trigger button — a wrapper that can
		// never see the button being focused, since `focusin` only bubbles UP from the focused element
		// to its ancestors. That arrangement degrades to hover-only, i.e. functionally a `title`
		// attribute by another name, which is exactly what this test's own name forbids. The assertion
		// that actually rules that out is this one: dispatch focus on the trigger BUTTON itself and
		// check the tooltip becomes reachable.
		const trigger = page
			.getByRole('button', { name: /Période/ })
			.first()
			.element() as HTMLElement;
		trigger.focus();
		await expect.element(page.getByRole('tooltip')).toBeInTheDocument();
	});
});

describe('PeriodFilter — the invalid state', () => {
	it('stays neutral (no rose, no amber) and writes the word, not just the glyph', async () => {
		expect.assertions(4);
		render(PeriodFilter, base({ from: 'nonsense', to: '2026-06-12', invalid: true }));

		const group = page.getByTestId('period-trigger-group').element() as HTMLElement;
		expect(group.className).toContain('border-zinc-900');
		expect(group.className).not.toMatch(/rose|amber/);
		await expect.element(page.getByText('invalide', { exact: false })).toBeInTheDocument();

		const open = group.querySelector('button') as HTMLElement;
		expect(open.getAttribute('aria-invalid')).toBe('true');
	});

	it('points aria-describedby at the panel message it names', async () => {
		expect.assertions(2);
		render(PeriodFilter, base({ from: 'nonsense', to: '2026-06-12', invalid: true }));

		const open = page.getByTestId('period-trigger-group').element().querySelector('button');
		const describedBy = open?.getAttribute('aria-describedby');
		expect(describedBy).toBeTruthy();

		await userEvent.click(page.getByRole('button', { name: /Période/ }).first());
		const message = document.getElementById(describedBy as string);
		expect(message?.textContent).toContain(
			'Les résultats affichés sont ceux de la dernière période valide'
		);
	});
});

describe('PeriodFilter — the panel', () => {
	it('offers the presets and two labelled, genuinely focusable date inputs', async () => {
		expect.assertions(3);
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await expect.element(page.getByRole('button', { name: 'Ce mois-ci' })).toBeInTheDocument();

		const fromInput = page.getByLabelText('Du').element() as HTMLInputElement;
		expect(fromInput.tagName).toBe('INPUT');
		fromInput.focus();
		expect(document.activeElement).toBe(fromInput);
	});

	it('never renders a native date input — the defect this dimension closes', async () => {
		expect.assertions(1);
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		expect(document.querySelectorAll('input[type="date"]')).toHaveLength(0);
	});

	it('the from/to inputs are type=text with inputmode=numeric', async () => {
		expect.assertions(4);
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		const fromInput = page.getByLabelText('Du').element() as HTMLInputElement;
		const toInput = page.getByLabelText('Au').element() as HTMLInputElement;
		expect(fromInput.getAttribute('type')).toBe('text');
		expect(fromInput.getAttribute('inputmode')).toBe('numeric');
		expect(toInput.getAttribute('type')).toBe('text');
		expect(toInput.getAttribute('inputmode')).toBe('numeric');
	});

	it('clicking a preset ARMS it — fills the fields and marks it pressed — without applying or closing (design 6E)', async () => {
		expect.assertions(4);
		// Three writers (presets, grid, fields) share one truth, and "Appliquer" is the single
		// validation point for all three: a preset brushed by accident must not fire a request that
		// then has to be undone by touching something else.
		const onApply = vi.fn();
		render(PeriodFilter, base({ onApply }));

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await userEvent.click(page.getByRole('button', { name: 'Ce mois-ci' }));

		expect(onApply).not.toHaveBeenCalled();
		expect(page.getByRole('dialog').elements().length).toBe(1);
		const fromInput = page.getByLabelText('Du').element() as HTMLInputElement;
		const toInput = page.getByLabelText('Au').element() as HTMLInputElement;
		expect(fromInput.value).toBe('01/06/2026');
		expect(toInput.value).toBe('30/06/2026');
	});

	it('applies a preset as a from/to pair, never a third param, only once Appliquer is pressed', async () => {
		expect.assertions(1);
		const onApply = vi.fn();
		render(PeriodFilter, base({ onApply }));

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await userEvent.click(page.getByRole('button', { name: 'Ce mois-ci' }));
		await userEvent.click(page.getByRole('button', { name: 'Appliquer' }));

		expect(onApply).toHaveBeenCalledWith({ from: '2026-06-01', to: '2026-06-30' });
	});

	it('arming a preset moves the calendar to the range it means, even across a month boundary', async () => {
		expect.assertions(1);
		// todayIso is in June; "Le mois dernier" means May, so this is only proof of movement if the
		// caption actually crosses a month — arming "Ce mois-ci" from a June open would be a no-op
		// test that passed whether or not the anchor moved at all. Read from the month caption node
		// specifically (`[data-testid="rc-month-caption"]`): the status region ALSO renders "mai" once the
		// range is a full month, so a plain text query for "mai 2026" matches both and is ambiguous.
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await userEvent.click(page.getByRole('button', { name: 'Le mois dernier' }));

		// Not bits-ui's own heading element any more: it ships aria-hidden="true", which made the
		// live region unreadable, so the caption is now a plain node this component owns.
		const caption = document.querySelector('[data-testid="rc-month-caption"]');
		expect(caption?.textContent).toBe('mai 2026');
	});

	it('renders exactly six presets, in the design’s two-column reading order', async () => {
		expect.assertions(2);
		// Six is a LAYOUT constraint (three 30px rows + two 6px gaps in two columns), not a taste —
		// see periodPresets.ts. `last3Months` was displaced, not supplemented, so its absence is part
		// of the same claim as the count.
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		const group = page.getByRole('group', { name: 'Raccourcis' }).element() as HTMLElement;
		const buttons = [...group.querySelectorAll('button')];

		expect(buttons).toHaveLength(6);
		expect(buttons.map((b) => b.textContent?.trim())).toEqual([
			'Ce mois-ci',
			'Le mois dernier',
			'30 derniers jours',
			'Ce trimestre',
			'Cette année',
			'12 derniers mois'
		]);
	});

	it('a preset goes dark the instant a calendar day is clicked, even though the draft still equals its range', async () => {
		expect.assertions(2);
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await userEvent.click(page.getByRole('button', { name: 'Ce mois-ci' }));
		const presetButton = page.getByRole('button', { name: 'Ce mois-ci' }).element();
		expect(presetButton.getAttribute('aria-pressed')).toBe('true');

		// The clicked day (10 June) is still inside "Ce mois-ci"'s range — arming cannot be derived
		// from equality, it has to go dark on the WRITE itself, before the range is even complete.
		await userEvent.click(page.getByRole('button', { name: 'mercredi 10 juin 2026' }));

		expect(presetButton.getAttribute('aria-pressed')).toBe('false');
	});

	it('a preset goes dark the instant a field is typed in', async () => {
		expect.assertions(1);
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await userEvent.click(page.getByRole('button', { name: 'Ce mois-ci' }));
		const presetButton = page.getByRole('button', { name: 'Ce mois-ci' }).element();

		await userEvent.fill(page.getByLabelText('Du'), '02/06/2026');

		expect(presetButton.getAttribute('aria-pressed')).toBe('false');
	});

	it('the "Toutes les périodes" return row clears the filter', async () => {
		expect.assertions(1);
		const onClear = vi.fn();
		render(PeriodFilter, base({ from: '2026-03-03', to: '2026-06-12', onClear }));

		await userEvent.click(page.getByRole('button', { name: /Période/ }).first());
		await userEvent.click(page.getByRole('button', { name: 'Toutes les périodes' }));

		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it('the Appliquer button applies the typed dates', async () => {
		expect.assertions(1);
		const onApply = vi.fn();
		render(PeriodFilter, base({ onApply }));

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await userEvent.fill(page.getByLabelText('Du'), '03/03/2026');
		await userEvent.fill(page.getByLabelText('Au'), '12/06/2026');
		await userEvent.click(page.getByRole('button', { name: 'Appliquer' }));

		expect(onApply).toHaveBeenCalledWith({ from: '2026-03-03', to: '2026-06-12' });
	});

	it('the footer has two adjoined buttons, Appliquer and Effacer, not one full-width Appliquer', async () => {
		expect.assertions(3);
		const onApply = vi.fn();
		const onClear = vi.fn();
		render(PeriodFilter, base({ from: '2026-03-03', to: '2026-06-12', onApply, onClear }));

		await userEvent.click(page.getByRole('button', { name: /Période/ }).first());
		await expect.element(page.getByRole('button', { name: 'Appliquer' })).toBeInTheDocument();
		await userEvent.click(page.getByRole('button', { name: 'Effacer' }));

		// "Effacer" clears exactly like the "Toutes les périodes" row — a second way to reach the
		// same onClear, not a third dimension of behaviour.
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onApply).not.toHaveBeenCalled();
	});

	it('Appliquer is aria-disabled (never native disabled) until BOTH bounds are placed, and a click on it does nothing', async () => {
		expect.assertions(5);
		const onApply = vi.fn();
		render(PeriodFilter, base({ onApply }));

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		const applyButton = page
			.getByRole('button', { name: 'Appliquer' })
			.element() as HTMLButtonElement;

		// `aria-disabled`, not the native attribute: a native `disabled` button leaves the tab
		// sequence, taking its own explanation out of reach of the keyboard user who needs it most.
		expect(applyButton.getAttribute('aria-disabled')).toBe('true');
		expect(applyButton.disabled).toBe(false);

		const describedBy = applyButton.getAttribute('aria-describedby');
		expect(describedBy).toBeTruthy();
		const hint = document.getElementById(describedBy as string);
		expect(hint?.textContent).toContain('date de début et une date de fin');

		// `force: true`, deliberately: Playwright's own actionability check already refuses to click
		// an `aria-disabled="true"` element (the click times out without it), which is itself proof
		// the button reads as inert to automation the same way it would to assistive tech. What this
		// assertion pins is the SECOND half of the contract — that if a click event ever does land on
		// it (a stray pointer event, a synthetic dispatch), the handler still does nothing.
		await userEvent.click(page.getByRole('button', { name: 'Appliquer' }), {
			force: true
		} as never);
		expect(onApply).not.toHaveBeenCalled();
	});

	it('Appliquer stays inert with only ONE bound, and goes live when the second arrives', async () => {
		/**
		 * A half-range is not a lenient input, it is one the server refuses outright
		 * (`parseCustomDateRange` throws 400 unless BOTH bounds parse). A live Apply here sent a
		 * request whose only possible outcome was the "Période invalide" state — the panel offering an
		 * action guaranteed to fail, then reporting the failure as if the user had mistyped. 6C says
		 * the same thing from the design side: "tant que la fin manque, « Appliquer » reste éteint".
		 */
		expect.assertions(4);
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await userEvent.fill(page.getByLabelText('Du'), '03/03/2026');

		let applyButton = page
			.getByRole('button', { name: 'Appliquer' })
			.element() as HTMLButtonElement;
		expect(applyButton.getAttribute('aria-disabled')).toBe('true');
		expect(applyButton.getAttribute('aria-describedby')).toBeTruthy();

		await userEvent.fill(page.getByLabelText('Au'), '12/06/2026');
		applyButton = page.getByRole('button', { name: 'Appliquer' }).element() as HTMLButtonElement;
		expect(applyButton.getAttribute('aria-disabled')).toBeNull();
		expect(applyButton.getAttribute('aria-describedby')).toBeNull();
	});

	it('Appliquer stays inert when one field holds an incomplete fragment', async () => {
		// Otherwise the fragment is sent verbatim as a URL param on the strength of the other field.
		expect.assertions(1);
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await userEvent.fill(page.getByLabelText('Du'), '03/03/2026');
		await userEvent.fill(page.getByLabelText('Au'), '12/06/202');

		const applyButton = page
			.getByRole('button', { name: 'Appliquer' })
			.element() as HTMLButtonElement;
		expect(applyButton.getAttribute('aria-disabled')).toBe('true');
	});

	it('mounts a calendar grid, with full day names on the column headers and a live status region', async () => {
		expect.assertions(4);
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		// The panel keeps its own role="dialog"; the calendar is a role="grid" INSIDE it, not a
		// replacement for it.
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await expect.element(page.getByRole('grid')).toBeInTheDocument();

		const headers = [...page.getByRole('grid').element().querySelectorAll('th')];
		// `abbr` carries the FULL day name so a screen reader says "lundi", not "L" — the glyph stays
		// one letter only because seven of them have to fit the grid's own width.
		expect(headers.map((h) => h.getAttribute('abbr'))).toEqual([
			'lundi',
			'mardi',
			'mercredi',
			'jeudi',
			'vendredi',
			'samedi',
			'dimanche'
		]);

		const status = page.getByTestId('rc-status').element();
		expect(status.getAttribute('role')).toBe('status');
	});

	it('the invalid message says what did NOT change, and carries the id the trigger points at', async () => {
		expect.assertions(2);
		render(PeriodFilter, base({ from: 'nonsense', to: '2026-06-12', invalid: true }));

		const open = page.getByTestId('period-trigger-group').element().querySelector('button');
		const describedBy = open?.getAttribute('aria-describedby');

		await userEvent.click(page.getByRole('button', { name: /Période/ }).first());
		const message = page.getByText(/dernière période valide/).element();
		expect(message.id).toBe(describedBy);
		expect(message.textContent).toContain('invalide');
	});

	it('renders the optional footer as a sibling of the panel controls, never a listbox option', async () => {
		expect.assertions(2);
		render(PeriodFilter, base({ footer: footerSnippet }));

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await expect.element(page.getByTestId('footer-probe')).toBeInTheDocument();
		// This panel has no listbox at all (it is deliberately not one — see the component's own
		// comment), so the guarding assertion here is simply that no role="option" exists to have
		// swallowed the footer.
		expect(page.getByRole('option').elements().length).toBe(0);
	});

	it('puts the selected state on the matching preset row when the current range IS one', async () => {
		expect.assertions(1);
		render(PeriodFilter, base({ from: '2026-06-01', to: '2026-06-30' }));

		await userEvent.click(page.getByRole('button', { name: /Période/ }).first());
		const thisMonth = page.getByRole('button', { name: 'Ce mois-ci' }).element();
		expect(thisMonth.getAttribute('aria-pressed')).toBe('true');
	});
});

describe('PeriodFilter — Escape and focus-out', () => {
	it('Escape closes the panel and hands focus back to the open button', async () => {
		expect.assertions(2);
		render(PeriodFilter, base({ from: '2026-03-03', to: '2026-06-12' }));

		const trigger = page.getByRole('button', {
			name: /Période : 3 mars 2026 → 12 juin 2026/
		});
		await userEvent.click(trigger);
		await userEvent.keyboard('{Escape}');

		expect(page.getByRole('dialog').elements().length).toBe(0);
		expect(document.activeElement).toBe(trigger.element());
	});

	it('moving focus out of the panel entirely (relatedTarget null) does not close it', async () => {
		expect.assertions(2);
		render(PeriodFilter, base());

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		expect(page.getByRole('dialog').elements().length).toBe(1);

		const panel = page.getByRole('dialog').element();
		panel.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null, bubbles: true }));

		expect(page.getByRole('dialog').elements().length).toBe(1);
	});

	it('moving focus to something outside the component closes the panel', async () => {
		expect.assertions(2);
		render(PeriodFilter, base());

		const outside = document.createElement('button');
		outside.textContent = 'ailleurs';
		document.body.append(outside);

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		expect(page.getByRole('dialog').elements().length).toBe(1);

		outside.focus();

		await expect.poll(() => page.getByRole('dialog').elements().length).toBe(0);
		outside.remove();
	});
});

/**
 * The panel's own box against its own content.
 *
 * This is here because the panel shipped with its `Appliquer` button painted 58px outside its
 * right border, on every desktop open, and nothing went red: no ancestor clips (every one is
 * `overflow: visible`), so the button rendered perfectly legibly in the wrong place and read as
 * a stray control floating over the table. A screenshot showed it; no assertion could.
 *
 * The vertical half of the same guard matters MORE once the panel scrolls, not less. `max-height`
 * + `overflow-y: auto` turns the panel into a scroll container, and a scroll container clips the
 * horizontal axis too — so from that point on a child wider than the panel is HIDDEN rather than
 * visibly wrong. That is the "unnoticed" case, and it is why the width assertion is kept beside
 * the height one instead of being considered settled by the fix that prompted it.
 */
describe('the panel cannot escape its own box', () => {
	async function openPanel(triggerName: string, overrides: Props = {}) {
		render(PeriodFilter, base(overrides));
		// Named explicitly rather than matched on 'Période': once a value is set the group grows a
		// second button ("Retirer le filtre par Période") that also matches the substring.
		await userEvent.click(page.getByRole('button', { name: triggerName, exact: true }));
		return page.getByRole('dialog').element() as HTMLElement;
	}

	it('no content overflows the panel horizontally', async () => {
		expect.assertions(2);
		const panel = await openPanel('Période');

		expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);

		const right = panel.getBoundingClientRect().right;
		const widest = Array.from(panel.querySelectorAll('*')).reduce((max, node) => {
			const box = node.getBoundingClientRect();
			return box.width > 0 && box.right > max ? box.right : max;
		}, 0);
		expect(widest).toBeLessThanOrEqual(right);
	});

	it('no content overflows the panel horizontally in the invalid state either', async () => {
		expect.assertions(1);
		// The invalid message is the panel's longest single string, and it is the one piece of
		// content that is absent from the default render — so the assertion above is blind to it.
		const panel = await openPanel('Période : saisie invalide', {
			from: '2026-06-30',
			to: '2026-06-01',
			invalid: true
		});

		expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
	});

	it('the panel scrolls rather than growing without bound', async () => {
		expect.assertions(1);
		const panel = await openPanel('Période');

		// Not a pixel figure: the viewport under vitest-browser is not the app's. What is pinned is
		// that a bound EXISTS and that it is expressed against the viewport, so a panel taller than
		// the space it has scrolls inside itself instead of running off the bottom of the screen.
		expect(getComputedStyle(panel).maxHeight).not.toBe('none');
	});
});

describe('the grid restarts a backward range, it never swaps the bounds silently', () => {
	/**
	 * The design's rule (6E): "Cliquer un jour antérieur au début ne permute pas les bornes en
	 * silence : il redémarre la plage à ce jour."
	 *
	 * This is asserted through REAL CLICKS on the real calendar rather than by calling the handler,
	 * because the defect it guards is not in the handler's logic — it is in how many times bits-ui
	 * calls it. One backward click emits `onValueChange` TWICE synchronously (`#setStartValue` then
	 * `#setEndValue` with the old start), and a test that invokes the handler once cannot see the
	 * second call at all. It would pass against the broken build.
	 */
	async function openPanelOn(day: string) {
		const screen = render(PeriodFilter, base());
		await screen.getByRole('button', { name: 'Période', exact: true }).click();
		await page
			.getByRole('gridcell', { name: new RegExp(`\\b${day}\\b`) })
			.first()
			.click();
		return screen;
	}

	it('restarts at the earlier day, leaving no end, when a day before the start is clicked', async () => {
		await openPanelOn('10');
		const from = page.getByLabelText(/^Du$/);
		await expect.element(from).toHaveValue('10/06/2026');

		await page.getByRole('gridcell', { name: /\b5\b/ }).first().click();

		// The earlier day becomes the new START, and the range is incomplete again. It must NOT
		// have become 05/06 -> 10/06, which is the silent permutation.
		await expect.element(page.getByLabelText(/^Du$/)).toHaveValue('05/06/2026');
		await expect.element(page.getByLabelText(/^Au$/)).toHaveValue('');
	});

	it('still completes a normal forward range in two clicks', async () => {
		// The control that stops the fix above from being "swallow every second event".
		await openPanelOn('10');
		await page
			.getByRole('gridcell', { name: /\b18\b/ })
			.first()
			.click();

		await expect.element(page.getByLabelText(/^Du$/)).toHaveValue('10/06/2026');
		await expect.element(page.getByLabelText(/^Au$/)).toHaveValue('18/06/2026');
	});

	it('accepts a re-click on the start as a legitimate one-day range', async () => {
		// 6E is explicit that this is a valid choice, not an error to correct.
		await openPanelOn('10');
		await page
			.getByRole('gridcell', { name: /\b10\b/ })
			.first()
			.click();

		await expect.element(page.getByLabelText(/^Du$/)).toHaveValue('10/06/2026');
		await expect.element(page.getByLabelText(/^Au$/)).toHaveValue('10/06/2026');
	});
});

describe('at 390 Période is a sheet, not a popover', () => {
	/**
	 * The reason it cannot stay a popover is measured, not stylistic: the trigger starts at x = 202px
	 * in the filter row, so a panel anchored to its left edge at the desktop width of 254px ends at
	 * 456px — 66px outside a 390px viewport. What falls outside is the second preset column, the "Au"
	 * field and "Appliquer", and the panel does not scroll sideways. A mobile reader could not
	 * validate a period at all.
	 */
	async function openMobileSheet() {
		await page.viewport(390, 844);
		const screen = render(PeriodFilter, base({ surface: 'mobile', allowCustomRung: false }));
		await screen.getByRole('button', { name: 'Période', exact: true }).click();
		return screen;
	}

	it('renders the primary action in a footer OUTSIDE the scrolling body', async () => {
		await openMobileSheet();

		const apply = page.getByRole('button', { name: 'Appliquer la période' });
		await expect.element(apply).toBeInTheDocument();

		// The rule being pinned is structural, not visual: the action must not share an ancestor
		// scroll container with the grid. A footer that merely LOOKS pinned scrolls away the moment
		// the body is taller than the sheet, which is exactly the 6M case.
		const applyEl = apply.element() as HTMLElement;
		const scroller = applyEl.closest('.overflow-y-auto');
		expect(scroller).toBeNull();

		// ...while the calendar it validates IS inside one.
		const grid = page.getByRole('grid').first().element() as HTMLElement;
		expect(grid.closest('.overflow-y-auto')).not.toBeNull();
	});

	it('keeps the footer on screen when the body is scrolled to its end', async () => {
		await openMobileSheet();

		const applyEl = page
			.getByRole('button', { name: 'Appliquer la période' })
			.element() as HTMLElement;
		const before = applyEl.getBoundingClientRect().top;

		const grid = page.getByRole('grid').first().element() as HTMLElement;
		const scroller = grid.closest('.overflow-y-auto') as HTMLElement;
		scroller.scrollTop = scroller.scrollHeight;
		await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

		// Unmoved. If the footer were inside the scroller this shifts by the scroll delta.
		expect(applyEl.getBoundingClientRect().top).toBe(before);
	});

	it('gives the two sheet actions their touch heights, not the desktop ones', async () => {
		await openMobileSheet();

		const apply = page
			.getByRole('button', { name: 'Appliquer la période' })
			.element() as HTMLElement;
		const clear = page.getByRole('button', { name: 'Effacer' }).element() as HTMLElement;

		// 48 and 44 per the design, against 36 on desktop. Both clear the 44px touch floor, whose
		// precedence clause says a smaller desktop value is a value to bring down, not a precedent.
		expect(Math.round(apply.getBoundingClientRect().height)).toBe(48);
		expect(Math.round(clear.getBoundingClientRect().height)).toBe(44);
	});
});

describe('the mobile trigger meets the 44px floor in BOTH dimensions', () => {
	/**
	 * Height alone is not the floor. WCAG 2.5.5 governs the target, and a control 44px tall and 28px
	 * wide fails it — which is what the clear "×" was, because `min-w-11` was written alongside a
	 * `min-w-[24px]` already in the same class string. Two min-width utilities on one element are
	 * resolved by STYLESHEET order, not by the order they appear in the attribute, so the arbitrary
	 * value silently won and the mobile branch was a no-op. Nothing about the class list looked wrong.
	 *
	 * Measured in both axes for that reason, and for the destructive control specifically: it is the
	 * smallest and the most costly to hit by accident.
	 */
	it('gives every trigger button at least 44px of width and height', async () => {
		await page.viewport(390, 844);
		render(PeriodFilter, base({ surface: 'mobile', from: '2026-06-01', to: '2026-06-30' }));

		const group = document.querySelector('[data-testid="period-trigger-group"]')!;
		const buttons = [...group.querySelectorAll('button')];
		// Both buttons exist: the value trigger and the adjoined clear. An empty list would satisfy
		// "every button is big enough" trivially.
		expect(buttons).toHaveLength(2);

		for (const button of buttons) {
			const rect = button.getBoundingClientRect();
			expect(Math.round(rect.height)).toBeGreaterThanOrEqual(44);
			expect(Math.round(rect.width)).toBeGreaterThanOrEqual(44);
		}

		// The group's own box is 46, not 44: a 44px child inside a 1px-bordered parent forces it.
		// Pinned so the discrepancy stays a recorded decision rather than looking like drift.
		expect(Math.round(group.getBoundingClientRect().height)).toBe(46);
		expect(getComputedStyle(group).borderRadius).toBe('12px');
	});
});

describe('the sheet keeps its header as well as its footer', () => {
	/**
	 * Same rule, other end: what a reader needs in order to LEAVE must not scroll away. The title and
	 * the return to "Filtres" were the first thing inside the scrolling body, so scrolling the grid
	 * took both off screen and left Escape, the backdrop and the swipe — three affordances a reader
	 * has to already know about — as the only exits.
	 */
	async function openSheet() {
		await page.viewport(390, 844);
		const screen = render(PeriodFilter, base({ surface: 'mobile', allowCustomRung: false }));
		await screen.getByRole('button', { name: 'Période', exact: true }).click();
		return screen;
	}

	it('renders the title and the way back OUTSIDE the scrolling body', async () => {
		await openSheet();
		const back = page.getByRole('button', { name: 'Filtres' }).element() as HTMLElement;
		const title = page.getByRole('heading', { name: 'Période' }).element() as HTMLElement;

		expect(back.closest('.overflow-y-auto')).toBeNull();
		expect(title.closest('.overflow-y-auto')).toBeNull();
		// ...while the grid it sits above IS inside one, so this is not vacuously true.
		const grid = page.getByRole('grid').first().element() as HTMLElement;
		expect(grid.closest('.overflow-y-auto')).not.toBeNull();
	});

	it('leaves the header in place when the body is scrolled to its end', async () => {
		await openSheet();
		const back = page.getByRole('button', { name: 'Filtres' }).element() as HTMLElement;
		const before = back.getBoundingClientRect().top;

		const grid = page.getByRole('grid').first().element() as HTMLElement;
		const scroller = grid.closest('.overflow-y-auto') as HTMLElement;
		scroller.scrollTop = scroller.scrollHeight;
		await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

		expect(back.getBoundingClientRect().top).toBe(before);
	});

	it('gives the way back a 44px target in both axes', async () => {
		await openSheet();
		const back = page.getByRole('button', { name: 'Filtres' }).element() as HTMLElement;
		const rect = back.getBoundingClientRect();
		expect(Math.round(rect.height)).toBeGreaterThanOrEqual(44);
		expect(Math.round(rect.width)).toBeGreaterThanOrEqual(44);
	});

	it('leaves a sliver of backdrop rather than filling the screen', async () => {
		// A sheet that occupies every pixel reads as a new page, losing the "this is over the page
		// you were on" affordance the whole pattern rests on.
		await openSheet();
		const sheet = document.querySelector('[role="dialog"]') as HTMLElement;
		expect(sheet.getBoundingClientRect().height).toBeLessThan(844);
	});
});

describe('6M — the keyboard-open budget, measured rather than deduced', () => {
	/**
	 * The design's table budgets header 73 / body 338 / footer 133 inside a 544px visual viewport.
	 * This app's header renders 85, not 73, because BottomSheet's drag handle is 28px and shared by
	 * every sheet (the design assumed 14). That leaves the body smaller than the design's figure by
	 * the same 12px — a deduction, and this is the exact case where a wrong deduction puts the
	 * focused field under the keyboard. So it is measured.
	 *
	 * Headless Chromium never raises a keyboard, so the visual viewport is stubbed and moved by hand;
	 * that is a faithful model of the resize EVENT, not of a real on-screen keyboard. What a real
	 * device still has to confirm is that iOS Safari and Android Chrome fire it at all and with these
	 * shapes — see the limitation recorded in the component.
	 */
	class FakeVV extends EventTarget {
		height: number;
		offsetTop: number;
		constructor(height: number, offsetTop: number) {
			super();
			this.height = height;
			this.offsetTop = offsetTop;
		}
		set(height: number, offsetTop: number) {
			this.height = height;
			this.offsetTop = offsetTop;
			this.dispatchEvent(new Event('resize'));
		}
	}

	const originalVV = Object.getOwnPropertyDescriptor(window, 'visualViewport');
	afterEach(() => {
		if (originalVV) Object.defineProperty(window, 'visualViewport', originalVV);
	});

	it('keeps the header and Appliquer on screen, and the body above the footer, at 544px', async () => {
		await page.viewport(390, 844);
		const vv = new FakeVV(844, 0);
		Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });

		const screen = render(PeriodFilter, base({ surface: 'mobile', allowCustomRung: false }));
		await screen.getByRole('button', { name: 'Période', exact: true }).click();
		await new Promise((r) => setTimeout(r, 60));

		// The keyboard takes ~300px, exactly the design's row.
		vv.set(544, 0);
		await new Promise((r) => setTimeout(r, 60));

		const sheet = document.querySelector('[role="dialog"]') as HTMLElement;
		const back = page.getByRole('button', { name: 'Filtres' }).element() as HTMLElement;
		const apply = page
			.getByRole('button', { name: 'Appliquer la période' })
			.element() as HTMLElement;
		const scroller = (page.getByRole('grid').first().element() as HTMLElement).closest(
			'.overflow-y-auto'
		) as HTMLElement;

		const sheetBox = sheet.getBoundingClientRect();
		// The sheet RESIZES to the visible box rather than being pushed off the top: if it were
		// pushed, its own top would go negative and the header would leave the screen.
		expect(Math.round(sheetBox.height)).toBeLessThanOrEqual(544);
		expect(Math.round(sheetBox.top)).toBeGreaterThanOrEqual(0);

		// The header is on screen, in full.
		const backBox = back.getBoundingClientRect();
		expect(backBox.top).toBeGreaterThanOrEqual(0);
		expect(backBox.bottom).toBeLessThanOrEqual(544);

		// "Appliquer" is on screen, above the keyboard line — the whole point of the sticky footer.
		const applyBox = apply.getBoundingClientRect();
		expect(applyBox.bottom).toBeLessThanOrEqual(544);
		expect(applyBox.top).toBeGreaterThanOrEqual(0);

		// The body is the only zone that absorbed the loss, and it ends above the footer.
		const bodyBox = scroller.getBoundingClientRect();
		expect(Math.round(bodyBox.bottom)).toBeLessThanOrEqual(Math.round(applyBox.top));
		expect(Math.round(bodyBox.height)).toBeGreaterThan(120);
	});

	it('scrolls a focused date field clear of the footer', async () => {
		await page.viewport(390, 844);
		const vv = new FakeVV(844, 0);
		Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });

		const screen = render(PeriodFilter, base({ surface: 'mobile', allowCustomRung: false }));
		await screen.getByRole('button', { name: 'Période', exact: true }).click();
		await new Promise((r) => setTimeout(r, 60));
		vv.set(544, 0);
		await new Promise((r) => setTimeout(r, 60));

		const field = page.getByLabelText('Au').element() as HTMLInputElement;
		field.focus();
		await new Promise((r) => setTimeout(r, 120));

		const apply = page
			.getByRole('button', { name: 'Appliquer la période' })
			.element() as HTMLElement;
		const fieldBox = field.getBoundingClientRect();
		// Never under the footer, never off the bottom of the visible viewport.
		expect(Math.round(fieldBox.bottom)).toBeLessThanOrEqual(
			Math.round(apply.getBoundingClientRect().top)
		);
		expect(fieldBox.top).toBeGreaterThanOrEqual(0);
	});
});
