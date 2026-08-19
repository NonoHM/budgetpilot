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

function mount(props: Record<string, unknown>) {
	const { container } = render(RoleRow, { ...BASE, ...props });
	container.style.width = '320px';
	const row = container.firstElementChild as HTMLElement;
	expect(row).not.toBeNull();
	return { container, row };
}

describe('RoleRow.svelte: three heights, and each is a different kind of thing', () => {
	it('is 68 px at 390, which is a two-line ROW and not a control', () => {
		// 13 top air + 20 line 1 + 4 gap + 18 line 2 + 13 bottom air. The product's control heights
		// are 44 and 48 and this is neither, deliberately: 48 does not hold two lines with air. The
		// figure that has to be respected is the touch-target floor, and 68 clears it by 20.
		const { row } = mount({});

		expect(row.getBoundingClientRect().height).toBe(68);
	});

	it('is 68 px in every interactive state, so nothing shifts as answers arrive', () => {
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
			const { row, container } = mount(props);
			expect(row.getBoundingClientRect().height, `state ${props.state}`).toBe(68);
			container.remove();
		}
		// The absolute figure beside the loop: an empty `states` array would satisfy every
		// assertion in it.
		expect(states.length).toBe(6);
	});

	it('is 56 px in compact form, asserted absolutely and not merely as "smaller"', () => {
		// 20 air + 18 line 1 + 2 gap + 16 line 2. Both heights are pinned to their own number: a
		// test asserting only that compact is shorter passes in a world where both are 0.
		const { row } = mount({ compact: true });

		expect(row.getBoundingClientRect().height).toBe(56);
	});

	it('is 64 px as a recapitulatif, which is a third thing and not a smaller row', () => {
		// 4 air + 18 role + 3 + 16 + 3 + 16 + 4. It was 44 while the row held ONE line, and the
		// line it held is the arrow A8 is about. A row that states two facts cannot be one line,
		// so the plate's 44 is deviated from deliberately and the deviation is recorded at the
		// site rather than rounded away.
		const { row } = mount({
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

	it('is 64 px whatever the recapitulatif row has to show', () => {
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
			const { row, container } = mount({ state: 'recap', ...shape });
			expect(row.getBoundingClientRect().height, JSON.stringify(shape)).toBe(64);
			container.remove();
		}
		expect(shapes.length).toBe(4);
	});

	it('states the column and the value as two facts, never as one pairing', () => {
		// A8. Separates "the row shows a column name and a value" from "the row claims that column
		// produced that value". The column is read LIVE from the correspondance and the value comes
		// from this batch's transactions, so after a correction the two halves are from different
		// readings and `Date operation · 24/06/2026` asserts they are not.
		//
		// Asserted by ORDER rather than by the absence of a separator glyph, because a middot swapped
		// for a dash, an arrow or a slash is the same claim and would leave a `not.toContain('·')`
		// green. What has to hold is that the value is introduced by its own label.
		const { row } = mount({
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

	it('states no value fact when this import left no value to read', () => {
		// Separates "the labels are printed" from "a fact is stated only when there is one". A batch
		// whose transactions are gone gives every role an empty sample, and a row reading
		// « Lu par cet import : » with nothing after it is a label doing a fact's job.
		const { row } = mount({
			state: 'recap',
			columnHeader: 'Date operation',
			columnIndex: 0,
			sampleValue: ''
		});

		expect(row.textContent).toContain(COLUMN_LABEL);
		expect(row.textContent).not.toContain(VALUE_LABEL);
	});

	it('names no column in a recapitulatif when the role holds none', () => {
		// `Colonne N` is the right fallback for a designated column with an unreadable header and a
		// LIE for a role that was never designated: it would tell a user reading their memorised
		// correspondance that their categories came from column 1 of a file that had no category
		// column. Catégorie says so in its own words.
		const { row } = mount({ state: 'recap', role: 'category' });

		expect(row.textContent).not.toContain('Colonne 1');
		expect(row.textContent).toContain('Aucune');
		// And it states neither fact: there is no memorised column and there was no value.
		expect(row.textContent).not.toContain(COLUMN_LABEL);
		expect(row.textContent).not.toContain(VALUE_LABEL);
	});
});

describe('RoleRow.svelte: the row is the target and the chevron is not a second one', () => {
	it('has exactly one tab stop and one accessible name', () => {
		const { container } = mount({});

		expect(container.querySelectorAll('button').length).toBe(1);
		// A separate chevron button would be a second stop for one action and a second name for one
		// thing. Asserted by counting, because "there is a button" cannot see a duplicate.
		expect(container.querySelectorAll('svg').length).toBe(1);
		expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('calls onOpen once from the row itself', async () => {
		const onOpen = vi.fn();
		mount({ onOpen });

		await page.getByRole('button').click();

		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it('moves aria-expanded and takes the open surface without a transition', () => {
		const closed = mount({});
		expect(closed.row.getAttribute('aria-expanded')).toBe('false');
		expect(getComputedStyle(closed.row).transitionDuration).toBe('0.12s');
		closed.container.remove();

		// A row never animates into a state it did not reach by touch: pressing eases over 120 ms,
		// opening is instantaneous. Same property, two behaviours, which is why the transition is
		// conditional rather than constant. Both halves asserted: a single reading cannot tell a
		// conditional transition from an absent one.
		const open = mount({ expanded: true });
		expect(open.row.getAttribute('aria-expanded')).toBe('true');
		expect(getComputedStyle(open.row).transitionDuration).toBe('0s');
	});
});

describe('RoleRow.svelte: the answer line, one test per state', () => {
	it('empty: asks for a column, and names the role in the accessible name', () => {
		const { row } = mount({ role: 'amount', state: 'empty' });

		expect(row.textContent).toContain('Choisir une colonne');
		// « bouton » is the ROLE and the assistive technology contributes it. Writing it into the
		// label would announce it twice.
		expect(row.getAttribute('aria-label')).toBe('Montant, aucune colonne désignée');
		expect(row.getAttribute('aria-label')).not.toContain('bouton');
	});

	it('optional and empty: states the consequence, with no triangle and no tint', () => {
		// A consequence, not a warning. Nobody did anything wrong by leaving it empty.
		const { row, container } = mount({ role: 'category', state: 'empty', optional: true });

		// Copied from the handoff's state table, not composed. The design is the source of truth for
		// UI strings, so the punctuation is the plate's and not this repository's prose convention.
		expect(row.textContent).toContain('les transactions arriveront non catégorisées');
		expect(row.textContent).toContain('Optionnel');
		// One svg, the chevron. A triangle here would be the second one.
		expect(container.querySelectorAll('svg').length).toBe(1);
	});

	it('requiredness is marked BY EXCEPTION: the three required rows carry no badge at all', () => {
		// No asterisks anywhere. The presence half is the test above; this is the absence half, and
		// it is asserted across all three rather than on one, because a badge rendered on `date`
		// only would pass a single-row check.
		for (const role of ['date', 'label', 'amount']) {
			const { row, container } = mount({ role, state: 'empty' });
			expect(row.textContent, role).not.toContain('Optionnel');
			container.remove();
		}
	});

	it('ambiguous: the count is in the accessible name, not only in the glyph', () => {
		const { row, container } = mount({ role: 'date', state: 'ambiguous', candidateCount: 2 });

		expect(row.textContent).toContain('2 colonnes possibles');
		expect(row.getAttribute('aria-label')).toBe('Date, 2 colonnes possibles');
		// Chevron plus the warning triangle.
		expect(container.querySelectorAll('svg').length).toBe(2);
	});

	it('designated: header, dot, example, and the example is what truncates', () => {
		const { row } = mount({
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

	it('designated with an unreadable header: named by position, with the raw bytes NOT in the row', () => {
		// The raw text lives in the picker card. The row is where you check your answer at a glance,
		// and a line of mojibake in it is noise rather than evidence.
		const { row } = mount({
			role: 'label',
			state: 'designated',
			columnHeader: '',
			columnIndex: 4,
			sampleValue: 'CARTE 22/06 CARREFOUR'
		});

		expect(row.textContent).toContain('Colonne 5');
		expect(row.getAttribute('aria-label')).toContain('colonne désignée : Colonne 5');
	});

	it('vacated: says who took it, and NEVER reads as if it emptied itself', () => {
		const { row } = mount({ role: 'date', state: 'vacated', vacatedBy: 'label' });

		expect(row.textContent).toContain('Reprise par Libellé');
		// The absence assertion that carries the whole meaning of this state, with its presence
		// established by the `empty` test above: a vacated row showing `Choisir une colonne` would
		// look self-emptied, and the user would not know a designation had moved.
		expect(row.textContent).not.toContain('Choisir une colonne');
		expect(row.getAttribute('aria-label')).toBe('Date, reprise par Libellé, à redésigner');
	});

	it('vacated: the VISIBLE string takes the plate dash and the SPOKEN one takes a comma', () => {
		// Not an inconsistency and not an oversight: the plate's state table gives the visible line
		// « Reprise par Libelle [U+2014] a redesigner » and the accessible name « Date, reprise par
		// Libelle, a redesigner, bouton ». A dash is typography and a screen reader does not read it,
		// so the spoken form needs a separator that survives being spoken.
		//
		// Pinned because this is precisely what a future sweep of the repository's no-em-dash rule
		// would "fix". That rule governs OUR prose; the design is the source of truth for UI strings,
		// and this is a UI string.
		const { row } = mount({ role: 'date', state: 'vacated', vacatedBy: 'label' });

		expect(row.textContent).toContain(
			`Reprise par Libellé ${String.fromCharCode(8212)} à redésigner`
		);
		expect(row.getAttribute('aria-label')).not.toContain(String.fromCharCode(8212));
	});

	it('missing column: quotes the OLD header, because it is gone from the new file', () => {
		const { row } = mount({ role: 'amount', state: 'missingColumn', lostHeader: 'Montant' });

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
	it('recap: not a button, not focusable, and it receives no focus when tabbed to', () => {
		const { row, container } = mount({
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
	it('renders none of the seven states as disabled or aria-disabled', () => {
		// Recorded as a test rather than as a comment because "for completeness" is exactly how a
		// disabled state gets added. No file combination produces one: even with all three required
		// roles taken, Categorie stays designable, since a column may carry two roles.
		const states = ['empty', 'ambiguous', 'designated', 'vacated', 'missingColumn'];

		for (const state of states) {
			const { row, container } = mount({ state, candidateCount: 2, vacatedBy: 'label' });
			expect(row.hasAttribute('disabled'), state).toBe(false);
			expect(row.getAttribute('aria-disabled'), state).toBeNull();
			container.remove();
		}
		expect(states.length).toBe(5);
	});
});
