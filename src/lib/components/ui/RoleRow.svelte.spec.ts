import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import RoleRow from './RoleRow.svelte';

/**
 * The LABEL half of each recap fact, taken from the message rather than retyped.
 *
 * Retyping « Aujourd’hui : » here would assert a French literal that an English
 * locale never renders, and it would put the catalogue and the test on two sources for one string.
 * Rendering the message with an empty argument leaves exactly its label half, which is the handle
 * these tests need: the value comes from the fixture, the label comes from the catalogue, and the
 * two sides of every assertion below therefore come from different places.
 */
const COLUMN_LABEL = m.import_columns_recap_column_fact({ column: '' }).trim();
const VALUE_LABEL = m.import_columns_recap_value_fact({ value: '' }).trim();

/**
 * `layout.css` is imported because every height below is a real measurement. Without it these
 * assertions read plausible numbers instead of failing, which this repository has measured twice.
 *
 * BREAK MATRIX, read per test, run 2026-08-15. Recorded because two of the greens are the finding.
 *
 * 1. `h-[68px]` to `h-16` (64): **three red at 64.** The 68 assertion, the `identical in every
 *    state` sweep, and the SKELETON test, which pins 68 again on purpose and is the third red.
 *    Compact and recap stay green, correctly: they are different tracks.
 * 2. `h-14` to `h-[68px]` on the compact branch: **one red at 68 against 56.** The default height
 *    stays green, which is the point of asserting both absolutely rather than asserting they
 *    differ: a comparison passes when both collapse to the same wrong number.
 * 3. Render the recap branch as a `<button>` instead of a `<div>`: **one red**, the tab-order test.
 *    Every text assertion stays green, correctly, because a recap row's TEXT is right either way.
 *    That green is the reason the tab-order test exists as its own test.
 * 4. Drop `aria-hidden` from the chevron: **one red.** Nothing else moves, which is what makes the
 *    chevron test load bearing rather than decorative.
 *
 * A8's own breaks, run 2026-08-17, read per test:
 *
 * 5. The recap row pairs again, `{designatedName} · {sampleValue}` in one span: **four red**, two
 *    here and two in the route's spec. The « names no column » test stays green, correctly: a role
 *    holding nothing has nothing to pair.
 * 6. The value fact rendered whether or not there is a value: **one red**, and only the test about
 *    the empty sample. Nothing about the pairing moves, which is what separates « two facts » from
 *    « two labels ».
 * 7. The recap row back to 44: **three red**, the two heights here and the card figure in the
 *    screen's spec. Recorded because the card's 315 is a consequence rather than an independent
 *    measurement, and a break that reddens both proves the pair is not one assertion written twice.
 */
const BASE = { role: 'amount', state: 'empty' } as const;

async function mount(props: Record<string, unknown>) {
	const { container } = await render(RoleRow, { ...BASE, ...props });
	container.style.width = '320px';
	const row = container.firstElementChild as HTMLElement;
	expect(row).not.toBeNull();
	return { container, row };
}

