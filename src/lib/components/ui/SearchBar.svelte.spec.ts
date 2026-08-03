import { page, userEvent } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import SearchBar from './SearchBar.svelte';

describe('SearchBar.svelte', () => {
	it('hides the clear button when the value is empty', async () => {
		render(SearchBar, { value: '', clearLabel: 'Effacer la recherche' });

		await expect
			.element(page.getByRole('button', { name: 'Effacer la recherche' }))
			.not.toBeInTheDocument();
	});

	it('shows the clear button when the value is non-empty, and clears + refocuses on click', async () => {
		render(SearchBar, { value: 'carrefour', clearLabel: 'Effacer la recherche' });

		const input = page.getByRole('searchbox');
		await expect.element(input).toHaveValue('carrefour');

		const clearButton = page.getByRole('button', { name: 'Effacer la recherche' });
		await expect.element(clearButton).toBeInTheDocument();

		await userEvent.click(clearButton);

		await expect.element(input).toHaveValue('');
		await expect.element(input).toHaveFocus();
		await expect
			.element(page.getByRole('button', { name: 'Effacer la recherche' }))
			.not.toBeInTheDocument();
	});

	it('applies the rose error classes when error is true', async () => {
		render(SearchBar, { value: '', clearLabel: 'Effacer la recherche', error: true });

		const input = page.getByRole('searchbox').element();
		expect(input.className).toContain('border-rose-300');
		expect(input.className).toContain('bg-rose-50');
	});

	it('does not apply the error classes by default', async () => {
		render(SearchBar, { value: '', clearLabel: 'Effacer la recherche' });

		const input = page.getByRole('searchbox').element();
		expect(input.className).not.toContain('border-rose-300');
	});

	// The one behavior the migration brief explicitly calls out as critical: transactions embeds
	// this component with a plain (non-bound) `value` prop inside a native <form method="GET">,
	// where a fresh navigation/reload must always win over whatever the user last typed — exactly
	// like a bare, uncontrolled <input value={...}> would behave. This proves the $bindable prop
	// still resyncs from a new parent value when the caller never established a two-way `bind:`.
	it('resyncs to a fresh value prop after local typing, when the caller does not use bind:value', async () => {
		const { rerender } = render(SearchBar, { value: 'old query', clearLabel: 'Effacer' });

		const input = page.getByRole('searchbox');
		await expect.element(input).toHaveValue('old query');

		await userEvent.clear(input);
		await userEvent.type(input, 'typed by the user');
		await expect.element(input).toHaveValue('typed by the user');

		// Simulates a fresh SvelteKit load handing down a new `data.filters.q` (e.g. after a
		// browser back/forward navigation) — the caller re-passes `value`, never having bound it.
		await rerender({ value: 'new query', clearLabel: 'Effacer' });

		await expect.element(input).toHaveValue('new query');
	});

	it('passes name/id/placeholder/aria-label through to the input', async () => {
		render(SearchBar, {
			value: '',
			name: 'q',
			id: 'search-transactions',
			placeholder: 'Libellé…',
			ariaLabel: 'Rechercher une transaction',
			clearLabel: 'Effacer'
		});

		const input = page.getByRole('searchbox', { name: 'Rechercher une transaction' });
		await expect.element(input).toHaveAttribute('name', 'q');
		await expect.element(input).toHaveAttribute('id', 'search-transactions');
		await expect.element(input).toHaveAttribute('placeholder', 'Libellé…');
	});

	it('calls onclick side effects only via the clear button, never submitting anything itself', async () => {
		// SearchBar renders no <form> and no submit-triggering element of its own — the clear
		// button is type="button" (IconButton's default), so it can never accidentally submit an
		// enclosing native form.
		const onclick = vi.fn();
		render(SearchBar, { value: 'x', clearLabel: 'Effacer' });

		const clearButton = page.getByRole('button', { name: 'Effacer' }).element();
		expect(clearButton.getAttribute('type')).toBe('button');
		expect(onclick).not.toHaveBeenCalled();
	});

	// Explicit migration assertion: /transactions embeds SearchBar (name="q") as a sibling of a
	// hidden <input type="hidden" name="qMode"> inside a real <form method="GET">. Wrapping the
	// bare <input> in this component must not change what the form serializes on submit — the
	// wrapper div SearchBar adds around the input must be submission-transparent, exactly like the
	// bare <input> it replaced. This reproduces that exact sibling structure (minus styling, which
	// is irrelevant to submission) and asserts on the real FormData produced by a native submit.
	describe('inside a real <form> (transactions-style q/qMode deep-linking)', () => {
		// vitest-browser-svelte's `cleanup()` (run automatically in `beforeEach`) only unmounts
		// Svelte components — it doesn't know about the plain <form>/<input> DOM nodes these tests
		// append manually, so without this they'd accumulate across tests and a global
		// `document.querySelector('form')` would silently pick up a stale one from a prior test.
		let formsToCleanup: HTMLFormElement[] = [];
		afterEach(() => {
			for (const form of formsToCleanup) form.remove();
			formsToCleanup = [];
		});

		function buildTransactionsFilterForm(container: HTMLElement) {
			// Reproduces transactions/+page.svelte's markup order verbatim: hidden qMode input,
			// then the SearchBar-owned name="q" input, as direct children of the <form>.
			const form = document.createElement('form');
			form.method = 'GET';
			form.action = '/transactions';

			const qModeInput = document.createElement('input');
			qModeInput.type = 'hidden';
			qModeInput.name = 'qMode';
			qModeInput.value = 'regex';
			form.appendChild(qModeInput);

			// Move SearchBar's rendered subtree (the wrapper div containing the real <input>) into
			// the form, exactly as it sits as a sibling of the hidden input in the real page.
			form.appendChild(container);

			document.body.appendChild(form);
			formsToCleanup.push(form);
			return { form, qModeInput };
		}

		it('submits name="q" with the typed value alongside the untouched hidden qMode sibling', async () => {
			const { container } = render(SearchBar, {
				value: '',
				name: 'q',
				clearLabel: 'Effacer'
			});
			const { form } = buildTransactionsFilterForm(container);

			const input = page.getByRole('searchbox');
			await userEvent.type(input, 'carrefour market');

			let submittedParams: URLSearchParams | null = null;
			form.addEventListener('submit', (event) => {
				event.preventDefault();
				submittedParams = new URLSearchParams(new FormData(form) as unknown as URLSearchParams);
			});

			form.requestSubmit();

			expect(submittedParams).not.toBeNull();
			// Exactly the two params the pre-migration bare <input> + hidden input produced —
			// nothing extra, nothing renamed, nothing dropped from wrapping the input in a div.
			expect(Array.from(submittedParams!.entries())).toEqual([
				['qMode', 'regex'],
				['q', 'carrefour market']
			]);
			expect(submittedParams!.toString()).toBe('qMode=regex&q=carrefour+market');
		});

		it('submits an empty q param when the value is empty', async () => {
			const { container } = render(SearchBar, {
				value: '',
				name: 'q',
				clearLabel: 'Effacer'
			});
			const { form } = buildTransactionsFilterForm(container);

			const formData = new FormData(form);
			const params = new URLSearchParams(formData as unknown as URLSearchParams);

			expect(params.get('q')).toBe('');
			expect(params.get('qMode')).toBe('regex');
		});

		it('omits the q param entirely when no name prop is passed (matches a bare unnamed <input>)', async () => {
			const { container } = render(SearchBar, { value: 'carrefour', clearLabel: 'Effacer' });
			const { form } = buildTransactionsFilterForm(container);

			const formData = new FormData(form);

			expect(Array.from(formData.keys())).toEqual(['qMode']);
			expect(formData.has('q')).toBe(false);
		});

		it('never intercepts the native submit (no preventDefault of its own, no extra fields added)', async () => {
			const { container } = render(SearchBar, {
				value: 'sncf',
				name: 'q',
				clearLabel: 'Effacer'
			});
			const { form } = buildTransactionsFilterForm(container);

			// SearchBar must not register any submit/click listener that would stop the browser's
			// default navigation — simulate what a real click on a type="submit" sibling button
			// would trigger and confirm the event is still cancelable/default-actionable.
			const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
			form.dispatchEvent(submitEvent);
			const defaultPrevented = submitEvent.defaultPrevented;

			expect(defaultPrevented).toBe(false);
			// Only the two expected inputs contribute to the form — SearchBar didn't smuggle in
			// any extra named field (e.g. a duplicate hidden input) alongside the visible one.
			const formData = new FormData(form);
			expect(Array.from(formData.keys())).toEqual(['qMode', 'q']);
		});
	});

	describe('density', () => {
		// Measured, not asserted from class names: the whole point of the `bar` density is a
		// RENDERED height that matches FilterDropdown/PeriodFilter's triggers on the same row, and
		// a class list cannot prove two components agree about a number.
		it('the field density is the 44px primary-form-field template', async () => {
			expect.assertions(1);
			render(SearchBar, { value: '', clearLabel: 'Effacer', wrapperClass: 'w-[300px]' });

			const wrapper = page.getByRole('searchbox').element().parentElement as HTMLElement;
			expect(Math.round(wrapper.getBoundingClientRect().height)).toBe(44);
		});

		it('the bar density is 34px and its clear button still clears the 24px target', async () => {
			expect.assertions(4);
			render(SearchBar, {
				value: 'carrefour',
				density: 'bar',
				clearLabel: 'Effacer',
				wrapperClass: 'w-[300px]'
			});

			const wrapper = page.getByRole('searchbox').element().parentElement as HTMLElement;
			expect(Math.round(wrapper.getBoundingClientRect().height)).toBe(34);

			// The clear button is the control the caller cannot reach: the regex toggle is passed in
			// through `trailing` and sized at the call site, but this one is owned here. Shrinking
			// the field without shrinking it is what would push a 44px control out of a 34px box.
			const clear = page.getByRole('button', { name: 'Effacer' }).element();
			const box = clear.getBoundingClientRect();
			expect(box.width).toBeGreaterThanOrEqual(24);
			expect(box.height).toBeGreaterThanOrEqual(24);
			expect(box.height).toBeLessThanOrEqual(34);
		});
	});
});
