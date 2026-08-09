import { describe, expect, it } from 'vitest';
import { applyKindSign } from './transaction';
import { formatCents } from './budget';

/**
 * THE NUMERIC ASSERTIONS IN THIS FILE CANNOT SEE THE DEFECT THEY SIT NEXT TO, AND THAT IS THE
 * POINT. `-0 === 0` is true in JavaScript, so `expect(applyKindSign(0, 'expense')).toBe(0)` passes
 * whether the function returns `0` or `-0`. Only `Object.is` distinguishes them, and only the
 * FORMATTED string shows what the user is shown. Both are asserted here, in that order, so a future
 * reader who deletes the formatted one still has a check that can fail.
 *
 * The euro sign is separated by U+00A0, not by an ordinary space, and the expectations spell the
 * escape out: a literal space there fails with a diff whose two sides are byte-identical on screen.
 *
 * Locale is passed explicitly rather than negotiated: there is no request in a unit test, so
 * `getLocale()` returns the base locale (English), and the sentence this pins is the French one the
 * defect was measured in.
 */
describe('applyKindSign', () => {
	it('signs an expense negative and an income positive, whatever the stored sign', () => {
		// The stored column carries a magnitude for every CSV-imported row and a signed value for
		// every manually-entered one. Both spellings of the same expense must come out identical.
		expect(applyKindSign(9000, 'expense')).toBe(-9000);
		expect(applyKindSign(-9000, 'expense')).toBe(-9000);
		expect(applyKindSign(250000, 'income')).toBe(250000);
		expect(applyKindSign(-250000, 'income')).toBe(250000);
	});

	it('returns POSITIVE zero for a zero-amount expense, not negative zero', () => {
		const signed = applyKindSign(0, 'expense');

		// Written with Object.is deliberately. `toBe` uses Object.is internally, so this really does
		// discriminate — but `expect(signed).toBe(0)` reads to a maintainer as an ordinary numeric
		// check, and `expect(signed === 0).toBe(true)` would NOT discriminate at all. Spelling it out
		// is what stops the assertion being "simplified" into one that cannot fail.
		expect(Object.is(signed, -0)).toBe(false);
		expect(Object.is(signed, 0)).toBe(true);
	});

	it('renders a zero-amount expense as « 0,00 € » and never « -0,00 € »', () => {
		// The user-visible half. `REGULARISATION NULLE` is a real row of the audit fixture: an expense
		// of 0 cents. Rendered from a negative zero it reads as a negative amount of nothing.
		expect(formatCents(applyKindSign(0, 'expense'), 'fr')).toBe('0,00\u00a0\u20ac');
		expect(formatCents(applyKindSign(0, 'income'), 'fr')).toBe('0,00\u00a0\u20ac');
	});

	it('leaves the non-zero rendering signed, so the zero branch is not over-applied', () => {
		// The appear-then-disappear half of the negative assertion above: a minus sign IS produced
		// here, so the previous test's absence is an absence of something that can be present.
		expect(formatCents(applyKindSign(1600, 'expense'), 'fr')).toBe('-16,00\u00a0\u20ac');
		expect(formatCents(applyKindSign(1600, 'income'), 'fr')).toBe('16,00\u00a0\u20ac');
	});
});