describe('RoleRow.svelte: three heights, and each is a different kind of thing', () => {
	it('is 68 px at 390, which is a two-line ROW and not a control', async () => {
		// 13 top air + 20 line 1 + 4 gap + 18 line 2 + 13 bottom air. The product's control heights
		// are 44 and 48 and this is neither, deliberately: 48 does not hold two lines with air. The
		// figure that has to be respected is the touch-target floor, and 68 clears it by 20.
		const { row } = await mount({});

		expect(row.getBoundingClientRect().height).toBe(68);
	});

	it('is 68 px in every interactive state, so nothing shifts as answers arrive', async () => {
		// The card is 355 because the four rows do not move. A row that grew when it was answered
		// would make the skeleton a lie and the card's fixed height an accident.
		const states = [
			{ state: 'empty' },
			{ state: 'ambiguous', candidateCount: 2 },
			{ state: 'designated', columnHeader: 'Montant', sampleValue: '-24,90' },
			{ state: 'vacated', vacatedBy: 'label' },
			{ state: 'missingColumn', lostHeader: 'Montant' },
			{ state: 'skeleton' }
		];

		for (const props of states) {
			const { row, container } = await mount(props);
			expect(row.getBoundingClientRect().height, `state ${props.state}`).toBe(68);
			container.remove();
		}
		// The absolute figure beside the loop: an empty `states` array would satisfy every
		// assertion in it.
		expect(states.length).toBe(6);
	});

	it('is 56 px in compact form, asserted absolutely and not merely as "smaller"', async () => {
		// 20 air + 18 line 1 + 2 gap + 16 line 2. Both heights are pinned to their own number: a
		// test asserting only that compact is shorter passes in a world where both are 0.
		const { row } = await mount({ compact: true });

		expect(row.getBoundingClientRect().height).toBe(56);
	});

	it('is 64 px as a recapitulatif, which is a third thing and not a smaller row', async () => {
		// 4 air + 18 role + 3 + 16 + 3 + 16 + 4. It was 44 while the row held ONE line, and the
		// line it held is the arrow A8 is about. A row that states two facts cannot be one line,
		// so the plate's 44 is deviated from deliberately and the deviation is recorded at the
		// site rather than rounded away.
		const { row } = await mount({
			state: 'recap',
			columnHeader: 'Date operation',
			// Passed because the real caller always passes it: `columnIndex` is what says a role HOLDS
			// a column, and it is the only thing that says so when the header is unreadable.
			columnIndex: 0,
			sampleValue: '24/06/2026'
		});

		expect(row.getBoundingClientRect().height).toBe(64);
		expect(row.textContent).toContain('Date operation');
		expect(row.textContent).toContain('24/06/2026');
	});

	it('is 64 px whatever the recapitulatif row has to show', async () => {
		// The card is a fixed height because the four rows do not move, and a recap row shows one,
		// two or three lines depending on what the role holds. Separates "the row is 64 when it is
		// full" from "the row is 64", which is the property the card's own figure rests on.
		const shapes = [
			{ role: 'date', columnHeader: 'Date operation', columnIndex: 0, sampleValue: '24/06/2026' },
			// Designated, and this import left no value to read: two lines.
			{ role: 'date', columnHeader: 'Date operation', columnIndex: 0, sampleValue: '' },
			// Optional role holding nothing: its own sentence, one line.
			{ role: 'category' },
			// Required role holding nothing: nothing false said, one line.
			{ role: 'amount' }
		];

		for (const shape of shapes) {
			const { row, container } = await mount({ state: 'recap', ...shape });
			expect(row.getBoundingClientRect().height, JSON.stringify(shape)).toBe(64);
			container.remove();
		}
		expect(shapes.length).toBe(4);
	});

	it('states the column and the value as two facts, never as one pairing', async () => {
		// A8. Separates "the row shows a column name and a value" from "the row claims that column
		// produced that value". The column is read LIVE from the correspondance and the value comes
		// from this batch's transactions, so after a correction the two halves are from different
		// readings and `Date operation · 24/06/2026` asserts they are not.
		//
		// Asserted by ORDER rather than by the absence of a separator glyph, because a middot swapped
		// for a dash, an arrow or a slash is the same claim and would leave a `not.toContain('·')`
		// green. What has to hold is that the value is introduced by its own label.
		const { row } = await mount({
			state: 'recap',
			columnHeader: 'Date operation',
			columnIndex: 0,
			sampleValue: '24/06/2026'
		});

		const text = (row.textContent ?? '').replace(/\s+/g, ' ');
		const columnLabel = text.indexOf(COLUMN_LABEL);
		const column = text.indexOf('Date operation');
		const valueLabel = text.indexOf(VALUE_LABEL);
		const value = text.indexOf('24/06/2026');

		expect(columnLabel).toBeGreaterThanOrEqual(0);
		expect(column).toBeGreaterThan(columnLabel);
		expect(valueLabel).toBeGreaterThan(column);
		expect(value).toBeGreaterThan(valueLabel);
	});

	it('states no value fact when this import left no value to read', async () => {
		// Separates "the labels are printed" from "a fact is stated only when there is one". A batch
		// whose transactions are gone gives every role an empty sample, and a row reading
		// « Lu par cet import : » with nothing after it is a label doing a fact's job.
		const { row } = await mount({
			state: 'recap',
			columnHeader: 'Date operation',
			columnIndex: 0,
			sampleValue: ''
		});

		expect(row.textContent).toContain(COLUMN_LABEL);
		expect(row.textContent).not.toContain(VALUE_LABEL);
	});

	it('names no column in a recapitulatif when the role holds none', async () => {
		// `Colonne N` is the right fallback for a designated column with an unreadable header and a
		// LIE for a role that was never designated: it would tell a user reading their memorised
		// correspondance that their categories came from column 1 of a file that had no category
		// column. Catégorie says so in its own words.
		const { row } = await mount({ state: 'recap', role: 'category' });

		expect(row.textContent).not.toContain('Colonne 1');
		expect(row.textContent).toContain('Aucune');
		// And it states neither fact: there is no memorised column and there was no value.
		expect(row.textContent).not.toContain(COLUMN_LABEL);
		expect(row.textContent).not.toContain(VALUE_LABEL);
	});
});

