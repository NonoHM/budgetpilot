import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SplitPartRow from './SplitPartRow.svelte';

const OPTIONS = [
	{ value: 'cat-alimentation', label: 'Alimentation' },
	{ value: 'cat-maison', label: 'Maison' }
];

function base(overrides: Record<string, unknown> = {}) {
	return {
		position: 1,
		categoryId: 'cat-alimentation',
		amount: '60,00',
		note: '',
		categoryOptions: OPTIONS,
		onRemove: vi.fn<() => void>(),
		...overrides
	};
}

describe('SplitPartRow — naming', () => {
	it('carries the position in every field’s accessible name, and hides the visible number', async () => {
		// 1p: « La position est dans le nom accessible, ce qui rend le numéro visible purement
		// décoratif. » A screen reader that heard "2" from the number AND from each field would say it
		// three times per row.
		render(SplitPartRow, base({ position: 2, categoryId: 'cat-maison' }));

		await expect
			.element(page.getByRole('combobox', { name: 'Catégorie de la part 2' }))
			.toBeInTheDocument();
		await expect.element(page.getByLabelText('Montant de la part 2')).toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Retirer la part 2' }))
			.toBeInTheDocument();

		const visibleNumber = Array.from(document.querySelectorAll('span')).find(
			(el) => el.textContent?.trim() === '2'
		);
		expect(visibleNumber?.getAttribute('aria-hidden')).toBe('true');
	});
});

describe('SplitPartRow — the floor (1f)', () => {
	it('neutralises the cross with aria-disabled and a reason, never native disabled', async () => {
		render(SplitPartRow, base({ removeSoftDisabled: true, removeHintId: 'floor-sentence' }));

		const cross = page.getByRole('button', { name: 'Retirer la part 1' }).element();
		expect(cross.getAttribute('aria-disabled')).toBe('true');
		expect(cross.hasAttribute('disabled')).toBe(false);
		// 1q: a neutralised control that cannot state its reason is not neutralised, it is mute.
		expect(cross.getAttribute('aria-describedby')).toBe('floor-sentence');
	});

	it('does not remove the part while neutralised', async () => {
		const onRemove = vi.fn<() => void>();
		render(SplitPartRow, base({ removeSoftDisabled: true, removeHintId: 'floor', onRemove }));

		// Clicked directly rather than through userEvent: Playwright treats aria-disabled as
		// not-enabled and would wait forever, while a programmatic or assistive-technology
		// activation reaches the handler — which is why the swallow has to exist.
		(page.getByRole('button', { name: 'Retirer la part 1' }).element() as HTMLElement).click();
		expect(onRemove).not.toHaveBeenCalled();
	});

	it('removes normally when it is not at the floor', async () => {
		const onRemove = vi.fn<() => void>();
		render(SplitPartRow, base({ onRemove }));
		await userEvent.click(page.getByRole('button', { name: 'Retirer la part 1' }));
		expect(onRemove).toHaveBeenCalledTimes(1);
	});
});

describe('SplitPartRow — the note (1h)', () => {
	it('costs nothing when absent: a button, no field, no counter', async () => {
		render(SplitPartRow, base());

		await expect.element(page.getByRole('button', { name: 'Note' })).toBeInTheDocument();
		expect(document.querySelector('input[maxlength="80"]')).toBeNull();
	});

	it('renders the field when a note already exists, with the full text in title', async () => {
		const long = 'Courses de la semaine pour la maison et les enfants';
		render(SplitPartRow, base({ note: long }));

		const field = page.getByLabelText('Note de la part 1').element() as HTMLInputElement;
		expect(field.value).toBe(long);
		// « Au delà de la largeur disponible, l'ellipse. Le texte entier est dans le title. »
		expect(field.getAttribute('title')).toBe(long);
		expect(field.getAttribute('maxlength')).toBe('80');
	});

	it('shows the counter from 60 characters and hides it again below', async () => {
		// « Afficher "80 restants" sur un champ vide, c'est annoncer une limite avant qu'elle
		// existe. » The counter is silent until the limit is close enough to matter.
		//
		// Written as APPEAR-then-DISAPPEAR, and that ordering is not cosmetic. The first draft
		// asserted the absence first, synchronously after `field.focus()` — and passed with the
		// threshold set to 0, because focusing sets `noteOpen`, Svelte flushes it on a microtask, and
		// the assertion ran before anything had rendered. The counter was missing because the DOM was
		// stale, not because of the rule. Polling a DISAPPEARANCE is a real signal; polling an absence
		// that was never present is not.
		const { rerender } = render(SplitPartRow, base({ note: 'x'.repeat(60) }));
		(page.getByLabelText('Note de la part 1').element() as HTMLInputElement).focus();
		await expect.poll(() => document.body.textContent).toContain('20 restants');

		await rerender(base({ note: 'x'.repeat(59) }));
		(page.getByLabelText('Note de la part 1').element() as HTMLInputElement).focus();
		await expect.poll(() => document.body.textContent?.includes('restants')).toBe(false);
	});
});

describe('SplitPartRow — a deleted category (1r)', () => {
	it('keeps the amount, names the lost category, and marks it by shape as well as text', async () => {
		render(SplitPartRow, base({ deletedCategoryName: 'Cadeaux', amount: '20,00' }));

		// The work is kept — it is the category that vanished, not the amount.
		expect((page.getByLabelText('Montant de la part 1').element() as HTMLInputElement).value).toBe(
			'20,00'
		);
		// The lost name stays written: it is the only thing that lets the user work out what to pick.
		expect(document.body.textContent).toContain('Cadeaux, supprimée');
		// Shape and text, never colour alone — and no rose, since the user did nothing wrong.
		const field = page.getByRole('combobox', { name: 'Catégorie de la part 1' }).element();
		expect(field.className).toContain('border-dashed');
		expect(field.className).not.toContain('rose');
	});
});

describe('SplitPartRow — the rounding cent (1e)', () => {
	it('attaches the mention to the part concerned, not to a legend', async () => {
		render(SplitPartRow, base({ showRoundingCent: true }));
		expect(document.body.textContent).toContain("centime d'arrondi");
	});

	it('renders nothing when the division was even', async () => {
		render(SplitPartRow, base());
		expect(document.body.textContent).not.toContain("centime d'arrondi");
	});
});

describe('SplitPartRow — reporting typing to the editor', () => {
	it('reports every keystroke, which is what makes the remainder live', async () => {
		const onAmountInput = vi.fn<() => void>();
		render(SplitPartRow, base({ amount: '', onAmountInput }));

		await userEvent.fill(page.getByLabelText('Montant de la part 1'), '60');
		expect(onAmountInput).toHaveBeenCalled();
	});

	it('reports leaving the field, which is what lets the sentence be spoken at once', async () => {
		const onAmountBlur = vi.fn<() => void>();
		render(SplitPartRow, base({ onAmountBlur }));

		const field = page.getByLabelText('Montant de la part 1').element() as HTMLInputElement;
		field.focus();
		field.blur();
		await expect.poll(() => onAmountBlur.mock.calls.length).toBeGreaterThan(0);
	});
});
