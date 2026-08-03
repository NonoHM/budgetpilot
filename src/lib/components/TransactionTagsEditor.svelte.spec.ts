import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../routes/layout.css';
import TransactionTagsEditor from './TransactionTagsEditor.svelte';
import * as m from '$lib/paraglide/messages';

const allTags = [
	{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const },
	{ id: 'tag-2', name: 'Travaux', colorToken: 'ochre' as const }
];

describe('TransactionTagsEditor.svelte', () => {
	it('pre-selects the transaction current tags as removable chips', async () => {
		render(TransactionTagsEditor, {
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }],
			allTags
		});

		await expect
			.element(page.getByRole('button', { name: m.tags_remove_aria({ name: 'Portugal' }) }))
			.toBeInTheDocument();
	});

	it('carries the transaction id as a hidden field for the saveTags action', async () => {
		const { container } = render(TransactionTagsEditor, {
			transactionId: 'tx-42',
			tags: [],
			allTags
		});

		const hidden = container.querySelector('input[name="transactionId"]') as HTMLInputElement;
		expect(hidden.value).toBe('tx-42');
		const form = container.querySelector('form') as HTMLFormElement;
		expect(form.getAttribute('action')).toBe('?/saveTags');
	});

	it('disables Save until the selection actually changes from what is saved', async () => {
		render(TransactionTagsEditor, {
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }],
			allTags
		});

		const save = page.getByRole('button', { name: 'Enregistrer' });
		await expect.element(save).toBeDisabled();

		await userEvent.click(page.getByRole('combobox'));
		await userEvent.click(page.getByRole('option', { name: 'Travaux' }));

		await expect.element(save).toBeEnabled();
	});

	it('re-disables Save once the selection reverts back to what is saved', async () => {
		render(TransactionTagsEditor, {
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }],
			allTags
		});

		const save = page.getByRole('button', { name: 'Enregistrer' });
		await userEvent.click(page.getByRole('combobox'));
		await userEvent.click(page.getByRole('option', { name: 'Travaux' }));
		await expect.element(save).toBeEnabled();

		await userEvent.click(
			page.getByRole('button', { name: m.tags_remove_aria({ name: 'Travaux' }) })
		);
		await expect.element(save).toBeDisabled();
	});

	it('shows the server error message when the action refuses', async () => {
		render(TransactionTagsEditor, {
			transactionId: 'tx-1',
			tags: [],
			allTags,
			error: 'Maximum 10 étiquettes par transaction.'
		});

		await expect
			.element(page.getByText('Maximum 10 étiquettes par transaction.'))
			.toBeInTheDocument();
	});

	it('renders the static help line under the chip group when at least one chip is present', async () => {
		expect.assertions(2);
		render(TransactionTagsEditor, {
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }],
			allTags
		});

		const help = page.getByText(m.tags_chips_help_remove());
		await expect.element(help).toBeInTheDocument();
		// Read in document order, for sighted and screen-reader users alike — never a silent
		// aria-hidden echo the way the overflow tooltip is deliberately allowed to be.
		expect(help.element().closest('[aria-hidden="true"]')).toBeNull();
	});

	it('renders no help line when there are no chips, symmetrically with the group itself', async () => {
		expect.assertions(1);
		render(TransactionTagsEditor, { transactionId: 'tx-1', tags: [], allTags });

		expect(page.getByText(m.tags_chips_help_remove()).elements().length).toBe(0);
	});
});
