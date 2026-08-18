import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import { EMPTY_ASSIGNMENT, type RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * The screen's WIRING, and only that.
 *
 * `RoleRow` and `ColumnCard` have their own specs and are not re-tested here: what a row looks like
 * in each of its states is settled there, and repeating it would make this file go red for reasons
 * that have nothing to do with the screen. What is only observable here is the screen's own
 * decisions: which state each row is put into, what a designation does to the other three rows, and
 * the order in which the answer reaches a screen reader.
 *
 * The viewport is set to 390x844 rather than only the container, because the picker is a
 * `BottomSheet` and that component is `lg:hidden`: at the runner's default width the sheet would be
 * display:none and every assertion about it would pass or fail for a reason about the viewport.
 *
 * BREAK MATRIX, read per test, run 2026-08-15. Three breaks, and the first pass of it found that
 * TWO of these tests could not fail. Both are fixed and both were re-run; the figures below are the
 * second pass.
 *
 * A. The move stops reporting the vacancy, so a freed row falls back to « Choisir une colonne »:
 *    **two red.** The displacement test and the required-role displacement test. Nothing else moves,
 *    which is right: no other test is about what a move leaves behind.
 *
 * B. The live region is written in the SAME task as the designation, removing the delay entirely:
 *    **one red now, and ZERO on the first pass.** The original test read `textContent` synchronously
 *    after the click and asserted it was empty. Svelte flushes on a microtask, so the read ran
 *    before the update either way: it was measuring the batching and not the ordering, and the green
 *    was indistinguishable from a pass. Fixed by waiting for the ROW's own accessible name to update
 *    first, with a polling assertion: once that has happened the flush is done, so a live region
 *    still empty at that moment is empty by design.
 *
 * C. Owner ruling 1 lifted, so Categorie may take a column a required role holds: **two red now,
 *    and ONE on the first pass.** The second test had the same synchronous-read defect as B and was
 *    passing over a card that had quietly succeeded. It now polls the row's accessible name.
 *
 * The lesson both greens carry is the same and it is not about these two tests: **an assertion read
 * synchronously after an interaction is an assertion about the framework's batching.** Anything
 * checking that something did NOT happen must first wait for the thing that DID.
 *
 * The modify note's own breaks, run 2026-08-17, read per test. Three tests, three separate breaks,
 * because each guards a different direction and no single break could show that:
 *
 * D. The note rendered unconditionally instead of behind `modifyAsksForFile`: **one red**, the test
 *    about the recap that re-asks for nothing. NOT the designation-form test, and that green is the
 *    finding rather than a pass: the note lives inside `{#if recap}`, so the control form could not
 *    have shown it whatever the prop said, and that test was guarding a direction this break does
 *    not move in. Proven separately by E.
 * E. The note also emitted from the memorisation block, which is the control form's own trailing
 *    block: **one red**, and it is the designation-form test. That is the break the test exists for.
 * F. The note moved BELOW the TapLink: **one red**, and only the ordering assertion. A sentence
 *    explaining a cost the user has already paid is present, correct and useless, so presence alone
 *    could never have seen it.
 */
const HEADERS = ['Date operation', 'Date valeur', 'Libelle', 'Montant', 'Categorie'];

const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: HEADERS.map((_, index) => [`v${index}a`, `v${index}b`, `v${index}c`]),
	rowCount: 132,
	hasHeaderRow: true
};

const COMPLETE: RoleAssignment = { date: 0, label: 2, amount: 3, category: 4 };

function mount(props: Record<string, unknown> = {}) {
	const result = render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: EMPTY_ASSIGNMENT,
		// 0 rather than 150: the ORDER is what is under test, and a real delay would make every
		// assertion below a race. The order itself is asserted separately, in its own test.
		announceDelayMs: 0,
		...props
	});
	const row = (name: RegExp) => page.getByRole('button', { name });
	return {
		...result,
		row,
		banner: () => result.container.querySelector('[data-testid="condition-banner"]') as HTMLElement,
		live: () => result.container.querySelector('[data-testid="designation-live"]') as HTMLElement,
		primary: () => page.getByRole('button', { name: /Importer/ })
	};
}

beforeEach(async () => {
	await page.viewport(390, 844);
});

