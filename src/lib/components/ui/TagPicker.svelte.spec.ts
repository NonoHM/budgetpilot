import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import TagPicker from './TagPicker.svelte';

const options = [
	{ id: 'o1', name: 'Portugal', colorToken: 'clay' as const },
	{ id: 'o2', name: 'Travaux', colorToken: 'ochre' as const }
];

function fieldInput() {
	return page.getByRole('combobox');
}

describe('TagPicker.svelte', () => {
	it('lists existing tags with their colour dots when opened', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.click(fieldInput());

		await expect.element(page.getByRole('option', { name: 'Portugal' })).toBeInTheDocument();
		await expect.element(page.getByRole('option', { name: 'Travaux' })).toBeInTheDocument();
	});

	it('offers to create the typed value when nothing matches', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.type(fieldInput(), 'Réparation vélo');

		await expect
			.element(page.getByRole('option', { name: 'Créer « Réparation vélo »' }))
			.toBeInTheDocument();
	});

	it('does not offer to create a name that already exists, case-insensitively', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.type(fieldInput(), 'portugal');

		await expect.element(page.getByRole('option', { name: 'Portugal' })).toBeInTheDocument();
		expect(page.getByText(/^Créer/).elements().length).toBe(0);
	});

	it('does not offer to create a name that already exists, accent-insensitively', async () => {
		// A plain case fold (toLowerCase) is not enough: "Café" and "cafe" only match through
		// normalizeForMatch's NFD diacritic stripping, which this test exists specifically to pin.
		const accented = [{ id: 'o3', name: 'Café clients', colorToken: 'olive' as const }];
		render(TagPicker, { options: accented, selected: [] });

		await userEvent.type(fieldInput(), 'cafe clients');

		await expect.element(page.getByRole('option', { name: 'Café clients' })).toBeInTheDocument();
		expect(page.getByText(/^Créer/).elements().length).toBe(0);
	});

	it('lets several tags be picked in one pass, without the focus ever leaving the field', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.click(fieldInput());
		await userEvent.click(page.getByRole('option', { name: 'Portugal' }));

		// Committing closes the panel — it is detached and would otherwise sit on top of whatever the
		// caller puts below the field (in the transaction editor, the Save button). Chaining is
		// preserved by the field keeping focus, so one keystroke reopens the panel; that is the
		// property this test protects, not the panel's mounted state.
		await expect.element(fieldInput()).toHaveFocus();
		await userEvent.type(fieldInput(), 'Trav');
		await expect.element(page.getByRole('option', { name: 'Travaux' })).toBeInTheDocument();

		await userEvent.click(page.getByRole('option', { name: 'Travaux' }));

		await expect
			.element(page.getByRole('button', { name: "Retirer l'étiquette Portugal" }))
			.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: "Retirer l'étiquette Travaux" }))
			.toBeInTheDocument();
	});

	it('removes a selected tag when its chip remove control is used', async () => {
		render(TagPicker, { options, selected: ['Portugal'] });

		await expect
			.element(page.getByRole('button', { name: "Retirer l'étiquette Portugal" }))
			.toBeInTheDocument();

		await userEvent.click(page.getByRole('button', { name: "Retirer l'étiquette Portugal" }));

		expect(page.getByText('Portugal').elements().length).toBe(0);
	});

	it('serializes the selection into the hidden input, newline separated', async () => {
		const { container } = render(TagPicker, {
			options,
			selected: ['Portugal', 'Travaux'],
			name: 'tagNames'
		});

		const hidden = container.querySelector('input[type="hidden"][name="tagNames"]');
		expect(hidden).toBeTruthy();
		expect((hidden as HTMLInputElement).value).toBe('Portugal\nTravaux');
	});

	it('refuses to add beyond MAX_TAGS_PER_TRANSACTION', async () => {
		const many = Array.from({ length: 10 }, (_, i) => `Étiquette ${i}`);
		// Asserted on the SAME instance that receives the keystrokes: a second, freshly rendered
		// instance sharing the initial `selected` prop would read `hidden` back unchanged no matter
		// what the acted-upon instance did, and the cap check could be broken without this test
		// noticing.
		const { container } = render(TagPicker, { options: [], selected: many, name: 'tagNames' });

		await userEvent.type(fieldInput(), 'Une de plus');
		await userEvent.keyboard('{Enter}');

		await expect.element(page.getByText('Limite de 10 étiquettes atteinte.')).toBeInTheDocument();
		const hidden = container.querySelector('input[type="hidden"][name="tagNames"]');
		const values = (hidden as HTMLInputElement).value.split('\n');
		// Distinguishes 10 from 11: with the cap broken to allow an eleventh tag, this instance's
		// own hidden input would carry 11 values including 'Une de plus'.
		expect(values).toHaveLength(10);
		expect(values).not.toContain('Une de plus');
	});

	it('trims and collapses whitespace before adding, matching normalizeTagName', async () => {
		const { container } = render(TagPicker, { options: [], selected: [], name: 'tagNames' });

		await userEvent.type(fieldInput(), '  Vacances   Portugal  ');
		await userEvent.click(page.getByRole('option', { name: /^Créer/ }));

		const hidden = container.querySelector('input[type="hidden"][name="tagNames"]');
		expect((hidden as HTMLInputElement).value).toBe('Vacances Portugal');
	});

	it('is keyboard reachable: arrow keys move, Enter selects, Escape closes without changing selection', async () => {
		render(TagPicker, { options, selected: [] });

		// A real click, not a bare .focus() call: under load, a programmatic focus() can resolve
		// before the browser has actually moved document.activeElement, and the very next
		// userEvent.keyboard() then targets <body> instead of the field — this test flaked exactly
		// that way under the full suite's contention while passing every time in isolation.
		await userEvent.click(fieldInput());
		await userEvent.keyboard('{ArrowDown}');
		await expect
			.element(fieldInput())
			.toHaveAttribute('aria-activedescendant', expect.stringContaining('option-0'));

		await userEvent.keyboard('{ArrowDown}');
		await expect
			.element(fieldInput())
			.toHaveAttribute('aria-activedescendant', expect.stringContaining('option-1'));

		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByRole('listbox')).not.toBeInTheDocument();
		expect(page.getByText('Portugal').elements().length).toBe(0);
	});

	it('keeps an Escape that closed the panel to itself, and lets one through when the panel was already closed', async () => {
		// The design gives Escape exactly one job here: "Échap ferme sans changer la sélection".
		// It did close the panel — and kept bubbling, so the page-level handler behind it ran too.
		// On /transactions that handler is BottomSheet's window keydown (mounted at every breakpoint,
		// only CSS hides it), which closes the transaction detail panel: one Escape closed the picker
		// AND deselected the transaction, silently discarding whatever tag edits were pending and
		// unsaved. Measured on a live page with a removed tag and Save enabled — no confirmation, no
		// banner, the edit simply gone.
		//
		// Both directions are asserted in ONE test on purpose. Swallowing every Escape would be its
		// own regression: with the panel closed, Escape must still reach the page so the detail panel
		// keeps closing the way it does from any other control. A test for the first half alone
		// passes on an implementation that breaks the second.
		//
		// BREAK-THE-CHECK: dropping `event.stopPropagation()` from TagPicker's Escape branch makes
		// the first expectation fail (the window handler sees the open-panel Escape) — verified by
		// hand, see the PR report.
		render(TagPicker, { options, selected: [] });

		const seenByPage: string[] = [];
		const listener = () => seenByPage.push('escape');
		window.addEventListener('keydown', listener);
		try {
			await userEvent.click(fieldInput());
			await expect.element(page.getByRole('listbox')).toBeInTheDocument();

			await userEvent.keyboard('{Escape}');
			await expect.element(page.getByRole('listbox')).not.toBeInTheDocument();
			expect(seenByPage).toEqual([]);

			// Panel already closed: this Escape is not the picker's to consume.
			await userEvent.keyboard('{Escape}');
			expect(seenByPage).toEqual(['escape']);
		} finally {
			window.removeEventListener('keydown', listener);
		}
	});

	it('debounces live filtering by 250ms rather than filtering on every keystroke', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			render(TagPicker, { options, selected: [] });

			await fieldInput().element().focus();
			fieldInput().element().dispatchEvent(new Event('focus'));
			const input = fieldInput().element() as HTMLInputElement;
			input.value = 'Trav';
			input.dispatchEvent(new Event('input', { bubbles: true }));

			await vi.advanceTimersByTimeAsync(100);
			expect(page.getByRole('option', { name: 'Portugal' }).elements().length).toBe(1);

			await vi.advanceTimersByTimeAsync(200);
			expect(page.getByRole('option', { name: 'Portugal' }).elements().length).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('closes the panel when focus leaves the component, resetting aria-expanded', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.click(fieldInput());
		await expect.element(page.getByRole('listbox')).toBeInTheDocument();

		const outside = document.createElement('button');
		outside.textContent = 'outside';
		document.body.appendChild(outside);
		outside.focus();

		await expect.element(page.getByRole('listbox')).not.toBeInTheDocument();
		await expect.element(fieldInput()).toHaveAttribute('aria-expanded', 'false');
		outside.remove();
	});

	it('closes the panel on an outside click even when focus does not move', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.click(fieldInput());
		await expect.element(page.getByRole('listbox')).toBeInTheDocument();

		// A full click, not a pointer-down. The component deliberately waits for the click so that
		// the panel — which is in the layout flow — cannot close between a button's mouse-down and
		// mouse-up and move that button out from under the cursor. See the listener's own comment;
		// dispatching `pointerdown` here would pass against the version that had that bug.
		document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		await expect.element(page.getByRole('listbox')).not.toBeInTheDocument();
	});

	it('closes the panel once a tag is committed, but keeps it open when one is deselected', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.click(fieldInput());
		await userEvent.click(page.getByRole('option', { name: 'Portugal' }));

		// Closed on commit: detached, an open panel covers whatever sits below the field, and a click
		// on the panel does not dismiss it — so leaving it open strands the caller's own controls.
		await expect.element(page.getByRole('listbox')).not.toBeInTheDocument();

		// Deselecting is the opposite case and deliberately keeps the panel: the user is working
		// inside the list, and closing it under them would cost a keystroke to undo a mis-click.
		await userEvent.click(fieldInput());
		await userEvent.click(page.getByRole('option', { name: 'Portugal' }));
		await expect.element(page.getByRole('listbox')).toBeInTheDocument();
	});

	it('does not act on Enter after Escape has closed the panel', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.click(fieldInput());
		await userEvent.type(fieldInput(), 'Trav');
		await userEvent.keyboard('{Escape}');
		await userEvent.keyboard('{Enter}');

		expect(page.getByRole('button', { name: /Retirer l'étiquette/ }).elements().length).toBe(0);
		await expect.element(page.getByRole('listbox')).not.toBeInTheDocument();
	});

	it('bolds the matched substring anywhere in the name, not only a prefix', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.type(fieldInput(), 'ugal');

		const option = page.getByRole('option', { name: 'Portugal' });
		await expect.element(option).toBeInTheDocument();
		// 'Portugal' is present in the option list from the moment the panel opens, before the
		// 250ms debounce settles, so the getByRole match above can succeed off the pre-debounce
		// (unbolded) render — vi.waitFor keeps checking until the debounced, bolded markup lands.
		await vi.waitFor(() => {
			const strong = option.element().querySelector('strong');
			expect(strong?.textContent).toBe('ugal');
		});
		expect(option.element().textContent).toContain('Portugal');
	});

	it('pre-highlights the create row before Enter is pressed, matching what Enter will do', async () => {
		render(TagPicker, { options, selected: [] });

		await userEvent.type(fieldInput(), 'Réparation vélo');

		const createOption = page.getByRole('option', { name: 'Créer « Réparation vélo »' });
		await expect.element(createOption).toBeInTheDocument();
		expect(createOption.element().className).toContain('bg-zinc-100');
	});

	it('does not announce "aucune correspondance" when the typed name is already selected but stale in `options`, and renders no blank panel', async () => {
		// `selected` carries a name not present in `options` — e.g. a tag created and selected in
		// this same session, before the caller has refreshed `options` from the server. `filtered`
		// (derived from `options`) is then empty for this name, and `showCreateRow` also excludes
		// it (it's already selected), so `flatItems` is empty: the exact scenario the panel and
		// live region must not misreport as "no match, press Enter to create".
		render(TagPicker, { options: [options[0]], selected: ['Travaux'] });

		await userEvent.type(fieldInput(), 'Travaux');

		// The create row must not appear (it would offer to "create" an already-selected tag)...
		expect(page.getByText(/^Créer/).elements().length).toBe(0);
		// ...and Enter genuinely being a no-op must not be misreported as "Entrée pour créer".
		await vi.waitFor(() => {
			const live = document.querySelectorAll('[role="status"][aria-live="polite"]')[0];
			expect(live?.textContent).not.toContain('Entrée pour créer');
		});
		// No empty floating listbox either.
		await vi.waitFor(() => {
			expect(page.getByRole('listbox').elements().length).toBe(0);
		});
	});

	it('keeps aria-controls valid (pointing at an element that exists) while the list is loading', async () => {
		render(TagPicker, { options: [], selected: [], loading: true });

		await userEvent.click(fieldInput());

		const controls = fieldInput().element().getAttribute('aria-controls');
		expect(controls).toBeTruthy();
		expect(document.getElementById(controls!)).not.toBeNull();
	});

	it('keeps aria-controls valid while showing the "no tags yet" panel', async () => {
		render(TagPicker, { options: [], selected: [] });

		await userEvent.click(fieldInput());

		const controls = fieldInput().element().getAttribute('aria-controls');
		expect(controls).toBeTruthy();
		expect(document.getElementById(controls!)).not.toBeNull();
	});
});
