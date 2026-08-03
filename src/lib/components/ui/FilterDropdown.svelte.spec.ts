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

	it('an unavailable count renders a placeholder, never a digit that reads as a value', async () => {
		expect.assertions(1);
		render(FilterDropdown, base({ options: [{ value: 'a', label: 'Alpha', count: null }] }));
		await userEvent.click(page.getByRole('button', { name: 'Étiquette' }));

		// Zero is a value; "unknown" is not. A greyed 0 would be read as a real count.
		expect(page.getByRole('option', { name: /Alpha/ }).element().textContent).not.toMatch(/\d/);
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