describe('the screen puts each row into one state, and the precedence is the state table', () => {
	it('prefers a lost remembered column over the empty it would otherwise be', async () => {
		// The two states this separates: a row with no column because the user has not chosen one,
		// and a row with no column because the bank renamed it. Both have `assignment[role] === null`
		// and they must not read alike, or state 3b is indistinguishable from a fresh file.
		//
		// Scoped to the ONE row under test. An assertion over the whole screen would also be reading
		// the date and label rows, which are legitimately empty here, and would fail for a reason
		// that has nothing to do with the precedence.
		const { container } = mount({ lostHeaders: { amount: 'Montant' } });

		const amountRow = await page.getByRole('button', { name: /^Montant,/ }).element();
		expect(amountRow.textContent).toContain("n'est plus dans le fichier");
		expect(amountRow.textContent).not.toContain('Choisir une colonne');
		// And state 3b's own promise, which is the half a single-row assertion cannot see: the
		// untouched rows really are untouched.
		expect(container.querySelectorAll('button[aria-haspopup="listbox"]').length).toBe(4);
	});

	it('prefers ambiguous over empty when detection proposes two columns', () => {
		// Separates "nothing is known about this role" from "two columns could carry it". Detection
		// does not pick between equals, so the row must say so rather than staying silent.
		const { container } = mount({ candidates: { date: [0, 1] } });

		expect(container.textContent).toContain('2 colonnes possibles');
	});

	it('leaves a single proposal as a plain empty row, not as an ambiguity', () => {
		// The other side of the same boundary, and the reason the threshold is 2 rather than 1: one
		// proposal is an answer the picker pins at the top, not a question for the row to ask.
		const { container } = mount({ candidates: { date: [0] } });

		expect(container.textContent).not.toContain('colonnes possibles');
		expect(container.textContent).toContain('Choisir une colonne');
	});
});

describe('designating a column, and what it does to the other three rows', () => {
	it('fills the row and recounts the banner', async () => {
		const { row, banner } = mount();

		await row(/^Date, aucune colonne désignée/).click();
		await page.getByRole('option', { name: /^Date operation\./ }).click();

		expect(banner().textContent).toContain('1 sur 3');
	});

	it('MOVES a column already held, and the freed row says who took it', async () => {
		// The displacement. A conflict has no representation in the model, so what exists is the
		// move, and the two states this separates are "the date row is empty because the user never
		// answered" and "the date row is empty because the label row just took its column". The
		// second must never read as the first, or a designation moves with nobody told.
		const { row, container, banner } = mount({ initialAssignment: COMPLETE });

		await row(/^Libellé, colonne désignée/).click();
		await page.getByRole('option', { name: /^Date operation\./ }).click();

		expect(container.textContent).toContain('Reprise par Libellé');
		expect(container.textContent).not.toContain('Choisir une colonne');
		// The recount is the half a text assertion cannot see: the move costs one required role.
		expect(banner().textContent).toContain('2 sur 3');
	});

	it('switches the primary off when the move empties a required role', async () => {
		// `aria-disabled`, never `disabled`, and pointed at the banner's second line. Asserted as a
		// pair with the enabled state above it so this cannot pass on a button that is always off.
		const { row, primary } = mount({ initialAssignment: COMPLETE });
		await expect.element(primary()).not.toHaveAttribute('aria-disabled');

		await row(/^Libellé, colonne désignée/).click();
		await page.getByRole('option', { name: /^Date operation\./ }).click();

		await expect.element(primary()).toHaveAttribute('aria-disabled', 'true');
		await expect
			.element(primary())
			.toHaveAttribute('aria-describedby', 'column-designation-consequence');
	});

	it('leaves the other rows untouched by a move', async () => {
		// A move takes one column from one role. An implementation that reset everything would pass
		// every assertion above, which is why this asserts the two rows that must NOT have changed.
		const { row, container } = mount({ initialAssignment: COMPLETE });

		await row(/^Libellé, colonne désignée/).click();
		await page.getByRole('option', { name: /^Date operation\./ }).click();

		expect(container.textContent).toContain('Montant');
		expect(container.textContent).toContain('Categorie');
	});
});

