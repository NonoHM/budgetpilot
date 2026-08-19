import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../routes/layout.css';
import TransactionTagsEditor from './TransactionTagsEditor.svelte';
import type { ComponentProps } from 'svelte';
import type { SubmitFunction } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { MAX_TAGS_PER_TRANSACTION } from '$lib/domain/tags';

const allTags = [
	{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const },
	{ id: 'tag-2', name: 'Travaux', colorToken: 'ochre' as const }
];

/**
 * Where this editor posts is the PAGE's decision, not this component's, so every case supplies one.
 *
 * It used to write its own `action="?/saveTags"`, which resolves to `/transactions?/saveTags` and
 * is therefore the whole query string: the selection and the filters went with it and the panel
 * holding this editor was gone by the time the response rendered. The value below is deliberately
 * NOT the old literal, so a regression that reinstates a hard-coded action fails here rather than
 * agreeing with the fixture by coincidence.
 */
const ACTION = '/transactions?q=carrefour&selected=tx-42&/saveTags';
const SUBMIT: SubmitFunction =
	() =>
	async ({ update }) =>
		update({ reset: false });

type EditorProps = ComponentProps<typeof TransactionTagsEditor>;

function renderEditor(props: Omit<EditorProps, 'allTags' | 'action' | 'enhanceSubmit'>) {
	return render(TransactionTagsEditor, {
		allTags,
		action: ACTION,
		enhanceSubmit: SUBMIT,
		...props
	});
}

describe('TransactionTagsEditor.svelte', () => {
	it('pre-selects the transaction current tags as removable chips', async () => {
		renderEditor({
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }]
		});

		await expect
			.element(page.getByRole('button', { name: m.tags_remove_aria({ name: 'Portugal' }) }))
			.toBeInTheDocument();
	});

	it('carries the transaction id as a hidden field, and posts where the page says', async () => {
		const { container } = renderEditor({ transactionId: 'tx-42', tags: [] });

		const hidden = container.querySelector('input[name="transactionId"]') as HTMLInputElement;
		expect(hidden.value).toBe('tx-42');
		// Passed through unchanged. That the URL it is given actually carries the selection is the
		// page's claim and is asserted where the page builds it, in
		// routes/transactions/panel-form-actions.svelte.spec.ts.
		const form = container.querySelector('form') as HTMLFormElement;
		expect(form.getAttribute('action')).toBe(ACTION);
	});

	it('disables Save until the selection actually changes from what is saved', async () => {
		renderEditor({
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }]
		});

		const save = page.getByRole('button', { name: 'Enregistrer' });
		await expect.element(save).toBeDisabled();

		await userEvent.click(page.getByRole('combobox'));
		await userEvent.click(page.getByRole('option', { name: 'Travaux' }));

		await expect.element(save).toBeEnabled();
	});

	it('re-disables Save once the selection reverts back to what is saved', async () => {
		renderEditor({
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }]
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

	it('announces the server error when the action refuses, rather than only colouring it', async () => {
		// The catalogue's own sentence, called rather than retyped: a hard-coded copy asserts the
		// copy. `max` is the production constant for the same reason.
		const refusal = m.tags_error_too_many({ max: MAX_TAGS_PER_TRANSACTION });
		const { container } = renderEditor({ transactionId: 'tx-1', tags: [], error: refusal });

		await expect.element(page.getByText(refusal)).toBeInTheDocument();
		// `role="alert"`: the panel survives the submit now, so a refused save changes nothing else
		// on screen and this is the only thing separating it from one that worked.
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(refusal);
	});

	it('renders the static help line under the chip group when at least one chip is present', async () => {
		expect.assertions(2);
		renderEditor({
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }]
		});

		const help = page.getByText(m.tags_chips_help_remove());
		await expect.element(help).toBeInTheDocument();
		// Read in document order, for sighted and screen-reader users alike — never a silent
		// aria-hidden echo the way the overflow tooltip is deliberately allowed to be.
		expect(help.element().closest('[aria-hidden="true"]')).toBeNull();
	});

	it('renders no help line when there are no chips, symmetrically with the group itself', async () => {
		expect.assertions(1);
		renderEditor({ transactionId: 'tx-1', tags: [] });

		expect(page.getByText(m.tags_chips_help_remove()).elements().length).toBe(0);
	});

	/**
	 * The load re-running is not the same event as a different row being selected, and it stopped
	 * being the same event when the panel's forms gained `use:enhance`.
	 *
	 * A save in a SIBLING form (manual category, manual nature, répartition) now re-runs the load
	 * while this editor stays mounted, and hands it a fresh `tags` array saying exactly what the old
	 * one said. Re-deriving there discards a chip the user picked and has not saved, with no dialog
	 * and no banner, and flips `dirty` back to false so the page's own unsaved-changes guard no
	 * longer knows anything was lost. Measured at 1280 before this: chip present, save the nature in
	 * the section above, chip gone.
	 */
	it('keeps an unsaved selection when the load re-runs and says the same thing', async () => {
		const tags = [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }];
		const { rerender } = renderEditor({ transactionId: 'tx-1', tags });

		await userEvent.click(page.getByRole('combobox'));
		await userEvent.click(page.getByRole('option', { name: 'Travaux' }));
		const chip = page.getByRole('button', { name: m.tags_remove_aria({ name: 'Travaux' }) });
		await expect.element(chip).toBeInTheDocument();

		// A FRESH array carrying the same names, which is what the load hands down: equal by value,
		// different by identity, and identity is what the old derivation keyed on.
		await rerender({
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }],
			allTags,
			action: ACTION,
			enhanceSubmit: SUBMIT
		});

		await expect.element(chip).toBeInTheDocument();
	});

	it('takes the new tags when the load says something different', async () => {
		const { rerender } = renderEditor({
			transactionId: 'tx-1',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }]
		});

		// The other half, and the reason the case above is not simply "never re-derive": a save that
		// succeeded, or another tab, must reach this editor.
		await rerender({
			transactionId: 'tx-1',
			tags: [{ id: 'tag-2', name: 'Travaux', colorToken: 'ochre' as const }],
			allTags,
			action: ACTION,
			enhanceSubmit: SUBMIT
		});

		await expect
			.element(page.getByRole('button', { name: m.tags_remove_aria({ name: 'Travaux' }) }))
			.toBeInTheDocument();
		expect(
			page.getByRole('button', { name: m.tags_remove_aria({ name: 'Portugal' }) }).elements()
		).toHaveLength(0);
	});

	it('resets when a different row is selected, even if that row carries the same tags', async () => {
		const tags = [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }];
		const { rerender } = renderEditor({ transactionId: 'tx-1', tags });

		await userEvent.click(page.getByRole('combobox'));
		await userEvent.click(page.getByRole('option', { name: 'Travaux' }));
		await expect
			.element(page.getByRole('button', { name: m.tags_remove_aria({ name: 'Travaux' }) }))
			.toBeInTheDocument();

		// Same tag set, different transaction. An editor opened on one row must not be found open on
		// the next, which is the rule the identity check used to enforce by accident.
		await rerender({
			transactionId: 'tx-2',
			tags: [{ id: 'tag-1', name: 'Portugal', colorToken: 'clay' as const }],
			allTags,
			action: ACTION,
			enhanceSubmit: SUBMIT
		});

		expect(
			page.getByRole('button', { name: m.tags_remove_aria({ name: 'Travaux' }) }).elements()
		).toHaveLength(0);
	});
});
