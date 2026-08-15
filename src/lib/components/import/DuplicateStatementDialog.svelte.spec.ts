import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import DuplicateStatementDialog from './DuplicateStatementDialog.svelte';
import type { CollisionFigures } from '$lib/domain/importCollision';

/**
 * The dialog that stands between a re-read statement and the money it would duplicate.
 *
 * What these tests are for, and it is not geometry: the warning's entire persuasive content is that
 * the two sides agree. A dialog rendering one side, or rendering the same side twice, looks correct
 * in a screenshot and says nothing. So the figures are asserted per side, from two DIFFERENT file
 * names, which is the only pair of values that separates "both sides drawn" from "one side drawn
 * twice".
 *
 * BREAK MATRIX, run at authoring time.
 *
 * 1. Draw `existing` in both panels: **one red**, the incoming file name. Every other assertion
 *    stays green, because every other figure is equal on both sides by construction. That is the
 *    reason the two fixtures differ by name and by nothing else.
 * 2. Drop the consequence line: **one red**. It is the only sentence that says what pressing the
 *    primary costs, and the two panels above it are facts without a verdict.
 * 3. Swap the primary and the secondary labels: **one red**, and only after the test was rewritten.
 *    Asserting that both labels are present was green through the swap, because both labels are
 *    still present; what the swap moves is which control SUBMITS. The assertion is on `type` now.
 */
const EXISTING = {
	fileName: 'releve-juin.csv',
	periodStart: '2026-06-01',
	periodEnd: '2026-06-30',
	transactionCount: 25,
	debitCents: 157928,
	creditCents: 223500
} satisfies CollisionFigures;

// Same money, different file name. A user re-downloading a statement gets `releve (1).csv`, which
// is exactly the shape this dialog meets most often.
const INCOMING = { ...EXISTING, fileName: 'releve (1).csv' } satisfies CollisionFigures;

function mount(overrides: Partial<{ error: string | null }> = {}) {
	return render(DuplicateStatementDialog, {
		open: true,
		existing: EXISTING,
		incoming: INCOMING,
		importedAt: '2026-08-15T21:50:00.000Z',
		error: overrides.error ?? null,
		onCancel: () => {}
	});
}

describe('DuplicateStatementDialog', () => {
	it('names both statements, so the resemblance is shown rather than asserted', async () => {
		const screen = mount();

		await expect.element(screen.getByText('releve-juin.csv')).toBeInTheDocument();
		await expect.element(screen.getByText('releve (1).csv')).toBeInTheDocument();
	});

	it('prints the money on both sides, to the cent', async () => {
		const screen = mount();

		// Twice, once per panel. `getByText` would refuse an ambiguous match, which is what makes
		// this assert the pair rather than one of them.
		const figures = screen.getByText(/25 opérations/);
		await expect.element(figures.first()).toBeInTheDocument();
		expect(await figures.all()).toHaveLength(2);
	});

	it('says what pressing the primary would cost', async () => {
		const screen = mount();

		await expect
			.element(screen.getByText(/ajouterait ces opérations une seconde fois/))
			.toBeInTheDocument();
	});

	it('makes « Importer quand même » the submit and « Ne pas importer » the way out', async () => {
		// Asserted on the ROLE each label plays, not on both labels being present. The first version
		// of this test checked only that two buttons existed with those names, and swapping them
		// stayed green: the swap moves which one submits, and nothing about mere presence can see
		// that. `type="submit"` is what the caller's form is wired to, so it is the real difference.
		const screen = mount();

		const confirm = screen.getByRole('button', { name: 'Importer quand même' });
		const cancel = screen.getByRole('button', { name: 'Ne pas importer' });

		await expect.element(confirm).toBeEnabled();
		await expect.element(cancel).toBeEnabled();
		await expect.element(confirm).toHaveAttribute('type', 'submit');
		await expect.element(cancel).not.toHaveAttribute('type', 'submit');
	});

	it('reports a failed confirmation inside the dialog, where the reader is', async () => {
		// A banner on the page behind a modal is a message nobody sees. The failure it reports is the
		// one where the user presses the primary and nothing happens, so it has to be in here.
		const screen = mount({ error: 'Une erreur est survenue.' });

		await expect.element(screen.getByText('Une erreur est survenue.')).toBeInTheDocument();
	});

	it('says nothing when there is nothing to report', async () => {
		const screen = mount();

		// Absence asserted with a figure beside it, per the house rule: the dialog has exactly one
		// alert region when it fails and none when it does not.
		expect(await screen.getByRole('alert').all()).toHaveLength(0);
	});
});
