import { describe, expect, it } from 'vitest';
import { DATE_ORDERS, decideDateOrder } from './dateOrder';
import type { DateOrder, DateOrderVerdict } from './dateOrder';

/**
 * The ONE definition of what a verdict plus an override mean together.
 *
 * Written as a table over every (verdict, override) pair rather than as a test per branch,
 * because the thing that can go wrong here is not a branch computing the wrong answer: it is a
 * pair nobody thought about, and a test per branch enumerates the branches somebody thought of.
 * Five verdicts times three override states is fifteen, and fifteen is small enough to write out.
 *
 * ## What happened to the answer is part of the decision (#619)
 *
 * The file's proof outranks a user's answer (#613), and that precedence is unchanged. What #619
 * adds is that the decision SAYS so: an answer the proof overruled comes back as `overruled`,
 * carrying the proving cell, so the summary can tell the user rather than discarding the answer in
 * silence. `applied` is the one branch where the answer decided; `unused` is every branch where no
 * answer was given or where it could change nothing.
 */

const RESOLVED_DAY: DateOrderVerdict = {
	kind: 'resolved',
	order: 'day-first',
	evidence: '24/06/2026'
};
const RESOLVED_MONTH: DateOrderVerdict = {
	kind: 'resolved',
	order: 'month-first',
	evidence: '06/24/2026'
};
const CONTRADICTORY: DateOrderVerdict = {
	kind: 'contradictory',
	dayFirstEvidence: '24/06/2026',
	monthFirstEvidence: '06/24/2026'
};
const AMBIGUOUS: DateOrderVerdict = { kind: 'ambiguous', sample: '06/01/2026', sampleIndex: 0 };
const NOTHING: DateOrderVerdict = { kind: 'nothing-to-decide' };

