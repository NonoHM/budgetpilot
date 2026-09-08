import { describe, expect, it } from 'vitest';
import { apportionPercentages } from './apportion';

/**
 * Largest remainder, also called Hamilton or Hare-Niemeyer. Floor every share, count the points
 * still owed against 100, and hand them one at a time to the shares with the largest fractional
 * parts.
 *
 * The alternative this repository refuses, and the reason it is refused rather than merely not
 * chosen: setting the last share to "100 minus the others" produces the right total without
 * following the apportionment, so the whole accumulated error lands on whichever share happens to
 * be last. That is a different wrong figure, not a fix.
 */
describe('apportionPercentages', () => {
	/**
	 * Separates "the printed shares sum to the whole" from "each share was rounded on its own".
	 * The three inputs are the three cases measured on the shipped screens on 2026-09-08, where
	 * they printed 101, 99 and 101.
	 */
	it('gives the spare point to the larger fraction when two shares split 50.5 and 49.5', () => {
		expect.assertions(2);
		expect(apportionPercentages([50.5, 49.5])).toEqual([51, 49]);
		expect(apportionPercentages([50.5, 49.5]).reduce((a, b) => a + b, 0)).toBe(100);
	});

	it('breaks a three-way tie by position, so exact thirds give 34, 33, 33', () => {
		expect.assertions(2);
		const third = 100 / 3;
		expect(apportionPercentages([third, third, third])).toEqual([34, 33, 33]);
		expect(apportionPercentages([third, third, third]).reduce((a, b) => a + b, 0)).toBe(100);
	});

	it('hands two spare points to the two largest fractions', () => {
		expect.assertions(2);
		expect(apportionPercentages([16.667, 16.667, 66.666])).toEqual([17, 17, 66]);
		expect(apportionPercentages([16.667, 16.667, 66.666]).reduce((a, b) => a + b, 0)).toBe(100);
	});

	/**
	 * Separates "the apportionment runs over the whole the chart draws" from "it runs over the rows
	 * that happen to carry a label".
	 *
	 * This is the property that makes one rule correct at both kinds of site. On /net-worth the
	 * shares are the whole, so they come back summing to 100. On /reports they are the top five and
	 * the ring draws the rest as one unlabelled arc, so they must come back summing to their own
	 * share of the whole and never be inflated. The unlabelled remainder is apportioned too, and
	 * then dropped, which is what makes the labelled rows internally consistent with the arc beside
	 * them rather than merely adding up to something.
	 */
	it('does not inflate a labelled subset that sits beside a remainder', () => {
		expect.assertions(2);
		expect(apportionPercentages([30, 20, 10])).toEqual([30, 20, 10]);
		expect(apportionPercentages([33.4, 33.3, 8.3])).toEqual([34, 33, 8]);
	});

	/**
	 * Separates "the remainder competes for the spare points like any other share" from "the spare
	 * points are shared only between the labelled rows".
	 *
	 * 20.6 + 20.6 leaves a remainder of 58.8. Floors are 20, 20 and 58, which is 98, so two points
	 * are owed. The remainder's .8 outranks both .6 fractions and takes the first, and the second
	 * goes to the first .6. If the remainder did not compete, both labelled rows would gain a point
	 * and print 21 and 21 against an arc that is drawing 58.8.
	 */
	it('lets the unlabelled remainder win a spare point ahead of a labelled row', () => {
		expect.assertions(1);
		expect(apportionPercentages([20.6, 20.6])).toEqual([21, 20]);
	});

	/** Separates "a degenerate input returns something usable" from "it throws or returns NaN". */
	it('survives an empty set, a single whole share, and shares that overshoot 100', () => {
		expect.assertions(3);
		expect(apportionPercentages([])).toEqual([]);
		expect(apportionPercentages([100])).toEqual([100]);
		expect(apportionPercentages([60.5, 60.5])).toEqual([61, 60]);
	});
});