describe('RoleRow.svelte: the row is the target and the chevron is not a second one', () => {
	it('has exactly one tab stop and one accessible name', async () => {
		const { container } = await mount({});

		expect(container.querySelectorAll('button').length).toBe(1);
		// A separate chevron button would be a second stop for one action and a second name for one
		// thing. Asserted by counting, because "there is a button" cannot see a duplicate.
		expect(container.querySelectorAll('svg').length).toBe(1);
		expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('calls onOpen once from the row itself', async () => {
		const onOpen = vi.fn();
		await mount({ onOpen });

		await page.getByRole('button').click();

		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it('moves aria-expanded and takes the open surface without a transition', async () => {
		const closed = await mount({});
		expect(closed.row.getAttribute('aria-expanded')).toBe('false');
		expect(getComputedStyle(closed.row).transitionDuration).toBe('0.12s');
		closed.container.remove();

		// A row never animates into a state it did not reach by touch: pressing eases over 120 ms,
		// opening is instantaneous. Same property, two behaviours, which is why the transition is
		// conditional rather than constant. Both halves asserted: a single reading cannot tell a
		// conditional transition from an absent one.
		const open = await mount({ expanded: true });
		expect(open.row.getAttribute('aria-expanded')).toBe('true');
		expect(getComputedStyle(open.row).transitionDuration).toBe('0s');
	});
});

describe('RoleRow.svelte: the answer line, one test per state', () => {
	it('empty: asks for a column, and names the role in the accessible name', async () => {
		const { row } = await mount({ role: 'amount', state: 'empty' });

		expect(row.textContent).toContain('Choisir une colonne');
		// « bouton » is the ROLE and the assistive technology contributes it. Writing it into the
		// label would announce it twice.
		expect(row.getAttribute('aria-label')).toBe('Montant, aucune colonne désignée');
		expect(row.getAttribute('aria-label')).not.toContain('bouton');
	});

	it('optional and empty: states the consequence, with no triangle and no tint', async () => {
		// A consequence, not a warning. Nobody did anything wrong by leaving it empty.
		const { row, container } = await mount({ role: 'category', state: 'empty', optional: true });

		// Copied from the handoff's state table, not composed. The design is the source of truth for
		// UI strings, so the punctuation is the plate's and not this repository's prose convention.
		expect(row.textContent).toContain('les transactions arriveront non catégorisées');
		expect(row.textContent).toContain('Optionnel');
		// One svg, the chevron. A triangle here would be the second one.
		expect(container.querySelectorAll('svg').length).toBe(1);
	});

	it('requiredness is marked BY EXCEPTION: the three required rows carry no badge at all', async () => {
		// No asterisks anywhere. The presence half is the test above; this is the absence half, and
		// it is asserted across all three rather than on one, because a badge rendered on `date`
		// only would pass a single-row check.
		for (const role of ['date', 'label', 'amount']) {
			const { row, container } = await mount({ role, state: 'empty' });
			expect(row.textContent, role).not.toContain('Optionnel');
			container.remove();
		}
	});

	it('ambiguous: the count is in the accessible name, not only in the glyph', async () => {
		const { row, container } = await mount({ role: 'date', state: 'ambiguous', candidateCount: 2 });

		expect(row.textContent).toContain('2 colonnes possibles');
		expect(row.getAttribute('aria-label')).toBe('Date, 2 colonnes possibles');
		// Chevron plus the warning triangle.
		expect(container.querySelectorAll('svg').length).toBe(2);
	});

	it('designated: header, dot, example, and the example is what truncates', async () => {
		const { row } = await mount({
			role: 'amount',
			state: 'designated',
			columnHeader: 'Montant',
			sampleValue: '-24,90'
		});

		expect(row.textContent).toContain('Montant');
		expect(row.textContent).toContain('-24,90');
		// The minus is spoken as a word. « tiret vingt-quatre » tells the reader the punctuation
		// where they asked for the quantity, and a statement's amounts are mostly negative.
		expect(row.getAttribute('aria-label')).toBe(
			'Montant, colonne désignée : Montant, exemple moins 24,90'
		);
	});

	it('designated with an unreadable header: named by position, with the raw bytes NOT in the row', async () => {
		// The raw text lives in the picker card. The row is where you check your answer at a glance,
		// and a line of mojibake in it is noise rather than evidence.
		const { row } = await mount({
			role: 'label',
			state: 'designated',
			columnHeader: '',
			columnIndex: 4,
			sampleValue: 'CARTE 22/06 CARREFOUR'
		});

		expect(row.textContent).toContain('Colonne 5');
		expect(row.getAttribute('aria-label')).toContain('colonne désignée : Colonne 5');
	});

	it('vacated: says who took it, and NEVER reads as if it emptied itself', async () => {
		const { row } = await mount({ role: 'date', state: 'vacated', vacatedBy: 'label' });

		expect(row.textContent).toContain('Reprise par Libellé');
		// The absence assertion that carries the whole meaning of this state, with its presence
		// established by the `empty` test above: a vacated row showing `Choisir une colonne` would
		// look self-emptied, and the user would not know a designation had moved.
		expect(row.textContent).not.toContain('Choisir une colonne');
		expect(row.getAttribute('aria-label')).toBe('Date, reprise par Libellé, à redésigner');
	});

	it('vacated: the VISIBLE string takes the plate dash and the SPOKEN one takes a comma', async () => {
		// Not an inconsistency and not an oversight: the plate's state table gives the visible line
		// « Reprise par Libelle [U+2014] a redesigner » and the accessible name « Date, reprise par
		// Libelle, a redesigner, bouton ». A dash is typography and a screen reader does not read it,
		// so the spoken form needs a separator that survives being spoken.
		//
		// Pinned because this is precisely what a future sweep of the repository's no-em-dash rule
		// would "fix". That rule governs OUR prose; the design is the source of truth for UI strings,
		// and this is a UI string.
		const { row } = await mount({ role: 'date', state: 'vacated', vacatedBy: 'label' });

		expect(row.textContent).toContain(
			`Reprise par Libellé ${String.fromCharCode(8212)} à redésigner`
		);
		expect(row.getAttribute('aria-label')).not.toContain(String.fromCharCode(8212));
	});

	it('missing column: quotes the OLD header, because it is gone from the new file', async () => {
		const { row } = await mount({ role: 'amount', state: 'missingColumn', lostHeader: 'Montant' });

		expect(row.textContent).toContain("n'est plus dans le fichier");
		expect(row.getAttribute('aria-label')).toBe(
			"Montant, la colonne Montant n'est plus dans le fichier"
		);
	});
});

/**
 * ONE state rather than two, since Planche 5f removed the skeleton.
 *
 * The test that stood here asserted the skeleton row was silent, out of the tab order and exactly
 * 68 px, and all three were true. What no test could say is that NO ROUTE EVER SET IT: the screen's
 * cards exist because the file is already read in memory, so there is no instant at which the
 * structure is known and the content absent. The state was internally consistent and unreachable,
 * which is the class this repository checks for by naming the route that produces a state.
 *
 * Brique 9's skeleton lives at `/imports` on arrival now, where the instant does exist, and it has
 * its own component and its own threshold tests.
 */
describe('RoleRow.svelte: the state that is not a button', () => {
	it('recap: not a button, not focusable, and it receives no focus when tabbed to', async () => {
		const { row, container } = await mount({
			state: 'recap',
			columnHeader: 'Date operation',
			sampleValue: '24/06/2026'
		});

		expect(container.querySelectorAll('button').length).toBe(0);
		expect(row.hasAttribute('tabindex')).toBe(false);
		// Asserting `tabindex` is absent proves less than it looks: an element can be focusable
		// without one. So focus is actually attempted, and the check is where focus ended up.
		row.focus();
		expect(document.activeElement).not.toBe(row);
	});
});

describe('RoleRow.svelte: there is no disabled state, and a greyed row would be a defect', () => {
	it('renders none of the seven states as disabled or aria-disabled', async () => {
		// Recorded as a test rather than as a comment because "for completeness" is exactly how a
		// disabled state gets added. No file combination produces one: even with all three required
		// roles taken, Categorie stays designable, since a column may carry two roles.
		const states = ['empty', 'ambiguous', 'designated', 'vacated', 'missingColumn'];

		for (const state of states) {
			const { row, container } = await mount({ state, candidateCount: 2, vacatedBy: 'label' });
			expect(row.hasAttribute('disabled'), state).toBe(false);
			expect(row.getAttribute('aria-disabled'), state).toBeNull();
			container.remove();
		}
		expect(states.length).toBe(5);
	});
});

/**
 * Plate 7c: the Date row is 86 px (74 compact) in EVERY state, including one with nothing to show,
 * because it is the only role whose designation carries an interpretation. §9's card is a fixed
 * height, so a row that grew only once a reading existed would move the card by 18 px on the one
 * gesture the whole screen is built to make cheap.
 */
describe('RoleRow.svelte: the interpreting row is 86/74, decided by PRESENCE not by VALUE', () => {
	it('is 86 px at 390 the moment `interpretation` is passed, even as `null`', async () => {
		// Separates "interpretation is undefined" (a row that never interprets, 68 px) from
		// "interpretation is null" (an interpreting row with nothing yet to show, 86 px). Getting
		// this backwards — treating a null/falsy value as "not interpreting" — is exactly the bug
		// this test exists to catch, and it is the one the task calls out as the subtle part.
		const { row } = await mount({ role: 'date', interpretation: null });

		expect(row.getBoundingClientRect().height).toBe(86);
	});

	it('is 74 px compact under the same rule', async () => {
		const { row } = await mount({ role: 'date', compact: true, interpretation: null });

		expect(row.getBoundingClientRect().height).toBe(74);
	});

	it('stays 68/56 when `interpretation` is never passed at all', async () => {
		// The control for the two tests above: an absent prop must not accidentally read as an
		// interpreting row. Both heights asserted absolutely, per this file's own convention.
		const notCompact = await mount({ role: 'amount' });
		expect(notCompact.row.getBoundingClientRect().height).toBe(68);
		notCompact.container.remove();

		const compact = await mount({ role: 'amount', compact: true });
		expect(compact.row.getBoundingClientRect().height).toBe(56);
	});

	it('is 86 px for every kind of interpretation value, not only the object shape', async () => {
		// A loop rather than one case, because "presence decides" is a claim about the WHOLE type,
		// and citing one member of a five-way union is citing the one you happened to test.
		const values: Array<unknown> = [
			null,
			'inconsistent',
			'no-dates',
			'empty',
			{ raw: '24/06/2026', pretty: '24 juin 2026', order: 'day-first' }
		];

		for (const interpretation of values) {
			const { row, container } = await mount({ role: 'date', interpretation });
			expect(row.getBoundingClientRect().height, JSON.stringify(interpretation)).toBe(86);
			container.remove();
		}
		expect(values.length).toBe(5);
	});
});

/**
 * Plate 7c/7n: line 3's five variants, one test per state. Each separates "this state's own
 * sentence is on screen" from "a different state's sentence leaked in", which is the only way a
 * five-way union can be checked without one test standing in for all five.
 */
describe('RoleRow.svelte: line 3, one sentence per interpretation state', () => {
	it('null: reserves the 18 px line but writes nothing into it', async () => {
		const { row } = await mount({ role: 'date', interpretation: null });

		expect(row.textContent).not.toContain('→');
		expect(row.textContent).not.toContain('Confirmer');
		expect(row.textContent).not.toContain('Deux ordres');
		expect(row.textContent).not.toContain('Aucune date');
		expect(row.textContent).not.toContain('Colonne vide');
	});

	it('a confirmed reading: "raw → pretty", with no "Confirmer" clause', async () => {
		const { row } = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: { raw: '24/06/2026', pretty: '24 juin 2026', order: 'day-first' },
			interpretationConfirmed: true
		});

		expect(row.textContent).toContain('24/06/2026 → 24 juin 2026');
		expect(row.textContent).not.toContain('Confirmer');
	});

	it('an unconfirmed reading: the ledger word is "Confirmer", never "à confirmer"', async () => {
		// 7n supersedes 7a/7c on this exact point, and it is the kind of correction a stale
		// component would silently keep failing to make.
		const { row } = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: { raw: '03/04/2026', pretty: '3 avril 2026', order: 'day-first' },
			interpretationConfirmed: false
		});

		expect(row.textContent).toContain('03/04/2026 → 3 avril 2026 · Confirmer');
		expect(row.textContent).not.toContain('à confirmer');
	});

	it('inconsistent: states the contradiction, with no raw/pretty pair to show', async () => {
		const { row } = await mount({ role: 'date', interpretation: 'inconsistent' });

		expect(row.textContent).toContain('Deux ordres de date dans cette colonne');
	});

	it('no-dates: a column full of content that is not dates', async () => {
		const { row } = await mount({ role: 'date', interpretation: 'no-dates' });

		expect(row.textContent).toContain('Aucune date dans cette colonne');
	});

	it('empty: blank on every row, its own sentence rather than sharing "no-dates"', async () => {
		// Separates "no value parses as a date" from "there was no value at all": 7m gives the two
		// their own key because the repairs differ (a wrong position vs content that is not dates).
		const { row } = await mount({ role: 'date', interpretation: 'empty' });

		expect(row.textContent).toContain('Colonne vide');
		expect(row.textContent).not.toContain('Aucune date dans cette colonne');
	});
});

