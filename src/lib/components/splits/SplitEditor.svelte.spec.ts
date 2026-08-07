import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SplitEditor from './SplitEditor.svelte';
// The app's stylesheet, without which every geometry reading in this file is a UA default: a 44px
// control measured 24. Imported for the band's non-movement assertion, and it makes every other
// measurement here mean what it says too.
import '../../../routes/layout.css';
// The message FUNCTION, never a retyped sentence: this spec runs in French through the client
// setup's cookie while the catalogue is the authority on what it says.
import * as m from '$lib/paraglide/messages';

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
		// Caller-owned: the parent selector it explains lives outside this component, and the page
		// renders both together twice at once. See the prop's own comment.
		parentLockId: 'parent-lock-1',
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

/**
 * Focus, design 1p: « Retirer une part rend le focus à la croix de la part suivante, ou à
 * "Ajouter une part" s'il n'y en a plus après. Ajouter une part met le focus sur son sélecteur de
 * catégorie. »
 *
 * Not a nicety. Removing a row destroys the element that had focus, and a browser left to itself
 * sends focus to `<body>` — which for a keyboard user means the next Tab restarts from the top of
 * the document, one row further from where they were working with every removal.
 */
describe('SplitEditor — focus after add and remove (1p)', () => {
	const THREE_PARTS = [
		{ categoryId: 'cat-alimentation', amountCents: -4_800, note: '' },
		{ categoryId: 'cat-maison', amountCents: -2_000, note: '' },
		{ categoryId: 'cat-transport', amountCents: -1_200, note: '' }
	];

	it('sends focus to the NEXT part’s cross, which is the one that takes the removed row’s place', async () => {
		render(SplitEditor, base({ existingParts: THREE_PARTS }));

		// Removing part 2 of 3: the row that was part 3 becomes part 2, and its cross is where the
		// eye already is. Asserting on the LABEL rather than on an element captured beforehand is
		// deliberate — a stale reference would compare against a detached element and pass for the
		// wrong reason.
		//
		// WHAT THIS TEST CAN AND CANNOT SEE, measured by breaking the source rather than assumed.
		// Deleting the focus call from `removePart` ENTIRELY leaves this test green: `{#each ...
		// (index)}` keys rows by position, so the button node is reused and focus never left it.
		// Swapping the two branches DOES turn it red. So this assertion distinguishes wrong focus
		// management from right focus management, and cannot distinguish absent from right — the
		// explicit call is what makes the behaviour a decision instead of a property of the key,
		// and the day that each block is keyed by anything else, this is the test that reports it.
		await userEvent.click(page.getByRole('button', { name: 'Retirer la part 2' }));

		await expect
			.poll(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label'))
			.toBe('Retirer la part 2');
		// And it really is the transport row that survived, not the maison one.
		expect(amountOf(2).value).toBe('12,00');
	});

	it('sends focus to « Ajouter une part » when the removed row was the last', async () => {
		render(SplitEditor, base({ existingParts: THREE_PARTS }));

		await userEvent.click(page.getByRole('button', { name: 'Retirer la part 3' }));

		await expect
			.poll(() => (document.activeElement as HTMLElement | null)?.textContent?.trim())
			.toBe('Ajouter une part');
	});

	it('sends focus to the new part’s category selector when one is added', async () => {
		render(SplitEditor, base({ existingParts: SPLIT_60_20 }));

		await userEvent.click(page.getByRole('button', { name: 'Ajouter une part' }));

		await expect
			.poll(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label'))
			.toBe('Catégorie de la part 3');
	});
});

/**
 * 1r, the tab-return half: a category one of the draft's parts uses is deleted in another window.
 *
 * The editor detects it by COMPARING ITS DRAFT AGAINST THE OPTIONS IT IS CURRENTLY HANDED, so the
 * same derivation covers both moments 1r names — the options change on tab return because the load
 * re-runs, and they change on the save response for the same reason. No polling is introduced, and
 * there is no second code path for the second moment.
 */
describe('SplitEditor — a category deleted in another window (1r)', () => {
	const OPTIONS_WITH_GIFTS = [...OPTIONS, { value: 'cat-cadeaux', label: 'Cadeaux' }];
	const SPLIT_WITH_GIFTS = [
		{ categoryId: 'cat-alimentation', amountCents: -6_000, note: '' },
		{ categoryId: 'cat-cadeaux', amountCents: -2_000, note: 'Anniversaire Léa' }
	];

	it('keeps the lost NAME written, keeps the work, and moves Save’s reason to the reason line', async () => {
		// Appear-then-disappear: the row is rendered NORMAL first, with the category present and no
		// warning anywhere, and only then is the option withdrawn. Asserting the warning's presence
		// on a first render would pass on a component that always warns.
		const { rerender } = render(
			SplitEditor,
			base({ categoryOptions: OPTIONS_WITH_GIFTS, existingParts: SPLIT_WITH_GIFTS })
		);
		await expect.element(page.getByText('Cadeaux, supprimée')).not.toBeInTheDocument();

		await rerender(base({ categoryOptions: OPTIONS, existingParts: SPLIT_WITH_GIFTS }));

		// « Le nom perdu reste écrit. Vider le champ effacerait la seule chose qui permet de
		// retrouver quelle catégorie choisir à la place. »
		await expect.element(page.getByText('Cadeaux, supprimée')).toBeInTheDocument();

		// « Le montant et la note de la part sont conservés. C'est la catégorie qui a disparu, pas
		// le travail. »
		expect(amountOf(2).value).toBe('20,00');
		expect((page.getByLabelText('Note de la part 2').element() as HTMLInputElement).value).toBe(
			'Anniversaire Léa'
		);

		// « Le reste vaut toujours zéro, donc le bandeau ne peut pas porter cette raison. Elle va
		// dans la ligne de raison sous le bouton. » One reason location, and it is not the band.
		expect(save().getAttribute('aria-disabled')).toBe('true');
		const describedBy = save().getAttribute('aria-describedby');
		const reason = document.getElementById(describedBy ?? '');
		expect(reason?.textContent?.trim()).toBe(m.splits_reason_conflict({ positions: '2' }));
		expect(reason?.closest('[aria-hidden="true"]')).toBeNull();
	});

	it('names EVERY affected part, never only the first', async () => {
		const twoLost = [
			{ categoryId: 'cat-cadeaux', amountCents: -6_000, note: '' },
			{ categoryId: 'cat-voyage', amountCents: -2_000, note: '' }
		];
		const withBoth = [
			...OPTIONS,
			{ value: 'cat-cadeaux', label: 'Cadeaux' },
			{ value: 'cat-voyage', label: 'Voyage' }
		];
		const { rerender } = render(
			SplitEditor,
			base({ categoryOptions: withBoth, existingParts: twoLost })
		);
		await rerender(base({ categoryOptions: OPTIONS, existingParts: twoLost }));

		const reason = document.getElementById(save().getAttribute('aria-describedby') ?? '');
		expect(reason?.textContent?.trim()).toBe(m.splits_reason_conflict({ positions: '1, 2' }));
	});

	it('blocks Save even when the draft is otherwise complete AND dirty', async () => {
		// FOUND BY BREAK-CHECK, and the test exists because the obvious one does not do this job:
		// on an untouched répartition Save is already off for « rien n'a changé », so deleting the
		// conflict clause from `canSave` left the whole suite green. The draft here is dirty (the
		// note was edited), the remainder is zero, and every part carries a category id — so the
		// ONLY thing that can still hold Save is the conflict.
		const { rerender } = render(
			SplitEditor,
			base({ categoryOptions: OPTIONS_WITH_GIFTS, existingParts: SPLIT_WITH_GIFTS })
		);
		const note = page.getByLabelText('Note de la part 2');
		await userEvent.fill(note, 'Anniversaire de Léa');
		await expect.poll(() => save().getAttribute('aria-disabled')).toBeNull();

		await rerender(base({ categoryOptions: OPTIONS, existingParts: SPLIT_WITH_GIFTS }));

		await expect.poll(() => save().getAttribute('aria-disabled')).toBe('true');
	});

	it('says nothing about a part whose category was simply never chosen', async () => {
		// An empty selector is « choisissez une catégorie pour chaque part », not « cette catégorie a
		// été supprimée ». Conflating them would report a deletion that never happened on the most
		// ordinary state there is: a freshly added row.
		render(SplitEditor, base());

		const reason = document.getElementById(save().getAttribute('aria-describedby') ?? '');
		expect(reason?.textContent?.trim()).toBe(m.splits_reason_missing_category());
		expect(document.body.textContent).not.toContain('supprimée');
	});
});

/**
 * The saving state, design 1i: « les champs passent en aria-disabled et non disabled : le focus ne
 * s'évapore pas sous les doigts si la requête traîne. Le bandeau de reste ne bouge pas, il vient
 * d'être la condition du clic. »
 */
describe('SplitEditor — saving (1i)', () => {
	it('neutralises every field without taking one out of the tab order', async () => {
		const { rerender } = render(SplitEditor, base({ existingParts: SPLIT_60_20 }));

		// Live first, with the same selectors: a locked-field assertion that never saw the fields
		// live passes on a component that renders none.
		expect(amountOf(1).readOnly).toBe(false);
		await rerender(base({ existingParts: SPLIT_60_20, saving: true }));

		for (const position of [1, 2]) {
			const amount = amountOf(position);
			expect(amount.readOnly).toBe(true);
			expect(amount.getAttribute('aria-disabled')).toBe('true');
			expect(amount.hasAttribute('disabled')).toBe(false);
			// 1q: neutralised, never mute — and exactly one explanation each.
			const describedBy = amount.getAttribute('aria-describedby');
			expect(document.getElementById(describedBy ?? '')?.textContent?.trim()).toBe(
				m.splits_saving_hint()
			);

			const category = page
				.getByLabelText(m.splits_part_category_aria({ position }))
				.element() as HTMLInputElement;
			expect(category.getAttribute('aria-disabled')).toBe('true');
			expect(category.hasAttribute('disabled')).toBe(false);

			const cross = page
				.getByRole('button', { name: m.splits_part_remove_aria({ position }) })
				.element();
			expect(cross.getAttribute('aria-disabled')).toBe('true');
			expect(cross.hasAttribute('disabled')).toBe(false);
		}
	});

	it('does not move the remainder band, which was the condition of the click', async () => {
		// Relational and measured: the band's box before the save and during it, in the same render
		// tree. « Le bandeau de reste ne bouge pas. » A band that shifted would move the button the
		// user just pressed, mid-request.
		const { rerender } = render(SplitEditor, base({ existingParts: SPLIT_60_20 }));
		const band = () =>
			(
				Array.from(document.querySelectorAll('[aria-hidden="true"]')).find((el) =>
					el.textContent?.includes(m.splits_remainder_label_zero())
				) as HTMLElement
			).getBoundingClientRect();

		const before = band();
		await rerender(base({ existingParts: SPLIT_60_20, saving: true }));
		const during = band();

		expect(during.height).toBe(before.height);
		expect(during.top).toBe(before.top);
	});

	it('says the save is in flight on the button itself', async () => {
		render(SplitEditor, base({ existingParts: SPLIT_60_20, saving: true }));
		await expect
			.element(page.getByRole('button', { name: m.splits_saving_label() }))
			.toBeInTheDocument();
	});
});
