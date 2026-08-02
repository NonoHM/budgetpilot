import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import TagChips from './TagChips.svelte';

const three = [
	{ key: 't1', name: 'Portugal', colorToken: 'tag-1' as const },
	{ key: 't2', name: 'Remboursement Paul', colorToken: 'tag-2' as const },
	{ key: 't3', name: 'Pro', colorToken: 'tag-3' as const }
];

describe('TagChips.svelte', () => {
	it('always writes the name, so colour never carries information alone', async () => {
		render(TagChips, { tags: [three[0]] });

		await expect.element(page.getByText('Portugal')).toBeInTheDocument();
	});

	it('shows at most two tags by default and collapses the rest as +N', async () => {
		render(TagChips, { tags: three });

		await expect.element(page.getByText('Portugal')).toBeInTheDocument();
		await expect.element(page.getByText('Remboursement Paul')).toBeInTheDocument();
		expect(page.getByText('Pro').elements().length).toBe(0);
		// The button's accessible name is its full aria-label (asserted separately below); its
		// visible text content is the short "+1" glyph, checked here via textContent.
		await expect
			.element(page.getByRole('button', { name: /1 étiquette de plus/ }))
			.toHaveTextContent('+1');
	});

	it('names the hidden tags in the overflow button aria-label so nothing is lost', async () => {
		render(TagChips, { tags: three });

		await expect
			.element(page.getByRole('button', { name: /1 étiquette de plus : Pro/ }))
			.toBeInTheDocument();
	});

	it('pluralises the overflow aria-label when more than one tag is hidden', async () => {
		render(TagChips, { tags: three, max: 1 });

		await expect
			.element(
				page.getByRole('button', {
					name: '2 étiquettes de plus : Remboursement Paul, Pro'
				})
			)
			.toBeInTheDocument();
	});

	it('renders no overflow marker when everything fits', async () => {
		render(TagChips, { tags: [three[0], three[1]] });

		expect(page.getByRole('button').elements().length).toBe(0);
	});

	it('carries the palette background class on the dot, not on the whole chip', async () => {
		const { container } = render(TagChips, { tags: [three[0]] });

		const dot = container.querySelector('.bg-\\[\\#9f4949\\]');
		expect(dot).toBeTruthy();
		// A dot, not a filled block: two colour blocks on one row are unreadable, two dots are not.
		expect(dot?.textContent).toBe('');
	});

	it('offers a remove control only in the enclosed variant, and only when onRemove is given', async () => {
		const onRemove = vi.fn();

		const plain = render(TagChips, { tags: [three[0]], onRemove, variant: 'plain' });
		expect(plain.container.querySelectorAll('button[aria-label^="Retirer"]').length).toBe(0);
		plain.unmount();

		const enclosedNoRemove = render(TagChips, { tags: [three[0]], variant: 'enclosed' });
		expect(
			enclosedNoRemove.container.querySelectorAll('button[aria-label^="Retirer"]').length
		).toBe(0);
		enclosedNoRemove.unmount();

		render(TagChips, { tags: [three[0]], onRemove, variant: 'enclosed' });
		await expect
			.element(page.getByRole('button', { name: "Retirer l'étiquette Portugal" }))
			.toBeInTheDocument();
	});

	it('calls onRemove with the tag key when the remove control is activated', async () => {
		const onRemove = vi.fn();
		render(TagChips, { tags: [three[0]], onRemove, variant: 'enclosed' });

		await userEvent.click(page.getByRole('button', { name: "Retirer l'étiquette Portugal" }));

		expect(onRemove).toHaveBeenCalledExactlyOnceWith('t1');
	});

	it('shows every tag when removal is offered, so a hidden tag cannot be unremovable', async () => {
		render(TagChips, { tags: three, onRemove: vi.fn(), variant: 'enclosed' });

		await expect.element(page.getByText('Pro')).toBeInTheDocument();
		expect(page.getByRole('button', { name: /^\+/ }).elements().length).toBe(0);
	});

	it('renders nothing at all for an empty list', async () => {
		const { container } = render(TagChips, { tags: [] });

		expect(container.textContent?.trim()).toBe('');
	});

	it('renders a neutral zinc dot for a tag with no colour yet, never guessing one', async () => {
		// TagPicker's pending-create case: the colour derives from nameKey, a server-side digest,
		// so the client genuinely does not know it until the row exists.
		const { container } = render(TagChips, {
			tags: [{ key: 'Nouveau', name: 'Nouveau', colorToken: null }]
		});

		expect(container.querySelector('.bg-zinc-300')).toBeTruthy();
		await expect.element(page.getByText('Nouveau')).toBeInTheDocument();
	});

	it('marks a pending (in-flight creation) chip with a dashed border, a zinc-400 dot and a spinner', async () => {
		const { container } = render(TagChips, {
			tags: [{ key: 'Réparation vélo', name: 'Réparation vélo', colorToken: null, pending: true }],
			variant: 'enclosed'
		});

		expect(container.querySelector('.border-dashed')).toBeTruthy();
		expect(container.querySelector('.bg-zinc-400')).toBeTruthy();
		expect(container.querySelector('[data-testid="tag-chip-spinner"]')).toBeTruthy();
	});

	it('groups the chips in a list with an accessible name, absent entirely when there are no tags', async () => {
		const populated = render(TagChips, { tags: [three[0]] });
		await expect.element(page.getByRole('list', { name: 'Étiquettes' })).toBeInTheDocument();
		populated.unmount();

		const empty = render(TagChips, { tags: [] });
		expect(empty.container.querySelector('ul')).toBeNull();
	});
});