/**
 * 7n: the triangle was withdrawn from this line because it was already registered for "plusieurs
 * candidates" and would carry two meanings on one screen. The existing `warningTriangle` snippet
 * must keep firing for `ambiguous`/`missingColumn`, so this is a "not here, still there" pair
 * rather than a single absence assertion, which could as easily mean the glyph broke everywhere.
 */
describe('RoleRow.svelte: no warning triangle on line 3, ever', () => {
	it('an unconfirmed reading carries no extra glyph beyond the chevron', async () => {
		const { container } = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: { raw: '03/04/2026', pretty: '3 avril 2026', order: 'day-first' },
			interpretationConfirmed: false
		});

		// One svg: the chevron. A second would be the withdrawn triangle come back.
		expect(container.querySelectorAll('svg').length).toBe(1);
	});

	it('the triangle is still there on the states that were never touched', async () => {
		const ambiguous = await mount({ role: 'date', state: 'ambiguous', candidateCount: 2 });
		expect(ambiguous.container.querySelectorAll('svg').length).toBe(2);
		ambiguous.container.remove();

		const missing = await mount({
			role: 'date',
			state: 'missingColumn',
			lostHeader: 'Date operation'
		});
		expect(missing.container.querySelectorAll('svg').length).toBe(2);
	});
});

