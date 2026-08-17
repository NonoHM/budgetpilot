import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import DuplicateStatementDialog from './DuplicateStatementDialog.svelte';
// Imported to CALIBRATE the tint detector, not to test it: this file asserts an absence of danger
// colour in every framing, and a real tinted control is the only honest proof the measurement can
// see one. `Button` is what `ConfirmDialog` renders for its tinted confirm.
import Button from '$lib/components/Button.svelte';
import { createRawSnippet } from 'svelte';
import type { CollisionFigures } from '$lib/domain/importCollision';
import type { CorrectionContext } from '$lib/domain/importCollision';
import * as m from '$lib/paraglide/messages';

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

function mount(
	overrides: Partial<{ error: string | null; correctionContext: CorrectionContext }> = {}
) {
	return render(DuplicateStatementDialog, {
		open: true,
		existing: EXISTING,
		incoming: INCOMING,
		importedAt: '2026-08-15T21:50:00.000Z',
		error: overrides.error ?? null,
		correctionContext: overrides.correctionContext ?? 'none',
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

/**
 * THE THREE FRAMINGS, and why a boolean here would have shipped a lie.
 *
 * The run carries the batch id whether or not the control was left ticked, so a prop meaning "is
 * this a correction" would render « l'import que vous corrigez sera remplacé » on a run that is
 * going to delete nothing. The value is derived from the POSTED CHOICE, and the fourth case is
 * that this dialog is not rendered at all: on the ordinary ticked correction the guard no longer
 * fires, because `findCollidingBatch` excludes the batch being replaced.
 *
 * THE ROUTE THAT PRODUCES EACH VALUE, because a prop no route sets is a draft:
 *  - `none`       — `/import`'s own 409, and `/import/columns`' 409 on a run that is not a
 *                   correction. Today's copy, untouched.
 *  - `keeping`    — a correction whose control was UNTICKED. The old import stays by choice, so the
 *                   corrected rows land beside it.
 *  - `replacing`  — a correction whose control was ticked AND a third batch also matches. Rare and
 *                   reachable: it needs a duplicate to exist already, which is the state the blind
 *                   session ended in.
 */
describe('the collision guard reframed for a correction', () => {
	it('says the old import is being KEPT, and never that it is replaced, when the box was unticked', async () => {
		// The hole this prop exists to close. The batch id is present in both correction cases, so a
		// dialog keyed on the correction rather than on the choice says the opposite of what will
		// happen.
		const screen = mount({ correctionContext: 'keeping' });

		await expect.element(screen.getByText(m.import_collision_keeping_body())).toBeInTheDocument();
		expect(await screen.getByText(m.import_collision_replacing_body()).all()).toHaveLength(0);
	});

	it('states BOTH facts when a third import also matches and the old one is being replaced', async () => {
		// The only case where a replacement and a duplication warning are both true. Saying one of
		// them is the same defect one level along, so both are asserted in one test: a version that
		// dropped either would pass a test asserting only the other.
		const screen = mount({ correctionContext: 'replacing' });

		await expect.element(screen.getByText(m.import_collision_replacing_body())).toBeInTheDocument();
		// And the ordinary consequence line stays, because the statement above really would be
		// duplicated. This is the assertion that catches a reframing which replaces rather than adds.
		await expect.element(screen.getByText(m.import_collision_consequence())).toBeInTheDocument();
	});

	it("leaves today's copy alone when the run is not a correction", async () => {
		// The direction this change is not moving in, and the common one: most collisions have
		// nothing to do with a correction.
		const screen = mount({ correctionContext: 'none' });

		await expect.element(screen.getByText(m.import_collision_explanation())).toBeInTheDocument();
		expect(await screen.getByText(m.import_collision_keeping_body()).all()).toHaveLength(0);
		expect(await screen.getByText(m.import_collision_replacing_body()).all()).toHaveLength(0);
	});

	/**
	 * THE TITLE, one test per value, because the title is where the boolean survived.
	 *
	 * The body branched three ways from the day the prop was widened; the title kept reading it as
	 * `isCorrection ? keeping : title`, so `replacing` announced « Vous avez choisi de garder l'ancien
	 * import » over a body saying the opposite. Seen on a screenshot, invisible to every test above:
	 * each of them asserts a BODY sentence, and the body was right.
	 *
	 * Asserted through the dialog's `aria-labelledby` target rather than by looking for the text
	 * anywhere on screen. That is what the heading actually is, and it is the half that made the bug
	 * worse than a cosmetic one: a screen reader named the dialog by the claim that was false.
	 */
	function heading(screen: ReturnType<typeof mount>): string {
		const dialog = screen.container.querySelector('[role="dialog"]');
		const id = dialog?.getAttribute('aria-labelledby') ?? '';
		return (screen.container.querySelector(`#${id}`)?.textContent ?? '').trim();
	}

	it('names the keeping case by the choice the user made', async () => {
		expect(heading(mount({ correctionContext: 'keeping' }))).toBe(
			m.import_collision_keeping_heading()
		);
	});

	it('does NOT name the replacing case as a keeping, which is what it used to do', async () => {
		// Separates « the title changes for a correction » from « the title knows WHICH correction ».
		// Both assertions, because the positive one alone would pass a title that printed both.
		const title = heading(mount({ correctionContext: 'replacing' }));

		expect(title).toBe(m.import_collision_replacing_heading());
		expect(title).not.toBe(m.import_collision_keeping_heading());
	});

	it('keeps the original title when the run is not a correction', async () => {
		expect(heading(mount({ correctionContext: 'none' }))).toBe(m.import_collision_title());
	});

	it('gives the three framings three DIFFERENT titles', async () => {
		// The property that no per-value test can see on its own, and the one that was violated: two of
		// the three were the same string. Asserted on the rendered headings rather than on the
		// catalogue, so it is a claim about the component's branching and not about the copy.
		const titles = (['none', 'keeping', 'replacing'] as const).map((correctionContext) =>
			heading(mount({ correctionContext }))
		);

		expect(new Set(titles).size).toBe(3);
	});

	it('tints the confirm in NO framing, and the detector is calibrated elsewhere', async () => {
		// The plate's own doctrine, from the import-deletion sheet: « le glyphe porte le sens, pas la
		// couleur », and a red spent where it is not data « affaiblirait celui qui informe au profit
		// de celui qui décore ». NOTHING on this dialog deletes: it fires before the first write, and
		// both buttons either import or abandon. The red was spent on the risk of a duplicate.
		//
		// ## The calibration had to move, and that is the interesting half
		//
		// This test used to read the `none` case's own red as its detector proof: measure a real tint
		// here, then believe an absence there. Removing the last tint from this component takes that
		// proof away, and an absence assertion with no calibration is the shape that passes over a
		// stylesheet that failed to load.
		//
		// So the calibration is now a `ConfirmDialog` mounted with `tone="danger"` in the same
		// document. That is a better calibration than the old one rather than a substitute for it: it
		// measures the tint on the component that OWNS it, so it keeps detecting if this file's own
		// framings all go neutral, which is exactly what just happened.
		const chroma = (element: Element) => {
			const parsed = getComputedStyle(element).backgroundColor.match(
				/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/
			);
			return parsed ? Number(parsed[2]) : 0;
		};
		const submitOf = (container: Element) =>
			container.querySelector('button[type="submit"]') as HTMLElement;

		// THE DETECTOR, proved against a real tint before any absence below is believed.
		//
		// `Button variant="danger"` and not `ConfirmDialog tone="danger"`, because that component
		// requires a children snippet and mounting it bare throws `invalid_snippet` — which would have
		// made this calibration a test of the harness. `Button` is the element `ConfirmDialog` renders
		// for its tinted confirm (`variant={tone === 'danger' ? 'danger' : 'primary'}`), so this
		// measures the same rose through the same stylesheet, one component closer to the paint.
		const calibration = render(Button, {
			variant: 'danger' as const,
			children: createRawSnippet(() => ({ render: () => '<span>calibration</span>' }))
		});
		const calibrated = calibration.container.querySelector('button') as HTMLElement;
		expect(chroma(calibrated)).toBeGreaterThan(0.05);
		calibration.container.remove();

		for (const context of ['none', 'keeping', 'replacing'] as const) {
			const { container } = mount({ correctionContext: context });
			expect(chroma(submitOf(container))).toBeLessThan(0.05);
		}
	});

	it('carries a WORD in every framing, so nothing rests on the tint alone', async () => {
		// The other half of the rule, and the one a tint removal can silently take with it. Removing
		// the danger colour must not pass by having also removed the sentence that said why.
		// Scoped to each mount's own container rather than to the page. Three mounts live in one
		// test, because cleanup runs between TESTS, and a page-wide locator then resolves to three
		// elements and fails on strictness rather than on the claim.
		for (const context of ['none', 'keeping', 'replacing'] as const) {
			const { container } = mount({ correctionContext: context });
			expect(container.textContent).toContain(m.import_collision_consequence());
		}
	});

	it('offers a confirm label that names what will happen in a correction', async () => {
		// « Importer quand même » is the right words for an ordinary duplicate and the wrong ones
		// here: nothing is being overridden, the user is completing the repair they came for.
		const screen = mount({ correctionContext: 'keeping' });

		await expect
			.element(screen.getByRole('button', { name: m.import_collision_correction_confirm() }))
			.toBeInTheDocument();
	});
});