describe('decideDateOrder', () => {
	/**
	 * Separates "the file's own proof decides, and says it overruled the answer" from "whatever
	 * was passed in decides" AND from "the proof decides in silence", which was #619. The proving
	 * cell rides the decision because the user can only check a claim beside the value it rests on.
	 */
	it('applies the file s proof over a contradicting override, and says so', () => {
		expect.assertions(2);
		expect(decideDateOrder(RESOLVED_DAY, 'month-first')).toStrictEqual({
			kind: 'read',
			order: 'day-first',
			answer: 'overruled',
			proof: '24/06/2026'
		});
		expect(decideDateOrder(RESOLVED_MONTH, 'day-first')).toStrictEqual({
			kind: 'read',
			order: 'month-first',
			answer: 'overruled',
			proof: '06/24/2026'
		});
	});

	/**
	 * Separates "an answer the proof agrees with overrules nothing" from "any answer on a proven
	 * file is reported overruled". The boundary of the rule is the disagreement, not the answer.
	 */
	it('reports nothing overruled when the answer agrees with the proof, or when there is none', () => {
		expect.assertions(4);
		expect(decideDateOrder(RESOLVED_DAY, 'day-first')).toStrictEqual({
			kind: 'read',
			order: 'day-first',
			answer: 'unused'
		});
		expect(decideDateOrder(RESOLVED_MONTH, 'month-first')).toStrictEqual({
			kind: 'read',
			order: 'month-first',
			answer: 'unused'
		});
		expect(decideDateOrder(RESOLVED_DAY, undefined)).toStrictEqual({
			kind: 'read',
			order: 'day-first',
			answer: 'unused'
		});
		expect(decideDateOrder(RESOLVED_MONTH, undefined)).toStrictEqual({
			kind: 'read',
			order: 'month-first',
			answer: 'unused'
		});
	});

	/**
	 * Separates "a self-contradictory file is refused" from "a self-contradictory file is read
	 * under one of its two readings". Both cells are carried, because neither is wrong alone.
	 */
	it('refuses a mixed column whatever the override says', () => {
		expect.assertions(3);
		const refusal = { kind: 'refuse', dayFirst: '24/06/2026', monthFirst: '06/24/2026' };
		expect(decideDateOrder(CONTRADICTORY, undefined)).toStrictEqual(refusal);
		expect(decideDateOrder(CONTRADICTORY, 'day-first')).toStrictEqual(refusal);
		expect(decideDateOrder(CONTRADICTORY, 'month-first')).toStrictEqual(refusal);
	});

	/**
	 * Separates "the override settles what the file leaves open" from "the override is ignored".
	 * `ambiguous` is the ONLY verdict where an override changes the answer, which is what makes
	 * the option an override rather than configuration.
	 */
	it('lets an override settle an ambiguous column', () => {
		expect.assertions(2);
		expect(decideDateOrder(AMBIGUOUS, 'month-first')).toStrictEqual({
			kind: 'read',
			order: 'month-first',
			answer: 'applied'
		});
		expect(decideDateOrder(AMBIGUOUS, 'day-first')).toStrictEqual({
			kind: 'read',
			order: 'day-first',
			answer: 'applied'
		});
	});

	/**
	 * Separates "an undecided file keeps the default" from "an undecided file changes behaviour".
	 * The auto path asks before this is reached (`csv.ts`'s ambiguous-date-order refusal); the
	 * designation screen's close without an answer is the waiver that lands here.
	 */
	it('reads an ambiguous column day-first when nobody has said', () => {
		expect.assertions(1);
		expect(decideDateOrder(AMBIGUOUS, undefined)).toStrictEqual({
			kind: 'read',
			order: 'day-first',
			answer: 'unused'
		});
	});

	/**
	 * Separates "a file with no ambiguous cell takes the default" from "it takes the override".
	 * An ISO file has no cell the override could apply to, so the two readings are the same file
	 * and the override is inert rather than honoured, and inert is not overruled: nothing in the
	 * file contradicts the answer.
	 */
	it('takes the default when there is nothing to decide, override or not', () => {
		expect.assertions(3);
		const dayFirst = { kind: 'read', order: 'day-first', answer: 'unused' };
		expect(decideDateOrder(NOTHING, undefined)).toStrictEqual(dayFirst);
		expect(decideDateOrder(NOTHING, 'day-first')).toStrictEqual(dayFirst);
		expect(decideDateOrder(NOTHING, 'month-first')).toStrictEqual(dayFirst);
	});
});

/**
 * #619's GATE, and the reason it is a property rather than one more row above: the day an answer
 * gains a new producer, the pairs it can reach are whatever that producer makes reachable, and a
 * gate written about today's producers says nothing about tomorrow's.
 *
 * Over every verdict and every answer, from the closed sets: an answer the file's proof DISAGREES
 * with is reported overruled, and nothing else is. The positive and the negative are taken by the
 * same scan and both counted, so a detector that never fires cannot pass as a clean table.
 */
describe('an answer the file overrules is never discarded in silence (#619)', () => {
	const VERDICTS = [RESOLVED_DAY, RESOLVED_MONTH, CONTRADICTORY, AMBIGUOUS, NOTHING];
	const ANSWERS: (DateOrder | undefined)[] = [undefined, ...DATE_ORDERS];

	it('reports overruled exactly where a proof disagrees with the answer', () => {
		expect.assertions(3);
		let overruled = 0;
		let other = 0;
		const mismatches: string[] = [];

		for (const verdict of VERDICTS)
			for (const answer of ANSWERS) {
				const decision = decideDateOrder(verdict, answer);
				const disagrees =
					verdict.kind === 'resolved' && answer !== undefined && answer !== verdict.order;
				const reported = decision.kind === 'read' && decision.answer === 'overruled';
				if (reported !== disagrees) mismatches.push(`${verdict.kind}/${answer}`);
				if (reported) overruled++;
				else other++;
			}

		expect(mismatches).toStrictEqual([]);
		// The two disagreeing pairs, and the thirteen that are not: the scan read all fifteen.
		expect(overruled).toBe(2);
		expect(other).toBe(13);
	});
});