describe('owner ruling 1, in the Categorie picker', () => {
	it('offers a required role column as unchoosable, naming its holder', async () => {
		// Categorie may not take a column a required role holds. The card STAYS, carrying the reason,
		// because removing it would send the user hunting for a column visibly in their own file.
		const { row } = mount({ initialAssignment: { ...COMPLETE, category: null } });

		await row(/^Catégorie, aucune colonne désignée/).click();
		const held = page.getByRole('option', { name: /^Libelle\./ });

		await expect.element(held).toHaveAttribute('aria-disabled', 'true');
		// `toHaveAttribute` compares the WHOLE value, so a regex here asserts identity rather than
		// containment and fails on a correct label. The reason to check containment is that the
		// label legitimately carries the three examples first: what matters is that the holder is
		// named at all.
		const label = (await held.element()).getAttribute('aria-label') ?? '';
		expect(label).toContain('Actuellement : Libellé');
	});

	it('leaves the Categorie row empty when that card is activated', async () => {
		// The affordance half of the ruling, and the two states it separates: a card that refuses
		// and a card that quietly succeeds. Clicked DIRECTLY, because both Playwright and
		// vitest-browser treat `aria-disabled` as not enabled and would wait for it forever.
		//
		// Asserted through a POLLING query on the row's accessible name rather than by reading
		// `textContent` synchronously. Measured 2026-08-15: the synchronous read passed under the
		// break that lifts the ruling entirely, because Svelte flushes on a microtask and the read
		// happened first. It was reading the DOM before the defect could reach it.
		const { row } = mount({ initialAssignment: { ...COMPLETE, category: null } });

		await row(/^Catégorie, aucune colonne désignée/).click();
		((await page.getByRole('option', { name: /^Libelle\./ }).element()) as HTMLElement).click();

		await expect.element(row(/^Catégorie, aucune colonne désignée/)).toBeInTheDocument();
	});

	it('still allows a REQUIRED role to take a held column, which is the displacement', async () => {
		// The direction this is not moving in. A test asserting only the refusal would pass on an
		// implementation that froze every held column, which would break the displacement entirely.
		const { row, container } = mount({ initialAssignment: COMPLETE });

		await row(/^Montant, colonne désignée/).click();
		await page.getByRole('option', { name: /^Date operation\./ }).click();

		expect(container.textContent).toContain('Reprise par Montant');
	});
});

describe('the picker groups a column exactly once', () => {
	it('pins the designated column above, and does not repeat it below', async () => {
		// The rule that makes the common case one tap. A column in two groups is a second place to
		// look for the same card, which is what the pinning exists to avoid.
		const { row } = mount({ initialAssignment: COMPLETE });

		await row(/^Date, colonne désignée/).click();

		expect(page.getByRole('option', { name: /^Date operation\./ }).elements().length).toBe(1);
	});

	it('omits the proposal group AND its heading when there is no proposal', async () => {
		// Separates "no proposals" from "proposals I cannot see". A heading over nothing is a
		// promise the sheet cannot keep, and « Aucune proposition » would be a second empty state.
		const { row, container } = mount();

		await row(/^Date, aucune colonne désignée/).click();

		expect(container.textContent).not.toContain('Proposée');
		expect(container.textContent).not.toContain('Proposées');
		expect(container.textContent).toContain('Toutes les colonnes');
	});

	it('shows the proposal group when there is one, so the absence above means something', async () => {
		// The presence half. Without it, the assertion above passes on a picker that never renders
		// a proposal group at all.
		const { row, container } = mount({ candidates: { date: [1] } });

		await row(/^Date, aucune colonne désignée/).click();

		expect(container.textContent).toContain('Proposée · 1');
	});
});

describe('closing the sheet: five ways, and only one of them changes a value', () => {
	it('changes nothing and says nothing when closed with the cross', async () => {
		// Separates an abandonment from a choice. A live update after a no-op close would tell the
		// reader something changed when nothing did.
		const { row, container, live } = mount();

		await row(/^Date, aucune colonne désignée/).click();
		await page.getByRole('button', { name: 'Fermer' }).click();

		expect(container.textContent).toContain('Choisir une colonne');
		expect(live().textContent?.trim()).toBe('');
	});

	it('changes nothing and says nothing when the already-designated card is chosen', async () => {
		// Not an error, an abandonment. The value is the same before and after, so announcing a
		// count would imply a change.
		const { row, live } = mount({ initialAssignment: COMPLETE });

		await row(/^Date, colonne désignée/).click();
		await page.getByRole('option', { name: /^Date operation\./ }).click();

		expect(live().textContent?.trim()).toBe('');
	});
});

