import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import '../../../routes/layout.css';
import FilterDropdown from './FilterDropdown.svelte';

/**
 * The filter trigger grammar (design sections 4 and 6).
 *
 * The rule the whole component exists to enforce: AT REST a trigger carries the name of its
 * DIMENSION and nothing else. "Toutes" is the resting VALUE of a filter, and a trigger that
 * displayed its value is the direct cause of the two adjacent "Toutes" the design was written to
 * remove. "Toutes" survives only as the return row inside the open list.
 *
 * Rendered in a real browser rather than asserted over source text: what is under test is the
 * accessible name a reader actually gets, the role of each row, and whether the footer counts as
 * an option — all of which are computed properties of live nodes, not of markup.
 */

const OPTIONS = [
	{ value: 'a', label: 'Alpha', count: 3 },
	{ value: 'b', label: 'Beta', count: 0, disabled: true }
];

type Props = Record<string, unknown>;

/**
 * A stand-in for ManageTagsFooter. It has to be a REAL rendered footer: the first version of the
 * "footer is not an option" test passed no footer at all, so both of its assertions were true of
 * an empty panel and the test was structurally incapable of failing — moving the footer inside the
 * listbox on purpose left it green.
 */
const footerSnippet = createRawSnippet(() => ({
	render: () => '<a data-testid="footer-probe" href="/settings#tags">Gérer dans Paramètres</a>'
}));

function base(overrides: Props = {}): Props {
	return {
		dimensionLabel: 'Étiquette',
		options: OPTIONS,
		value: '',
		allLabel: 'Toutes',
		allCount: 12,
		searchPlaceholder: 'Filtrer les étiquettes',
		clearAriaLabel: 'Retirer le filtre par Étiquette',
		onSelect: vi.fn(),
		onClear: vi.fn(),
		...overrides
	};
}