/**
 * 7n: raw and the "· Confirmer" clause read zinc-500, the converted result zinc-700. Asserted as
 * actual computed colours against a same-page calibration element already known to carry each
 * class, rather than by reading the class list off the element under test: a class name is a
 * claim about the style and the computed colour is the style.
 */
describe('RoleRow.svelte: line 3 is two-tone, raw and "Confirmer" pale against the reading', () => {
	it('the reading half is zinc-700 and the rest of the line is zinc-500', async () => {
		const { row, container } = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: { raw: '03/04/2026', pretty: '3 avril 2026', order: 'day-first' },
			interpretationConfirmed: false
		});

		// Calibration: a designated Montant row's header span is a known `text-zinc-700`, and its
		// empty-state sentence is a known `text-zinc-500`. Grabbing their computed colours here,
		// on the SAME page, proves the two class names really do resolve to different colours
		// before that difference is used to tell the line's two spans apart.
		const reference = await mount({ role: 'amount', state: 'empty' });
		const zinc500 = getComputedStyle(
			reference.row.querySelector('span.text-zinc-500') as Element
		).color;
		reference.container.remove();

		const designatedReference = await mount({
			role: 'amount',
			state: 'designated',
			columnHeader: 'Montant',
			sampleValue: '-24,90'
		});
		const zinc700 = getComputedStyle(
			designatedReference.row.querySelector('span.text-zinc-700') as Element
		).color;
		designatedReference.container.remove();

		expect(zinc500).not.toBe(zinc700);

		// Leaf spans only: a container `span` also carries its descendants' text, so filtering by
		// text content over EVERY span (the earlier draft of this test) matched the flex wrapper
		// around all three lines instead of the text node inside it.
		const spans = Array.from(row.querySelectorAll('span')).filter(
			(span) => span.children.length === 0
		);
		expect(spans.length).toBeGreaterThanOrEqual(2);

		const prettySpan = spans.find((span) => span.textContent?.includes('3 avril 2026'));
		expect(prettySpan).not.toBeUndefined();
		expect(getComputedStyle(prettySpan as Element).color).toBe(zinc700);

		const rawSpan = spans.find((span) => span.textContent?.includes('03/04/2026'));
		expect(rawSpan).not.toBeUndefined();
		expect(getComputedStyle(rawSpan as Element).color).toBe(zinc500);

		const confirmSpan = spans.find((span) => span.textContent?.includes('Confirmer'));
		expect(confirmSpan).not.toBeUndefined();
		expect(getComputedStyle(confirmSpan as Element).color).toBe(zinc500);

		// Every other test in this file removes its mount; this one did not, which left a second
		// RoleRow in the document for whatever ran next. Its two reference mounts above are already
		// removed, so leaving this one was an omission rather than a decision.
		container.remove();
	});
});

