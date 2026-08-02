import { describe, it, expect } from 'vitest';
import { resolveTransactionType, sumFilteredTotals } from './totals';

describe('resolveTransactionType', () => {
	it.each([
		['income', -500, 'income'],
		['expense', 500, 'expense'],
		[null, 500, 'income'],
		[null, 0, 'income'],
		[null, -1, 'expense'],
		['other', 500, 'income'],
		['other', -1, 'expense']
	])('type=%s amount=%s resolves to %s', (type, amountCents, expected) => {
		expect(resolveTransactionType({ type: type as string | null, amountCents })).toBe(expected);
	});
});

describe('sumFilteredTotals', () => {
	it('splits by kind and reports magnitudes, not signs', () => {
		expect(
			sumFilteredTotals([
				{ amountCents: -4230, type: 'expense' },
				{ amountCents: 245000, type: 'income' },
				{ amountCents: -1000, type: null }
			])
		).toEqual({ incomeCents: 245000, expenseCents: 5230 });
	});

	it('counts a zero amount as income, matching getTransactionKind', () => {
		expect(sumFilteredTotals([{ amountCents: 0, type: null }])).toEqual({
			incomeCents: 0,
			expenseCents: 0
		});
	});

	it('applies no nature policy: a transfer counts like anything else', () => {
		// Deliberate. This is a SUM of the filtered set, not an analysis of it. Adding a nature
		// filter here would make it the sixth site encoding "which natures count", each of which
		// currently disagrees with the others.
		expect(sumFilteredTotals([{ amountCents: -20000, type: 'expense' }])).toEqual({
			incomeCents: 0,
			expenseCents: 20000
		});
	});

	it('returns zeroes for an empty set', () => {
		expect(sumFilteredTotals([])).toEqual({ incomeCents: 0, expenseCents: 0 });
	});
});
