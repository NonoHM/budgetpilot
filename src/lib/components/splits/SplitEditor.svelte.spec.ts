import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SplitEditor from './SplitEditor.svelte';

const OPTIONS = [
	{ value: 'cat-alimentation', label: 'Alimentation' },
	{ value: 'cat-maison', label: 'Maison' },
	{ value: 'cat-transport', label: 'Transport' }
];

const EXPENSE = -8_000;

function base(overrides: Record<string, unknown> = {}) {
	return {
		transactionId: 'tx-1',
		amountCents: EXPENSE,
		parentCategoryId: 'cat-alimentation',
		categoryOptions: OPTIONS,
		existingParts: null,
		...overrides
	};
}

const SPLIT_60_20 = [
	{ categoryId: 'cat-alimentation', amountCents: -6_000, note: '' },
	{ categoryId: 'cat-maison', amountCents: -2_000, note: '' }
];

function save() {
	return page.getByRole('button', { name: 'Enregistrer' }).element();
}

function amountOf(position: number) {
	return page.getByLabelText(`Montant de la part ${position}`).element() as HTMLInputElement;
}

describe('SplitEditor — creation (1j-A)', () => {
	it('opens at the whole amount, with part 1 inheriting the parent and part 2 empty', async () => {
		render(SplitEditor, base());

		// « Le reste démarre à 80,00 €, le montant entier. C'est la leçon en un coup d'œil. »
		expect(document.body.textContent).toContain('Reste à répartir');
		expect(amountOf(1).value).toBe('0,00');
		expect(amountOf(2).value).toBe('0,00');
		// Two parts, so both crosses are already at the floor from the first second.
		expect(
			page
				.getByRole('button', { name: 'Retirer la part 1' })
				.element()
				.getAttribute('aria-disabled')
		).toBe('true');
	});

	it('offers the way OUT in the floor sentence, not just the refusal', async () => {
		// 1f: « Qui clique sur la deuxième croix ne veut pas une part de moins, il veut sortir. »
		render(SplitEditor, base());
		expect(document.body.textContent).toContain('Une répartition compte au moins 2 parts.');
		await expect
			.element(page.getByRole('button', { name: 'Retirer la répartition' }))
			.toBeInTheDocument();
	});
});

describe('SplitEditor — the one-reason-location law (1q)', () => {
	it('points a remainder-blocked Save at the HIDDEN REGION, never into the aria-hidden band', async () => {
		// The rule that must not be re-broken: an `aria-hidden` element takes its descendants out of
		// the accessibility tree, so a describedby aimed into the band exposes nothing.
		render(SplitEditor, base({ existingParts: SPLIT_60_20 }));
		await userEvent.fill(amountOf(2), '10,00');

		await expect.poll(() => save().getAttribute('aria-disabled')).toBe('true');
		const target = save().getAttribute('aria-describedby');
		expect(target).toBeTruthy();

		const described = document.getElementById(target as string);
		expect(described).not.toBeNull();
		expect(described?.getAttribute('role')).toBe('status');
		expect(described?.closest('[aria-hidden="true"]')).toBeNull();
	});

	it('points a non-arithmetic refusal at the reason LINE instead — one location, never both', async () => {
		// 1j-B: remainder at zero and Save still off, because nothing changed. That is not an
		// exception to the promise, it is the second reason location.
		render(SplitEditor, base({ existingParts: SPLIT_60_20 }));

		await expect.poll(() => save().getAttribute('aria-disabled')).toBe('true');
		const target = save().getAttribute('aria-describedby');
		const described = document.getElementById(target as string);
		expect(described?.textContent).toContain('Modifiez la répartition pour enregistrer.');
		// Not the live region: the cause is not a number.
		expect(described?.getAttribute('role')).not.toBe('status');
	});

	it('names EVERY part the server refused, not the first', async () => {
		// What settles 1r's own open question. `replaceSplits` returns 0-based positions for every
		// failing part, so the panel can say « la part 2, 3 » rather than degrade to a generic
		// message — which 1r calls a real degradation.
		render(
			SplitEditor,
			base({
				existingParts: [...SPLIT_60_20, { categoryId: 'cat-transport', amountCents: 0, note: '' }],
				conflictPositions: [1, 2]
			})
		);
		expect(document.body.textContent).toContain('la part 2, 3');
	});
});