/**
 * The line never wraps and never truncates: a wrap would break the 86 px invariant, and this is
 * the one line on the row deliberately given no `truncate`/ellipsis class, unlike every other
 * answer line in this component.
 */
/**
 * THE SPLIT MUST NOT CHANGE THE RENDERING, and no assertion on text could see this.
 *
 * Line 3 is one sentence drawn as three spans so the reading can carry its own colour. That is a
 * presentation device, so the rendered result must be identical to the same sentence drawn as one
 * span. It was not: the wrapper was a flex container, which makes each span a flex ITEM and trims
 * its own leading and trailing whitespace, so `"01/02/2026 \u2192 "` + `"1 f\u00e9vrier 2026"` +
 * `" \u00b7 Confirmer"` drew as `01/02/2026 \u21921 f\u00e9vrier 2026\u00b7 Confirmer`.
 *
 * The forty-one tests in this file passed under both layouts, because the DOM text was never
 * wrong. It was found by looking at the running screen. This is the assertion that can see it.
 */
describe('RoleRow.svelte: line 3 renders as one sentence, not three trimmed pieces', () => {
	it('does not lay line 3 out as a flex container, which would trim its spaces', async () => {
		const { row, container } = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'zone_1',
			interpretation: { raw: '01/02/2026', pretty: '1 février 2026', order: 'day-first' },
			interpretationConfirmed: false
		});

		const pieces = Array.from(row.querySelectorAll('span')).filter(
			(span) =>
				span.children.length === 0 && /Confirmer|février|01\/02/.test(span.textContent ?? '')
		);
		// The planted positive: the line really is drawn as several spans, so the layout question
		// below is about something that exists.
		expect(pieces.length).toBeGreaterThanOrEqual(3);

		// The spaces live at the EDGES of those spans, which is exactly what a flex container trims.
		const joined = pieces.map((span) => span.textContent ?? '').join('');
		expect(joined).toContain('→ 1');
		expect(joined).toContain('6 ·');

		// THIS IS A PROXY AND IS LABELLED ONE. Asserting the drawn width against a reference span
		// was tried first and measured the reference's own font rather than the line: 58.8 px of
		// disagreement on a correct line. What can be asserted stably is the CAUSE, because the
		// trimming is a property of flex layout rather than of these particular strings.
		const wrapper = pieces[0].parentElement as HTMLElement;
		expect(getComputedStyle(wrapper).display).not.toBe('flex');

		container.remove();
	});
});

