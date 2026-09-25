import { describe, expect, it } from 'vitest';
import { decideDateOrder } from './dateOrder';
import type { DateOrderVerdict } from './dateOrder';

/**
 * The ONE definition of what a verdict plus an override mean together.
 *
 * Written as a table over every (verdict, override) pair rather than as a test per branch,
 * because the thing that can go wrong here is not a branch computing the wrong answer: it is a
 * pair nobody thought about, and a test per branch enumerates the branches somebody thought of.
 * Four verdicts times three override states is twelve, and twelve is small enough to write out.
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
	 * Separates "the file's own proof decides" from "whatever was passed in decides". The two
	 * disagree on exactly this row: a column proving day-first, an override saying month-first.
	 */
	it('applies the file s proof over a contradicting override', () => {
		expect.assertions(2);
		expect(decideDateOrder(RESOLVED_DAY, 'month-first')).toEqual({
			kind: 'read',
			order: 'day-first'
		});
		expect(decideDateOrder(RESOLVED_MONTH, 'day-first')).toEqual({
			kind: 'read',
			order: 'month-first'
		});
	});

	/**
	 * Separates "a self-contradictory file is refused" from "a self-contradictory file is read
	 * under one of its two readings". Both cells are carried, because neither is wrong alone.
	 */
	it('refuses a mixed column whatever the override says', () => {
		expect.assertions(3);
		const refusal = { kind: 'refuse', dayFirst: '24/06/2026', monthFirst: '06/24/2026' };
		expect(decideDateOrder(CONTRADICTORY, undefined)).toEqual(refusal);
		expect(decideDateOrder(CONTRADICTORY, 'day-first')).toEqual(refusal);
		expect(decideDateOrder(CONTRADICTORY, 'month-first')).toEqual(refusal);
	});

	/**
	 * Separates "the override settles what the file leaves open" from "the override is ignored".
	 * `ambiguous` is the ONLY verdict where an override changes the answer, which is what makes
	 * the option an override rather than configuration.
	 */
	it('lets an override settle an ambiguous column', () => {
		expect.assertions(2);
		expect(decideDateOrder(AMBIGUOUS, 'month-first')).toEqual({
			kind: 'read',
			order: 'month-first'
		});
		expect(decideDateOrder(AMBIGUOUS, 'day-first')).toEqual({ kind: 'read', order: 'day-first' });
	});

	/**
	 * Separates "an undecided file keeps today's reading" from "an undecided file changes
	 * behaviour". THE INTERIM STATE: the stated rule says a file exhibiting the ambiguity should
	 * ASK, and nothing can ask until the question screen exists. Gated in
	 * `dateOrderQuestionAsleep.spec.ts`, not left to this comment.
	 */
	it('reads an ambiguous column day-first when nobody has said, which is today s behaviour', () => {
		expect.assertions(1);
		expect(decideDateOrder(AMBIGUOUS, undefined)).toEqual({ kind: 'read', order: 'day-first' });
	});

	/**
	 * Separates "a file with no ambiguous cell takes the default" from "it takes the override".
	 * An ISO file has no cell the override could apply to, so the two readings are the same file
	 * and the override is inert rather than honoured.
	 */
	it('takes the default when there is nothing to decide, override or not', () => {
		expect.assertions(3);
		const dayFirst = { kind: 'read', order: 'day-first' };
		expect(decideDateOrder(NOTHING, undefined)).toEqual(dayFirst);
		expect(decideDateOrder(NOTHING, 'day-first')).toEqual(dayFirst);
		expect(decideDateOrder(NOTHING, 'month-first')).toEqual(dayFirst);
	});
});
