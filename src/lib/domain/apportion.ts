/**
 * Largest remainder apportionment for percentages a reader meets on screen.
 *
 * The defect this exists to remove: rounding each share on its own prints sets that sum to 99 or
 * to 101. Measured on 2026-09-08, two categories at 101,00 and 99,00 euros of a 200,00 euro total
 * printed 51 % and 50 %.
 *
 * The method is Hamilton, also called Hare-Niemeyer. Floor every share, count the points still
 * owed against the whole, and give them one at a time to the shares with the largest fractional
 * parts.
 *
 * TIES ARE BROKEN BY POSITION, and the honest statement of that is narrower than it sounds:
 * position decides only when the fractional parts are equal AS DOUBLES. Three exact thirds are,
 * because 100 / 3 evaluates to the same double three times, so they give 34, 33, 33. Shares that
 * are equal as fractions but reached by different divisions are not: measured on /net-worth on
 * 2026-09-08, 1010 and 5000 of 7000 both have a mathematical fractional part of 3/7, and the
 * doubles differ in the last places, so the second took the spare point and the legend read
 * 14, 72, 14 rather than 15, 71, 14. Both are valid apportionments and the total is 100 either
 * way; largest remainder does not promise a particular winner among equals. What it does promise,
 * and what this function delivers, is that the same input always gives the same answer.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO, and both are the reason it is one function rather than
 * a line at each call site.
 *
 * It does not set the last share to "the whole minus the others". That produces the right total
 * without following the apportionment, so the entire accumulated error lands on whichever share
 * is last rather than on the share with the weakest claim to a point.
 *
 * It does not apportion over the shares it is given when those are a subset. A donut whose legend
 * lists five categories and whose ring draws everything else as one unlabelled arc must not print
 * five rows summing to 100: that would tell the reader their five categories are all of their
 * spending. So the missing part of the whole competes for the spare points like any other share,
 * and is then dropped. That is what makes one rule correct both where the shares are the whole
 * (/net-worth) and where they are a subset (/reports).
 *
 * Shares are percentages already, 50.5 rather than 0.505, and are expected to be non-negative.
 *
 * ## Why largest remainder, and what it costs
 *
 * Balinski and Young proved that no apportionment method can both stay within quota and avoid the
 * population paradox. Keeping one means giving up the other, so this is a choice between two
 * trades rather than between a careful method and a careless one (M. L. Balinski and H. P. Young,
 * Fair Representation: Meeting the Ideal of One Man, One Vote, 2nd edition, Brookings Institution
 * Press, Washington DC, 2001).
 *
 * QUOTA IS THE PROPERTY KEPT. Every printed share is one of the two integers closest to its exact
 * value, so no figure on screen is further than a point from the share it claims to report. That
 * is the property a money application cannot trade away: a reader checking 34 % against a euro
 * total must never meet a number that is not adjacent to the truth. Measured 2026-09-08 over
 * 200 000 draws shaped like the call sites and 60 000 adversarial draws, plus every edge case in
 * `apportion.spec.ts`: zero violations. The detector was calibrated against the last-share
 * shortcut refused above, which left quota on all 20 000 subset draws.
 *
 * POPULATION MONOTONICITY IS THE PROPERTY GIVEN UP, and it reaches a reader rather than staying
 * theoretical. It is pinned as a test in `apportion.spec.ts` rather than only described here,
 * because a why-comment is precisely what nobody re-reads after the change that falsifies it.
 *
 * The trade is reversed by a divisor method (Webster, Huntington-Hill), not avoided: those remove
 * the paradox and leave quota instead, measured at 4 violations over 20 000 five-share draws on
 * these same inputs. Three claimants are the known exception where both properties are available
 * at once, which happens to be /net-worth's shape, and taking it there would mean two rules with a
 * condition between them rather than one rule correct everywhere.
 *
 * ## What this does not generalise to, so a later feature does not assume more than is here
 *
 * The whole is 100 or the sum of the shares, so this apportions PERCENTAGES and not an arbitrary
 * quantity: it cannot split a cent total across categories, and a caller wanting that needs a
 * different function rather than this one with a scaled input. A per-currency split is still
 * percentages, of a total someone had to convert, so the rate is the open question and this
 * function is not where it gets answered. Negative shares neither throw nor broke quota under
 * test, but a negative share beside an unlabelled remainder has no agreed meaning and no call site
 * produces one.
 */
export function apportionPercentages(shares: readonly number[]): number[] {
	const sum = shares.reduce((total, share) => total + share, 0);
	// The whole is 100, unless the shares already exceed it, in which case apportioning against
	// 100 would mean nothing and the shares themselves are the whole.
	const whole = Math.max(100, sum);
	// The part of the whole that carries no label. Zero when the shares are the whole.
	const withRemainder = [...shares, whole - sum];

	const floors = withRemainder.map((share) => Math.floor(share));
	const owed = Math.round(whole - floors.reduce((total, share) => total + share, 0));

	const byFraction = withRemainder
		.map((share, index) => ({ index, fraction: share - Math.floor(share) }))
		.sort((left, right) => right.fraction - left.fraction || left.index - right.index);

	for (const { index } of byFraction.slice(0, Math.max(0, owed))) {
		floors[index] += 1;
	}

	return floors.slice(0, shares.length);
}