describe('RoleRow.svelte: line 3 never wraps and never truncates', () => {
	it('carries whitespace-nowrap and no overflow-ellipsis class', async () => {
		const { row } = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: { raw: '03/04/2026', pretty: '3 avril 2026', order: 'day-first' },
			interpretationConfirmed: false
		});

		// Leaf spans only, for the same reason as the colour test above: a container span's
		// `textContent` includes its descendants', so an ancestor would otherwise match too and
		// this assertion would be checking the wrapper's classes rather than the text run's own.
		const spans = Array.from(row.querySelectorAll('span')).filter(
			(span) => span.children.length === 0 && span.textContent?.includes('avril')
		);
		expect(spans.length).toBeGreaterThan(0);
		for (const span of spans) {
			expect(span.className).toContain('whitespace-nowrap');
			expect(span.className).not.toContain('overflow-ellipsis');
			expect(span.className).not.toContain('truncate');
		}
	});
});

/**
 * The accessible name is composed from the SAME props as the visible text (the component's own
 * documented rule), so the interpretation states get their own aria sentence rather than the
 * generic "designated" one, which would announce a sample value the line no longer shows.
 */
describe('RoleRow.svelte: the accessible name follows the interpretation, for the states 7i names', () => {
	// The catalogue puts a NARROW NO-BREAK SPACE (U+202F) before this colon, per French
	// typography, unlike the plain space `import_columns_row_aria_designated` uses elsewhere in
	// this same file. Built from the character code rather than retyped, same reason this file
	// already pins the em dash that way: an escape does not survive being pasted back out.
	const NNBSP = String.fromCharCode(0x202f);

	/**
	 * THE CELL WHERE A DERIVED ORDER CANNOT BE DERIVED, and the reason the caller states it.
	 *
	 * Separates « the row announces the reading the caller APPLIED » from « the row announces a
	 * reading it worked out from the two strings it was handed ». `02/02/2026` reads identically
	 * both ways, so no comparison of raw against pretty can tell them apart: the second behaviour
	 * announces « Jour puis mois » to a screen reader whatever was chosen.
	 *
	 * This is not a corner. `ambiguous` is DEFINED as every component being at or below 12 on both
	 * sides, so a cell whose day equals its month is the canonical ambiguous cell, and it is the one
	 * the corpus generator names as reading the same under both orders. The user who meets this
	 * label is the one who cannot see the two cards to check it against.
	 */
	it('unconfirmed: announces the order the caller applied, on a cell that reads both ways', async () => {
		const monthFirst = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: { raw: '02/02/2026', pretty: '2 février 2026', order: 'month-first' },
			interpretationConfirmed: false
		});
		expect(monthFirst.row.getAttribute('aria-label')).toBe(
			`Date, colonne désignée${NNBSP}: Date operation, dates lues Mois puis jour, ordre à confirmer, non sélectionné`
		);
		monthFirst.container.remove();

		// The planted positive: the same palindromic cell under the other order must differ, so a
		// row that ignored `order` entirely could not pass both halves.
		const dayFirst = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: { raw: '02/02/2026', pretty: '2 février 2026', order: 'day-first' },
			interpretationConfirmed: false
		});
		expect(dayFirst.row.getAttribute('aria-label')).toBe(
			`Date, colonne désignée${NNBSP}: Date operation, dates lues Jour puis mois, ordre à confirmer, non sélectionné`
		);
		dayFirst.container.remove();
	});

	it('unconfirmed: names the header and the order the reading assumed', async () => {
		const dayFirst = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: { raw: '03/04/2026', pretty: '3 avril 2026', order: 'day-first' },
			interpretationConfirmed: false
		});
		expect(dayFirst.row.getAttribute('aria-label')).toBe(
			`Date, colonne désignée${NNBSP}: Date operation, dates lues Jour puis mois, ordre à confirmer, non sélectionné`
		);
		dayFirst.container.remove();

		// Separates "day-first was assumed" from "month-first was assumed": both are reachable from
		// the same raw cell, and the order is derived from which of raw's two numbers survived as
		// the pretty value's day, never hard-coded.
		const monthFirst = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: { raw: '03/04/2026', pretty: '4 mars 2026', order: 'month-first' },
			interpretationConfirmed: false
		});
		expect(monthFirst.row.getAttribute('aria-label')).toBe(
			`Date, colonne désignée${NNBSP}: Date operation, dates lues Mois puis jour, ordre à confirmer, non sélectionné`
		);
	});

	it('no-dates: names the column and states the finding, not a sample value', async () => {
		const { row } = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Client',
			interpretation: 'no-dates'
		});

		expect(row.getAttribute('aria-label')).toBe(
			`Date, colonne désignée${NNBSP}: Client, aucune date dans cette colonne`
		);
	});

	it('empty: names the column and states it is empty', async () => {
		const { row } = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			interpretation: 'empty'
		});

		expect(row.getAttribute('aria-label')).toBe(
			`Date, colonne désignée${NNBSP}: Date operation, colonne vide`
		);
	});

	/**
	 * #645. Measured on `/import/columns` before this: the name stated the reading while it was
	 * UNCONFIRMED and dropped it the moment it was confirmed, answering or proving it, falling back
	 * to « exemple 01/02/2026 » while line 3 showed `01/02/2026 → 2 janvier 2026`.
	 *
	 * Separates « the confirmed name states the order the caller applied » from « it states one it
	 * derived »: `02/02/2026` reads identically both ways, and the planted positive is the same cell
	 * under the other order, which must name the other reading.
	 */
	it('confirmed: states the order the caller applied and the first row under it', async () => {
		const monthFirst = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			sampleValue: '02/02/2026',
			interpretation: { raw: '02/02/2026', pretty: '2 février 2026', order: 'month-first' },
			interpretationConfirmed: true
		});
		expect(monthFirst.row.getAttribute('aria-label')).toBe(
			`Date, colonne désignée${NNBSP}: Date operation, dates lues Mois puis jour, première ligne${NNBSP}: 2 février 2026`
		);
		monthFirst.container.remove();

		const dayFirst = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			sampleValue: '02/02/2026',
			interpretation: { raw: '02/02/2026', pretty: '2 février 2026', order: 'day-first' },
			interpretationConfirmed: true
		});
		expect(dayFirst.row.getAttribute('aria-label')).toBe(
			`Date, colonne désignée${NNBSP}: Date operation, dates lues Jour puis mois, première ligne${NNBSP}: 2 février 2026`
		);
	});

	/**
	 * A column whose FORMAT settles its reading (ISO, `proven-shape`) has no day/month order to
	 * name, so the caller states `order: null` and the row keeps the plain designated name. Separates
	 * « no order stated » from « the default order stated as if the file had one »: « dates lues
	 * Jour puis mois » about `2026-06-24` is a claim about a column that makes none.
	 */
	it('confirmed with no order to state: the plain designated name, no reading claimed', async () => {
		const { row } = await mount({
			role: 'date',
			state: 'designated',
			columnHeader: 'Date operation',
			sampleValue: '2026-06-24',
			interpretation: { raw: '2026-06-24', pretty: '24 juin 2026', order: null },
			interpretationConfirmed: true
		});

		expect(row.getAttribute('aria-label')).toBe(
			'Date, colonne désignée : Date operation, exemple 2026-06-24'
		);
	});
});
