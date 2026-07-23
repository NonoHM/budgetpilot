import { describe, expect, it } from 'vitest';
import { parseAmountCents } from './money';

// Iso-behavior tests, written against the pre-consolidation implementation, to be kept
// green after the parser is migrated to the shared domain/money.ts core (see money
// parsers consolidation). Any divergence here is a stop signal, not something to "fix"
// by adjusting the test.
describe('parseAmountCents (import)', () => {
	it('parses a dot-decimal amount', () => {
		expect(parseAmountCents('42.90')).toBe(4_290);
	});

	it('parses a comma-decimal amount', () => {
		expect(parseAmountCents('42,90')).toBe(4_290);
	});

	it('parses a negative amount', () => {
		expect(parseAmountCents('-42.90')).toBe(-4_290);
	});

	it('accepts an explicit leading +', () => {
		expect(parseAmountCents('+42.90')).toBe(4_290);
	});

	it('accepts zero', () => {
		expect(parseAmountCents('0')).toBe(0);
	});

	it('accepts a huge amount — no upper bound', () => {
		expect(parseAmountCents('999999999999')).toBe(99_999_999_999_900);
	});

	it('rejects an empty value', () => {
		expect(parseAmountCents('')).toBeNull();
	});

	it('rejects a non-numeric value', () => {
		expect(parseAmountCents('abc')).toBeNull();
	});

	it('rejects 3 decimal digits', () => {
		expect(parseAmountCents('42.999')).toBeNull();
	});

	it('strips whitespace (thousands grouping in bank exports)', () => {
		expect(parseAmountCents('1 234.56')).toBe(123_456);
	});

	it('rejects whitespace-only input', () => {
		expect(parseAmountCents('   ')).toBeNull();
	});

	it('rejects comma-thousands/dot-decimal notation — the import parser has no thousands-separator support (unlike net worth)', () => {
		// "1,234.56" would mean 1234.56 under the thousands-separator convention, but the import
		// parser only ever replaces a single comma with a dot (allowThousandsSeparator: false),
		// so this must be rejected rather than silently misparsed into a wrong amount.
		expect(parseAmountCents('1,234.56')).toBeNull();
	});

	it('preserves the pre-existing negative-zero quirk on "-0" (matches the old formula bit-for-bit, not a consolidation regression)', () => {
		expect(Object.is(parseAmountCents('-0'), -0)).toBe(true);
	});
});