describe('FilterDropdown — the trigger grammar', () => {
	it('at rest the trigger reads the dimension name, and "Toutes" is nowhere on it', async () => {
		expect.assertions(2);
		render(FilterDropdown, base());

		await expect.element(page.getByRole('button', { name: 'Étiquette' })).toBeInTheDocument();
		// The closed component must not render the return row at all: "Toutes" on a resting trigger
		// is precisely the defect this grammar removes.
		expect(page.getByText('Toutes').elements().length).toBe(0);
	});

	it('active renders two adjoined buttons — open, and a separate clear', async () => {
		expect.assertions(2);
		render(FilterDropdown, base({ value: 'a', activeLabel: 'Étiquette : Alpha' }));

		// Two buttons, never one nested in the other: nested buttons are invalid HTML, and the
		// design requires two independent targets of at least 24px.
		await expect
			.element(page.getByRole('button', { name: 'Étiquette : Alpha' }))
			.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Retirer le filtre par Étiquette' }))
			.toBeInTheDocument();
	});

	it('the trigger group is 34px tall and neither half falls under the 24px target', async () => {
		expect.assertions(3);
		render(FilterDropdown, base({ value: 'a', activeLabel: 'Étiquette : Alpha' }));

		const open = page.getByRole('button', { name: 'Étiquette : Alpha' }).element();
		const clear = page.getByRole('button', { name: 'Retirer le filtre par Étiquette' }).element();
		const group = open.parentElement as HTMLElement;

		// MEASURED, not read off a class list. `h-[34px]` on the wrapper is a claim until the border
		// box is read: CLAUDE.md records this exact family of mistake twice — a wrapper whose box
		// includes its border, leaving the children (which carry the click handler) 2px short, and a
		// `w-[Npx]` on a `<td>` that a 262px column ignored while the header measured 190px.
		expect(Math.round(group.getBoundingClientRect().height)).toBe(34);
		// Bringing the group down from 44px must not take either target under the minimum. These are
		// the two gestures the design splits apart on purpose, so a 34px group with a 20px "×" would
		// trade one conformance for another.
		expect(open.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
		expect(clear.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
	});

	it('the footer is a sibling of the listbox, not one of its options', async () => {
		expect.assertions(3);
		render(FilterDropdown, base({ footer: footerSnippet }));
		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));

		// First: the footer really is on screen. Without this the two assertions below are equally
		// true of a panel that renders no footer at all.
		await expect.element(page.getByTestId('footer-probe')).toBeInTheDocument();
		// "Toutes" + Alpha + Beta = 3. A footer rendered as an option would make it 4, and a screen
		// reader would count it into "3 éléments".
		expect(page.getByRole('option').elements().length).toBe(3);
		expect(
			page.getByRole('listbox').element().querySelector('[data-testid="footer-probe"]')
		).toBeNull();
	});

	it('a zero count stays visible, writes "0", and is aria-disabled rather than hidden', async () => {
		expect.assertions(2);
		render(FilterDropdown, base());
		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));

		// Hiding it would be indistinguishable from a deletion — and since tags now disappear on
		// their own at zero transactions, that confusion has a real cost.
		const beta = page.getByRole('option', { name: /Beta/ }).element();
		expect(beta.getAttribute('aria-disabled')).toBe('true');
		expect(beta.textContent).toContain('0');
	});

	it('an unavailable count renders the placeholder, not a digit and not nothing', async () => {
		expect.assertions(2);
		render(FilterDropdown, base({ options: [{ value: 'a', label: 'Alpha', count: null }] }));
		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));

		const text = page.getByRole('option', { name: /Alpha/ }).element().textContent ?? '';
		// Zero is a value; "unknown" is not. A greyed 0 would be read as a real count.
		expect(text).not.toMatch(/\d/);
		// And the placeholder must actually be THERE. Asserting only the absence of a digit was the
		// third vacuous assertion in this file: returning '' instead of the em dash silently drops
		// the placeholder the design requires, and an empty string contains no digit either.
		expect(text).toContain('—');
	});

	it('the internal search field appears only past 8 options, and replaces the scope line', async () => {
		expect.assertions(2);
		const many = Array.from({ length: 9 }, (_, i) => ({
			value: `t${i}`,
			label: `Tag ${i}`,
			count: 1
		}));
		render(FilterDropdown, base({ options: many, scopeNote: 'Comptes dans le filtre courant.' }));
		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));

		await expect.element(page.getByPlaceholder('Filtrer les étiquettes')).toBeInTheDocument();
		// Two header lines would push the first tag to the third row.
		expect(page.getByText('Comptes dans le filtre courant.').elements().length).toBe(0);
	});

	it('at exactly 8 options there is still no search field, only the scope line', async () => {
		expect.assertions(2);
		// The BOUNDARY, not a comfortable distance from it. The first version of this pair used 9
		// options against a threshold of 8 and 2 options against nothing: lowering the threshold to
		// 7 on purpose left both green, because neither sat on the edge the rule defines.
		const eight = Array.from({ length: 8 }, (_, i) => ({
			value: `t${i}`,
			label: `Tag ${i}`,
			count: 1
		}));
		render(FilterDropdown, base({ options: eight, scopeNote: 'Comptes dans le filtre courant.' }));
		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));

		await expect.element(page.getByText('Comptes dans le filtre courant.')).toBeInTheDocument();
		expect(page.getByPlaceholder('Filtrer les étiquettes').elements().length).toBe(0);
	});
});