describe('the live region: one announcement per gesture, and it never pre-empts the focus return', () => {
	it('speaks only AFTER the row has already been updated, never in the same flush', async () => {
		// The order is normative and this is the only test of it, so it has to be able to fail.
		//
		// The first version could not. It read the live region synchronously after the click and
		// asserted it was empty, which passed under the break that removes the delay entirely,
		// because Svelte flushes on a microtask and the read ran before the flush. It was measuring
		// the batching, not the ordering. Recorded because the green looked exactly like a pass.
		//
		// The fix is to WAIT for the row's own update first, with a polling assertion. Once the row
		// carries its new accessible name the flush has happened, so a live region that is still
		// empty at that moment is empty by design rather than by timing.
		const { row, live } = mount({ announceDelayMs: 150 });

		await row(/^Date, aucune colonne désignée/).click();
		(
			(await page.getByRole('option', { name: /^Date operation\./ }).element()) as HTMLElement
		).click();

		// State 1: the row is up to date. This is what focus returns to, and it must win.
		await expect.element(row(/^Date, colonne désignée : Date operation/)).toBeInTheDocument();
		expect(live().textContent?.trim()).toBe('');

		// State 2: the summary follows, in a later task.
		await vi.waitFor(() => expect(live().textContent?.trim()).not.toBe(''), { timeout: 2000 });
	});

	it('carries BOTH facts of a displacement in ONE update', async () => {
		// A screen reader receiving two successive polite updates drops one, and the one it drops is
		// the second: the unintended consequence, which is the half the user did not ask for. So the
		// assertion is that a single string contains both, not that both were eventually said.
		const { row, live } = mount({ initialAssignment: COMPLETE });

		await row(/^Libellé, colonne désignée/).click();
		await page.getByRole('option', { name: /^Date operation\./ }).click();

		const spoken = live().textContent ?? '';
		expect(spoken).toContain('Libellé : Date operation');
		expect(spoken).toContain('Date à redésigner');
		expect(spoken).toContain('2 sur 3');
	});
});

describe('memorisation is on by default, in one sentence, with an opt-out', () => {
	it('appears only once the three required columns are designated', async () => {
		// Separates "not yet relevant" from "off". There is nothing to memorise until there is a
		// correspondance, so the sentence is absent rather than present and disabled.
		const { container } = mount();

		expect(container.textContent).not.toContain('sera réutilisée');
	});

	it('states the reuse and offers a link to decline, with no toggle', async () => {
		const { container } = mount({ initialAssignment: COMPLETE });

		expect(container.textContent).toContain('sera réutilisée pour les prochains fichiers');
		// No switch: the referential has none, and a switch would present a default as a decision
		// the user must take before they can leave.
		expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0);
	});

	it('hands the caller remember: false after the opt-out is used', async () => {
		// The assertion that the link is wired to the SUBMITTED value rather than only to the copy.
		const onSubmit = vi.fn();
		const { initialAssignment } = { initialAssignment: COMPLETE };
		mount({ initialAssignment, onSubmit });

		await page.getByRole('button', { name: 'Ne pas mémoriser' }).click();
		await page.getByRole('button', { name: /Importer/ }).click();

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].remember).toBe(false);
		expect(onSubmit.mock.calls[0][0].assignment).toStrictEqual(COMPLETE);
	});
});

describe('above 20 columns the picker gains a search field, and below it does not', () => {
	const wide = (count: number) => {
		const headers = Array.from({ length: count }, (_, index) => `Colonne ${index + 1}`);
		return {
			name: 'large.csv',
			headers,
			samples: headers.map(() => ['a', 'b', 'c']),
			rowCount: 10,
			hasHeaderRow: true
		};
	};

	it('has no search field at exactly 20, which is the boundary', async () => {
		// An off-by-one here is the difference between a sheet that scrolls for four screens and one
		// that does not, so the boundary is tested AT the threshold and not merely below it.
		const { row, container } = mount({ file: wide(20) });

		await row(/^Date, aucune colonne désignée/).click();

		expect(container.querySelector('[data-testid="column-search"]')).toBeNull();
	});

	it('has one at 21', async () => {
		const { row, container } = mount({ file: wide(21) });

		await row(/^Date, aucune colonne désignée/).click();

		expect(container.querySelector('[data-testid="column-search"]')).not.toBeNull();
	});

	it('narrows the list and announces the count', async () => {
		const { row, container } = mount({ file: wide(21) });

		await row(/^Date, aucune colonne désignée/).click();
		await userEvent.fill(page.getByRole('searchbox'), 'Colonne 1');

		// COUNTED, not predicted: `Colonne 1` plus `Colonne 10` to `Colonne 19` is 11 of 21.
		// `Colonne 21` does not match, because the substring is `Colonne 2` followed by `1`. The
		// first draft of this comment said 12 and the run said 11; the run is right.
		expect(container.textContent).toContain('11 colonnes');
	});

	it('offers a way out when the search matches nothing', async () => {
		const { row, container } = mount({ file: wide(21) });

		await row(/^Date, aucune colonne désignée/).click();
		await userEvent.fill(page.getByRole('searchbox'), 'zzzz');

		expect(container.querySelector('[data-testid="search-empty"]')).not.toBeNull();
		expect(container.textContent).toContain('Aucune colonne ne correspond');
	});
});

