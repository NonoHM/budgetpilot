import { describe, expect, it } from 'vitest';
import { columnDateState, type ColumnDateState } from './columnDateState';
import { decideDateOrder, detectDateOrder } from './dateOrder';
import { DATE_ORDERS, readingForState, type DateOrder } from '$lib/domain/dateReading';

/**
 * # THE SCREEN AND THE PARSER MUST APPLY THE SAME READING, and two implementations exist.
 *
 * `decideDateOrder` is the one definition of the precedence: evidence first, the answer only where
 * the column leaves the question genuinely open. The designation screen cannot call it, because it
 * runs in the browser and detection reads whole columns on the server, so it draws line 3 from a
 * SECOND ladder over `ColumnDateState`. `readingForState` is that ladder, pulled out of the
 * component so it can be compared rather than described.
 *
 * Two ladders is two answers unless something checks. The cost of disagreement is the standing bar
 * itself: the row would state a date the import will not write, which is a false displayed figure
 * and data written wrong that looks right, at once. `ColumnDesignationScreen`'s own docstring said
 * « stating it twice would be two answers » and then stated it twice, with nothing between them.
 *
 * ## Why this compares OUTPUTS over a cross product rather than reading either implementation
 *
 * A test that retyped the ladder would assert the retyping. This one drives both sides from the
 * SAME CELLS: the column goes through `columnDateState` for the screen's input and through
 * `detectDateOrder` for the parser's, which is how the two reach each other in production, and the
 * answers are compared. The cells are the only thing written down here.
 *
 * ## The one state where they do not compare, and it is asserted rather than skipped
 *
 * `inconsistent` is a REFUSAL on the parser's side, so there is no reading to agree about. The
 * screen states « Deux ordres de date dans cette colonne » and no date. That state is named below
 * and the refusal set is asserted to be exactly it, so a new state that started refusing could not
 * slip past by simply not being in this table.
 */

/**
 * One representative column per state, and the state each one produces is ASSERTED rather than
 * assumed. A cell that stopped producing the state it is filed under would otherwise make this
 * table agree about a state it never exercised.
 */
const COLUMNS: Record<ColumnDateState, readonly string[]> = {
	// 24 cannot be a month, so the column names its own position.
	'proven-day': ['24/06/2026', '06/01/2026'],
	'proven-month': ['06/24/2026', '06/01/2026'],
	// No cell carries the ambiguous grammar at all, and the format settles the order.
	'proven-shape': ['2026-06-24', '2026-01-06'],
	// Every cell reads both ways. THE ONLY STATE THAT ASKS ANYBODY ANYTHING.
	ambiguous: ['06/01/2026', '02/03/2026'],
	// Both readings proved, in one column.
	inconsistent: ['24/06/2026', '06/24/2026'],
	// Cells, none of them a date under either reading.
	'no-dates': ['CARREFOUR MARKET', 'SNCF'],
	empty: ['', '   ']
};

/** The states the parser REFUSES rather than reading. Asserted below, not trusted. */
const REFUSED: readonly ColumnDateState[] = ['inconsistent'];

const EVERY_STATE = Object.keys(COLUMNS) as ColumnDateState[];

/** Unanswered, plus each reading a user can answer. The answer is null for most of the table. */
const ANSWERS: readonly (DateOrder | null)[] = [null, ...DATE_ORDERS];

describe('the screen applies the reading the parser will apply', () => {
	/**
	 * THE TABLE IS ALIVE. Separates « each column produces the state it is filed under » from « the
	 * agreement below compares two functions over columns that landed in the wrong rows ». Without
	 * this, a cell that stopped being ambiguous would make the ambiguous row assert nothing.
	 */
	it('produces the state each column is filed under', () => {
		expect.assertions(EVERY_STATE.length + 1);
		for (const state of EVERY_STATE) expect(columnDateState(COLUMNS[state])).toBe(state);
		// The seven values, so a state added to the type without a column here fails rather than
		// being silently untested.
		expect(EVERY_STATE.length).toBe(7);
	});

	/**
	 * Separates « the refusal set is exactly `inconsistent` » from « the states this table happens
	 * to list ». A new state that refused would otherwise be absent from the comparison below with
	 * nothing saying so.
	 */
	it('refuses exactly the states named as refusals', () => {
		expect.assertions(EVERY_STATE.length);
		for (const state of EVERY_STATE) {
			const decision = decideDateOrder(detectDateOrder(COLUMNS[state]), undefined);
			expect(decision.kind === 'refuse').toBe(REFUSED.includes(state));
		}
	});

	/**
	 * THE ONE THAT CARRIES THE BAR. Twenty-one cells: seven states by three answers, minus the one
	 * refusal, compared pair by pair. A loop asserting one figure across a set says nothing about
	 * which member it read, so the state and the answer are named in the message of every failure by
	 * being asserted inside the loop with their own context.
	 */
	it('agrees with the parser for every state and every answer', () => {
		const disagreements: string[] = [];
		let compared = 0;

		for (const state of EVERY_STATE) {
			for (const answer of ANSWERS) {
				const decision = decideDateOrder(detectDateOrder(COLUMNS[state]), answer ?? undefined);
				if (decision.kind === 'refuse') continue;
				compared += 1;
				const screen = readingForState(state, answer);
				if (screen !== decision.order) {
					disagreements.push(
						`${state} + ${answer ?? 'no answer'}: screen ${screen}, parser ${decision.order}`
					);
				}
			}
		}

		// THE ABSOLUTE FIGURE beside the emptiness, without which a comparison that ran zero times
		// reports the identical pass. Six states read, three answers each.
		expect(compared).toBe(18);
		expect(disagreements).toEqual([]);
	});

	/**
	 * THE ANSWER REACHES EXACTLY ONE STATE, on both sides. Separates « the answer is honoured where
	 * the file leaves the question open » from « the answer is honoured » — the second would let an
	 * answer outrank a column containing `24/06/2026`, which refuses that row and moves every
	 * ambiguous row beside it by up to eleven months.
	 */
	it('lets the answer change the reading in exactly one state', () => {
		expect.assertions(2);
		const moved = EVERY_STATE.filter(
			(state) => readingForState(state, 'month-first') !== readingForState(state, null)
		);
		expect(moved).toEqual(['ambiguous']);
		// And the parser says the same thing about the same set, which is what makes the line above
		// a cross-check rather than a statement about one implementation.
		const movedInParser = EVERY_STATE.filter((state) => {
			const withAnswer = decideDateOrder(detectDateOrder(COLUMNS[state]), 'month-first');
			const without = decideDateOrder(detectDateOrder(COLUMNS[state]), undefined);
			return (
				withAnswer.kind === 'read' && without.kind === 'read' && withAnswer.order !== without.order
			);
		});
		expect(movedInParser).toEqual(['ambiguous']);
	});
});