describe('SplitEditor — floor and ceiling (1f)', () => {
	it('keeps the add button VISIBLE and mute at the ceiling, never removed', async () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			categoryId: OPTIONS[i % 3].value,
			amountCents: -400,
			note: ''
		}));
		render(SplitEditor, base({ existingParts: many }));

		const add = page.getByRole('button', { name: 'Ajouter une part' }).element();
		// « Sa disparition serait un mystère de plus à résoudre. »
		expect(add).toBeTruthy();
		expect(add.getAttribute('aria-disabled')).toBe('true');
		expect(add.hasAttribute('disabled')).toBe(false);
		const hint = document.getElementById(add.getAttribute('aria-describedby') as string);
		expect(hint?.textContent).toContain("20 parts, c'est le maximum.");
	});

	it('adds a part, which lifts the floor and reactivates the crosses', async () => {
		render(SplitEditor, base({ existingParts: SPLIT_60_20 }));
		await userEvent.click(page.getByRole('button', { name: 'Ajouter une part' }));

		await expect
			.poll(() =>
				page
					.getByRole('button', { name: 'Retirer la part 1' })
					.element()
					.getAttribute('aria-disabled')
			)
			.toBeNull();
	});
});

describe('SplitEditor — « Répartir également » (1e)', () => {
	it('redistributes every amount, and gives the extra cent to part 1 with a mention', async () => {
		render(SplitEditor, base({ amountCents: -10_000 }));
		await userEvent.click(page.getByRole('button', { name: 'Ajouter une part' }));
		await userEvent.click(page.getByRole('button', { name: 'Répartir également' }));

		await expect.poll(() => amountOf(1).value).toBe('33,34');
		expect(amountOf(2).value).toBe('33,33');
		expect(amountOf(3).value).toBe('33,33');
		expect(document.body.textContent).toContain("centime d'arrondi");
	});

	it('says nothing when the division is even — there is nothing to explain', async () => {
		render(SplitEditor, base());
		await userEvent.click(page.getByRole('button', { name: 'Répartir également' }));

		await expect.poll(() => amountOf(1).value).toBe('40,00');
		expect(document.body.textContent).not.toContain("centime d'arrondi");
	});

	it('drops the mention as soon as an amount is edited — it explained a gesture', async () => {
		render(SplitEditor, base({ amountCents: -10_000 }));
		await userEvent.click(page.getByRole('button', { name: 'Ajouter une part' }));
		await userEvent.click(page.getByRole('button', { name: 'Répartir également' }));
		await expect.poll(() => document.body.textContent).toContain("centime d'arrondi");

		await userEvent.fill(amountOf(2), '33,00');
		await expect.poll(() => document.body.textContent?.includes("centime d'arrondi")).toBe(false);
	});

	it('refuses a distribution that would produce a zero part', async () => {
		// `replaceSplits` refuses a zero part, so the button must not offer one.
		render(SplitEditor, base({ amountCents: -1 }));
		expect(
			page
				.getByRole('button', { name: 'Répartir également' })
				.element()
				.getAttribute('aria-disabled')
		).toBe('true');
	});
});

describe('SplitEditor — deferred removal (1j-C)', () => {
	it('states the intention, offers the way back, and switches the form to clear', async () => {
		render(SplitEditor, base({ existingParts: SPLIT_60_20 }));
		await userEvent.click(page.getByRole('button', { name: 'Retirer la répartition' }));

		await expect
			.poll(() => document.body.textContent)
			.toContain('La répartition en 2 parts sera retirée');
		await expect
			.element(page.getByRole('button', { name: 'Annuler le retrait' }))
			.toBeInTheDocument();

		const intent = document.querySelector('input[name="splitIntent"]') as HTMLInputElement;
		expect(intent.value).toBe('clear');
		// Save is available: removal IS the change.
		expect(save().getAttribute('aria-disabled')).toBeNull();
	});

	it('undoes the removal without a dialog, restoring the parts untouched', async () => {
		// « Le modèle différé garde les parts en mémoire jusqu'à l'enregistrement, donc il n'a rien à
		// promettre. » No ConfirmDialog anywhere in this flow.
		render(SplitEditor, base({ existingParts: SPLIT_60_20 }));
		await userEvent.click(page.getByRole('button', { name: 'Retirer la répartition' }));
		await userEvent.click(page.getByRole('button', { name: 'Annuler le retrait' }));

		await expect.poll(() => amountOf(1).value).toBe('60,00');
		expect(amountOf(2).value).toBe('20,00');
		const intent = document.querySelector('input[name="splitIntent"]') as HTMLInputElement;
		expect(intent.value).toBe('replace');
	});
});

describe('SplitEditor — the form the action reads', () => {
	it('emits three parallel fields per part, always the same length', async () => {
		// The action identifies a part by the ALIGNMENT of three lists. A row that contributed a
		// category and no note would shift every later note by one and file a comment against the
		// wrong money, so all three are rendered unconditionally.
		render(SplitEditor, base({ existingParts: SPLIT_60_20 }));

		expect(document.querySelectorAll('input[name="splitCategoryId"]').length).toBe(2);
		expect(document.querySelectorAll('input[name="splitAmount"]').length).toBe(2);
		expect(document.querySelectorAll('input[name="splitNote"]').length).toBe(2);
	});
});
