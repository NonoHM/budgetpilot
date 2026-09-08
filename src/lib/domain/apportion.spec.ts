import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { apportionPercentages } from './apportion';

/** Cents to percentages, which is the only way a call site reaches this function. */
const sharesOf = (cents: readonly number[]): number[] => {
	const total = cents.reduce((sum, amount) => sum + amount, 0);
	return cents.map((amount) => (amount / total) * 100);
};

/** The real input domain: whole cents over a real total, one to five of them. */
const centsShares = (count: number) =>
	fc
		.array(fc.integer({ min: 0, max: 500_000 }), { minLength: count, maxLength: count })
		.filter((cents) => cents.reduce((sum, amount) => sum + amount, 0) > 0)
		.map(sharesOf);

/** How many printed shares are NOT one of the two integers closest to their exact value. */
function quotaViolations(shares: readonly number[], printed: readonly number[]): number {
	let count = 0;
	for (let index = 0; index < shares.length; index++) {
		const printedShare = printed[index];
		if (printedShare < Math.floor(shares[index]) || printedShare > Math.ceil(shares[index])) {
			count += 1;
		}
	}
	return count;
}

/**
 * The design `apportion.ts` refuses, reproduced here for one purpose only: it is KNOWN to leave
 * quota, so it is what proves the detector below can detect. Nothing ships this.
 */
function lastShareShortcut(shares: readonly number[]): number[] {
	const printed = shares.map((share) => Math.round(share));
	if (printed.length > 0) {
		printed[printed.length - 1] = 100 - printed.slice(0, -1).reduce((sum, s) => sum + s, 0);
	}
	return printed;
}

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

	/**
	 * QUOTA, which is the property this method is chosen for and the reason the docstring cites
	 * Balinski and Young: every printed share is one of the two integers closest to its exact value,
	 * so no figure on screen is more than a point from the truth.
	 *
	 * ## The calibration is the point, and it is asserted alongside the result
	 *
	 * A clean property run says nothing about the generator: a zero here and a generator that never
	 * reached a shape where quota can break produce the identical green. So the SAME detector is
	 * pointed at the last-share shortcut this module refuses, which is known to leave quota, and it
	 * has to come back with violations. The draw count is asserted for the same reason, because a
	 * property that ran zero times also reports zero violations.
	 */
	it('stays within quota on every share, where the refused shortcut does not', () => {
		expect.assertions(4);
		let drawn = 0;
		let shippedViolations = 0;
		let shortcutViolations = 0;

		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5 }).chain((count) => centsShares(count)),
				(whole) => {
					// Both shapes a call site produces: the shares ARE the whole (/net-worth), and the
					// shares are the top rows of a larger set so they sum below 100 (/reports).
					const subset = whole.map((share) => share * 0.7);
					drawn += 1;
					for (const shares of [whole, subset]) {
						shippedViolations += quotaViolations(shares, apportionPercentages(shares));
						shortcutViolations += quotaViolations(shares, lastShareShortcut(shares));
					}
					return true;
				}
			),
			{ numRuns: 2000 }
		);

		expect(drawn).toBeGreaterThanOrEqual(2000);
		expect(shortcutViolations).toBeGreaterThan(0);
		expect(shippedViolations).toBe(0);
		expect(quotaViolations([100], apportionPercentages([100]))).toBe(0);
	});

	/**
	 * The population paradox this method ACCEPTS, pinned rather than only described, because the
	 * trade recorded in the docstring is a why-comment and nothing in this repository checks
	 * comments.
	 *
	 * Separates "largest remainder, which buys quota and pays for it with the paradox" from "a
	 * divisor method, which pays the other way round". Constructed from whole cents on 2026-09-08:
	 * the first category rises from 305,00 to 306,00 euros of an unchanged 1 000,00 euro month, its
	 * exact share rises from 30,5 to 30,6, and its printed figure FALLS from 31 to 30, because the
	 * two sibling categories moved and took the spare point between them.
	 *
	 * A red here means the method changed and the trade the docstring records is no longer the one
	 * being made. It is not a defect to fix in this file.
	 */
	it('accepts the population paradox that buying quota costs', () => {
		expect.assertions(4);
		const monthOne = sharesOf([30_500, 30_300, 39_200]);
		const monthTwo = sharesOf([30_600, 30_700, 38_700]);

		expect(monthTwo[0]).toBeGreaterThan(monthOne[0]);
		expect(apportionPercentages(monthOne)).toEqual([31, 30, 39]);
		expect(apportionPercentages(monthTwo)).toEqual([30, 31, 39]);
		expect(apportionPercentages(monthTwo)[0]).toBeLessThan(apportionPercentages(monthOne)[0]);
	});
});