describe('FilterDropdown — selection and keyboard', () => {
	it('choosing a row reports its value, and the return row reports the empty string', async () => {
		expect.assertions(2);
		const onSelect = vi.fn();
		render(FilterDropdown, base({ onSelect }));

		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));
		await userEvent.click(page.getByRole('option', { name: /Alpha/ }));
		expect(onSelect).toHaveBeenCalledWith('a');

		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));
		await userEvent.click(page.getByRole('option', { name: 'Toutes' }));
		// '' is how the return row says "back to no filter on this dimension".
		expect(onSelect).toHaveBeenLastCalledWith('');
	});

	it('the clear button reports a clear, and never a selection', async () => {
		expect.assertions(2);
		const onClear = vi.fn();
		const onSelect = vi.fn();
		render(
			FilterDropdown,
			base({ value: 'a', activeLabel: 'Étiquette : Alpha', onClear, onSelect })
		);

		await userEvent.click(page.getByRole('button', { name: 'Retirer le filtre par Étiquette' }));
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('a zero-count row is announced but inert: clicking it selects nothing', async () => {
		expect.assertions(1);
		const onSelect = vi.fn();
		render(FilterDropdown, base({ onSelect }));

		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));
		// A NATIVE click, deliberately, not userEvent.click: Playwright refuses to click an
		// aria-disabled element ("element is not enabled") and would time out instead of exercising
		// the guard. A real browser has no such scruple — aria-disabled is not the native disabled
		// attribute, and a real pointer does dispatch a click here. The component's own guard is
		// therefore the only thing standing between the user and a filter that returns nothing,
		// which is exactly what this asserts.
		(page.getByRole('option', { name: /Beta/ }).element() as HTMLElement).click();

		expect(onSelect).not.toHaveBeenCalled();
	});

	it('arrows traverse the rows and Enter takes the highlighted one', async () => {
		expect.assertions(1);
		const onSelect = vi.fn();
		render(FilterDropdown, base({ onSelect }));

		const trigger = page.getByRole('button', { name: 'Étiquette' });
		await userEvent.click(trigger);
		// Row 0 is "Toutes", row 1 is Alpha.
		await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

		expect(onSelect).toHaveBeenCalledWith('a');
	});

	it('Escape closes the panel and hands focus back to the trigger, not to the clear button', async () => {
		expect.assertions(2);
		render(FilterDropdown, base({ value: 'a', activeLabel: 'Étiquette : Alpha' }));

		const trigger = page.getByRole('button', { name: 'Étiquette : Alpha' });
		await userEvent.click(trigger);
		await userEvent.keyboard('{Escape}');

		expect(page.getByRole('listbox').elements().length).toBe(0);
		// Landing on "×" would put the user one keystroke from undoing the choice just made.
		expect(document.activeElement).toBe(trigger.element());
	});

	it('moving focus out of the panel closes it, so it cannot float over the page unreachable', async () => {
		expect.assertions(2);
		render(FilterDropdown, base());

		// Something outside the component to receive the focus. Pressing Tab is not enough on its
		// own here: the test DOM has nothing after the component, so focus leaves the document and
		// relatedTarget is null — the one case the handler deliberately ignores, because focus
		// going to another window must not close the panel behind the user's back.
		const outside = document.createElement('button');
		outside.textContent = 'ailleurs';
		document.body.append(outside);

		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));
		expect(page.getByRole('listbox').elements().length).toBe(1);

		outside.focus();

		// The listbox is tabindex="-1" and so absent from the Tab sequence: one Tab used to move
		// focus clean out of the component while `open` stayed true, leaving an absolutely
		// positioned panel over the page that Escape could no longer reach.
		await expect.poll(() => page.getByRole('listbox').elements().length).toBe(0);
		outside.remove();
	});

	it('the tinted variant paints its own background instead of the neutral active border', async () => {
		expect.assertions(2);
		render(
			FilterDropdown,
			base({
				value: 'a',
				activeLabel: 'Étiquette : Alpha',
				tinted: true,
				tintBgClass: 'bg-[#fff0e7]',
				tintBorderClass: 'border-[#e8cab8]'
			})
		);

		// The one place in the bar where a tag's identity shows. Subordinated, not decorative:
		// only the background and border colour differ from the neutral grammar.
		const group = page.getByRole('button', { name: 'Étiquette : Alpha' }).element().parentElement;
		expect(group?.className).toContain('bg-[#fff0e7]');
		expect(group?.className).not.toContain('border-zinc-900');
	});

	it('a value naming no known option renders as resting rather than half-active', async () => {
		expect.assertions(2);
		// Reachable in this app: a tag on zero transactions is deleted silently, so a bookmarked
		// ?tag=<id> outlives its tag. The trigger used to read as resting while painting an active
		// border and an orphan "×".
		render(FilterDropdown, base({ value: 'deleted-tag-id' }));

		await expect.element(page.getByRole('button', { name: 'Étiquette' })).toBeInTheDocument();
		expect(
			page.getByRole('button', { name: 'Retirer le filtre par Étiquette' }).elements().length
		).toBe(0);
	});
});