describe('the recapitulatif, which is a MODE of this screen and not a second screen', () => {
	it('draws four 64 px rows in a 315 px card', async () => {
		// 14 padding + 16 label + 10 gap + 4 rows of 64 + 3 hairlines + 14 padding + 2 border.
		// Absolute, because the recap's whole job is to show the same resolution the control form
		// shows, and a card that drifted by a row height would be showing something else.
		//
		// It was 235 over 44 px rows, and the plate sizes it there. The row grew because it stopped
		// pairing a live column name with a historical value and started stating them as two facts,
		// which is one line more; the deviation from §3.7 is recorded in `RoleRow`'s own docstring.
		const { container } = mount({ initialAssignment: COMPLETE, readOnly: true });

		const card = container.querySelector('[data-testid="designation-card"]') as HTMLElement;
		expect(card.getBoundingClientRect().height).toBe(315);
	});

	it('says the file will be asked for again, and says it before the control', async () => {
		// Question 5 of the design project's own issue list. The order of the flow cannot change,
		// because the picker chooses columns on their VALUES and the stored correspondance holds
		// four column names out of N, so the only thing left to repair is the surprise.
		//
		// Separates "the note exists on the page" from "the note is read before the press it is
		// about". A sentence under the link explains a cost the user has already paid.
		const { container } = mount({
			initialAssignment: COMPLETE,
			readOnly: true,
			modifyAsksForFile: true
		});

		const block = container.querySelector('[data-testid="designation-modify"]') as HTMLElement;
		const text = (block.textContent ?? '').replace(/\s+/g, ' ');
		expect(text).toContain(m.import_columns_recap_modify_note());
		expect(text.indexOf(m.import_columns_recap_modify_note())).toBeLessThan(
			text.indexOf(m.import_columns_modify())
		);
	});

	it('does not say it when pressing the link re-asks for nothing', async () => {
		// THE DIRECTION THIS CHANGE IS NOT MOVING IN, and the reason the note is a prop rather than
		// a consequence of `readOnly`. This same recap opened over a file still in hand flips the
		// rows back to their controls in place: nothing is re-asked, and a note promising the file
		// will be asked for again would be false on exactly the path that has it.
		const { container } = mount({ initialAssignment: COMPLETE, readOnly: true });

		const block = container.querySelector('[data-testid="designation-modify"]') as HTMLElement;
		expect(block.textContent).toContain(m.import_columns_modify());
		expect(block.textContent).not.toContain(m.import_columns_recap_modify_note());
	});

	it('never says it on the designation form, which asks for the file up front', async () => {
		// The second half of the same separation, at the other mode. The control form was reached
		// BY handing over a file, so there is nothing to re-ask and nothing to warn about.
		const { container } = mount({ initialAssignment: COMPLETE });

		expect(container.textContent).not.toContain(m.import_columns_recap_modify_note());
	});

	it('opens nothing: the rows are not buttons and do not take focus', async () => {
		// Asserting `tabindex` is absent proves less than it looks, because an element can be
		// focusable without one. So focus is actually attempted on each row and the check is where
		// it landed. The two states separated: a row that looks inert and is, and one that looks
		// inert and still answers a keyboard.
		const { container } = mount({ initialAssignment: COMPLETE, readOnly: true });

		expect(container.querySelectorAll('button[aria-haspopup="listbox"]').length).toBe(0);
		const rows = container.querySelectorAll('[data-testid="designation-card"] > div > div');
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			(row as HTMLElement).focus();
			expect(document.activeElement).not.toBe(row);
		}
	});

	it('carries no condition banner, because nothing is being asked', async () => {
		// A banner reports the state of a condition. In the recap there is no condition: nothing is
		// blocked and nothing is being satisfied, so a banner would answer a question nobody asked.
		const { container } = mount({ initialAssignment: COMPLETE, readOnly: true });

		expect(container.querySelector('[data-testid="condition-banner"]')).toBeNull();
	});

	it('returns the rows to their 68 px control form, which is what makes it one screen', async () => {
		// The assertion that proves the recap is a MODE rather than a second screen: the same rows,
		// resolved the same way, become the control form in place. A second screen would have to be
		// kept in step by hand, and nothing would go red when it drifted.
		const { container } = mount({ initialAssignment: COMPLETE, readOnly: true });

		await page.getByRole('button', { name: 'Modifier les colonnes' }).click();

		await expect
			.element(page.getByRole('button', { name: /^Date, colonne désignée/ }))
			.toBeInTheDocument();
		const card = container.querySelector('[data-testid="designation-card"]') as HTMLElement;
		expect(card.getBoundingClientRect().height).toBe(355);
		expect(container.querySelectorAll('button[aria-haspopup="listbox"]').length).toBe(4);
	});

	/**
	 * THE AFFORDANCE, and the reason it needed tests at all: it shipped inverted and every test in this
	 * file stayed green over it.
	 *
	 * A blind session recorded « my honest first read was that Annuler was the only control on this
	 * screen and that I had hit a dead end ». « Modifier les colonnes » — the only reason to be on the
	 * page — rendered as flat text with no border while « Annuler » sat in a bordered box and cancelled
	 * nothing on a read-only screen.
	 *
	 * Asserted on the RENDERED weight, compared between the two controls in one document rather than
	 * against a literal colour, so a palette change cannot silently invert it again. A class-name
	 * assertion would have passed on the inverted version too, since both controls have classes.
	 */
	/**
	 * Whether a control draws a BOX around itself: a fill that is not transparent, or a border.
	 *
	 * Asserted as a count rather than as a comparison, and the difference was measured. A first version
	 * compared the two controls' darkness and passed when BOTH were boxed — which is not the shipped
	 * defect but is not « one control that reads as one » either, so the test did not cover its own
	 * title. Counting boxes answers the claim directly.
	 */
	function boxed(element: Element): boolean {
		const style = getComputedStyle(element);
		const transparent =
			style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent';
		return !transparent || style.borderTopWidth !== '0px';
	}

	it('gives the recap exactly ONE control that reads as one, and it is the modify', async () => {
		const { container } = mount({ initialAssignment: COMPLETE, readOnly: true });

		const modify = container.querySelector(
			'[data-testid="designation-modify"] button'
		) as HTMLElement;
		const escape = container.querySelector(
			'[data-testid="designation-footer"] button'
		) as HTMLElement;

		expect(boxed(modify)).toBe(true);
		expect(boxed(escape)).toBe(false);
	});

	it('names the escape after what it does, and never « Annuler », in the recap', async () => {
		// A14's phantom. Nothing is in progress on a read-only page, so nothing can be cancelled: the
		// control goes back to the list the recap was opened from. Both assertions, because renaming it
		// to a third thing would pass a presence check alone.
		const { container } = mount({ initialAssignment: COMPLETE, readOnly: true });

		const escape = container.querySelector(
			'[data-testid="designation-footer"] button'
		) as HTMLElement;

		expect(escape.textContent?.trim()).toBe(m.import_columns_recap_back());
		expect(escape.textContent).not.toContain(m.import_columns_cancel());
	});

	it('keeps « Annuler » as the bordered control on the designation FORM', async () => {
		// The direction this change is not moving in, and the one a careless fix takes with it. On the
		// control form something IS in progress and abandoning it is exactly what that button does, so
		// the word and the box are both right there.
		const { container } = mount({ initialAssignment: COMPLETE });

		const escape = container.querySelector(
			'[data-testid="designation-footer"] button'
		) as HTMLElement;

		expect(escape.textContent?.trim()).toBe(m.import_columns_cancel());
		expect(getComputedStyle(escape).borderTopWidth).not.toBe('0px');
	});
});
