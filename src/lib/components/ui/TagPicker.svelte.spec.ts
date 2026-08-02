import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import TagPicker from './TagPicker.svelte';

const options = [
	{ id: 'o1', name: 'Portugal', colorToken: 'tag-1' as const },
	{ id: 'o2', name: 'Travaux', colorToken: 'tag-2' as const }
];

function fieldInput() {
	return page.getByRole('combobox');
}

describe('TagPicker.svelte', () => {
	it('lists existing tags with their colour dots when opened', async () => {
		render(TagPicker, { options, selected: [] });

		await fieldInput().element().focus();

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
		const accented = [{ id: 'o3', name: 'Café clients', colorToken: 'tag-3' as const }];
		render(TagPicker, { options: accented, selected: [] });

		await userEvent.type(fieldInput(), 'cafe clients');

		await expect.element(page.getByRole('option', { name: 'Café clients' })).toBeInTheDocument();
		expect(page.getByText(/^Créer/).elements().length).toBe(0);
	});

	it('adds a selection without closing, so several tags can be picked in one pass', async () => {
		render(TagPicker, { options, selected: [] });

		await fieldInput().element().focus();
		await userEvent.click(page.getByRole('option', { name: 'Portugal' }));
		// Still open: the second option is still there to pick, and the field is still focused.
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
		render(TagPicker, { options: [], selected: many });

		await userEvent.type(fieldInput(), 'Une de plus');
		await userEvent.keyboard('{Enter}');

		await expect.element(page.getByText('Limite de 10 étiquettes atteinte.')).toBeInTheDocument();
		const { container } = render(TagPicker, { options: [], selected: many, name: 'tagNames' });
		const hidden = container.querySelector('input[type="hidden"][name="tagNames"]');
		expect((hidden as HTMLInputElement).value.split('\n')).toHaveLength(10);
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

		await fieldInput().element().focus();
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
});
