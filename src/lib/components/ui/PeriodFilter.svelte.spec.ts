import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import '../../../routes/layout.css';
import PeriodFilter from './PeriodFilter.svelte';

/**
 * PeriodFilter — the Période dimension of the /transactions filter bar.
 *
 * A sibling of FilterDropdown.svelte, not a mode on it (see the long comment at the top of the
 * component). Rendered in a real browser rather than asserted over class strings: what is under
 * test is measured geometry (the 34px/36px trigger group, the 24px/44px targets) and the
 * accessible names a reader actually gets, both of which are computed properties of live nodes.
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

	it('on mobile the group draws at 36px while each button keeps a 44px tap area', async () => {
		expect.assertions(3);
		render(PeriodFilter, base({ from: '2026-03-03', to: '2026-06-12', surface: 'mobile' }));

		const group = page.getByTestId('period-trigger-group').element() as HTMLElement;
		const buttons = [...group.querySelectorAll('button')];

		// 36px is the VISUAL box (design section 7's drawing); 44px is the TAP area, grown via
		// transparent overflow (`min-h-[44px] -my-1`) so the row's own layout height never changes.
		expect(Math.round(group.getBoundingClientRect().height)).toBe(36);
		for (const button of buttons) {
			expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
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
		expect.assertions(3);
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

	it('applies a preset as a from/to pair, never a third param', async () => {
		expect.assertions(1);
		const onApply = vi.fn();
		render(PeriodFilter, base({ onApply }));

		await userEvent.click(page.getByRole('button', { name: 'Période' }));
		await userEvent.click(page.getByRole('button', { name: 'Ce mois-ci' }));

		expect(onApply).toHaveBeenCalledWith({ from: '2026-06-01', to: '2026-06-30' });
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
