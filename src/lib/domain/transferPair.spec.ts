import { describe, it, expect } from 'vitest';
import { pairRefusal, proposeTransferPairs, type PairLeg } from './transferPair';

// #1189. `kind` is resolved by the caller through `resolveTransactionType`, never from the sign:
// an imported expense is stored as a positive magnitude.
function leg(id: string, over: Partial<PairLeg> = {}): PairLeg {
	return {
		id,
		accountId: 'checking',
		date: '2026-03-10',
		amountCents: 50000,
		kind: 'expense',
		currency: 'EUR',
		exponent: 2,
		transferPairId: null,
		splitCount: 0,
		...over
	};
}

describe('pairRefusal', () => {
	const out = leg('out');
	const into = leg('in', { accountId: 'savings', kind: 'income' });

	it('accepts two legs of opposite direction and equal magnitude on two accounts', () => {
		expect(pairRefusal(out, into)).toBeNull();
	});

	it('accepts two imported legs both stored positive, because direction comes from kind', () => {
		expect(pairRefusal(out, { ...into, amountCents: 50000 })).toBeNull();
	});

	it('accepts a manual expense stored negative against an imported income stored positive', () => {
		expect(pairRefusal({ ...out, amountCents: -50000 }, into)).toBeNull();
	});

	it('refuses two legs on the same account', () => {
		expect(pairRefusal(out, { ...into, accountId: 'checking' })).toBe('same-account');
	});

	it('refuses two legs of the same direction', () => {
		expect(pairRefusal(out, { ...into, kind: 'expense' })).toBe('same-direction');
	});

	it('refuses a magnitude one cent apart', () => {
		expect(pairRefusal(out, { ...into, amountCents: 50001 })).toBe('unequal-amount');
	});

	it('refuses two currencies even at an equal integer', () => {
		expect(pairRefusal(out, { ...into, currency: 'USD' })).toBe('different-currency');
	});

	it('refuses two exponents even at an equal integer', () => {
		expect(pairRefusal(out, { ...into, exponent: 0 })).toBe('different-currency');
	});

	it('refuses a leg already paired', () => {
		expect(pairRefusal(out, { ...into, transferPairId: 'other' })).toBe('already-paired');
	});

	it('refuses a split leg', () => {
		expect(pairRefusal({ ...out, splitCount: 2 }, into)).toBe('split');
	});

	it('refuses two zero amounts, which resolve to opposite directions by type alone', () => {
		expect(pairRefusal({ ...out, amountCents: 0 }, { ...into, amountCents: 0 })).toBe(
			'zero-amount'
		);
	});

	it('refuses a leg paired with itself', () => {
		expect(pairRefusal(out, out)).toBe('same-transaction');
	});
});

describe('proposeTransferPairs', () => {
	it('proposes the only candidate within the window, and counts the rest as none', () => {
		const result = proposeTransferPairs(
			[
				leg('out'),
				leg('in', { accountId: 'savings', kind: 'income', date: '2026-03-12' }),
				leg('lonely', { amountCents: 1234 })
			],
			3
		);
		expect(result).toEqual({ proposed: [['in', 'out']], ambiguous: [], none: ['lonely'] });
	});

	it('proposes on the boundary day and not one day past it', () => {
		const at = proposeTransferPairs(
			[leg('out'), leg('in', { accountId: 'savings', kind: 'income', date: '2026-03-13' })],
			3
		);
		expect(at.proposed).toEqual([['in', 'out']]);
		const past = proposeTransferPairs(
			[leg('out'), leg('in', { accountId: 'savings', kind: 'income', date: '2026-03-14' })],
			3
		);
		expect(past).toEqual({ proposed: [], ambiguous: [], none: ['in', 'out'] });
	});

	it('counts a window across a month end in days, not in calendar fields', () => {
		const result = proposeTransferPairs(
			[
				leg('out', { date: '2026-02-27' }),
				leg('in', { accountId: 'savings', kind: 'income', date: '2026-03-02' })
			],
			3
		);
		expect(result.proposed).toEqual([['in', 'out']]);
	});

	it('proposes nobody when one leg has two candidates, and marks all three ambiguous', () => {
		const result = proposeTransferPairs(
			[
				leg('out'),
				leg('in-a', { accountId: 'savings', kind: 'income' }),
				leg('in-b', { accountId: 'livret', kind: 'income' })
			],
			3
		);
		expect(result).toEqual({ proposed: [], ambiguous: ['in-a', 'in-b', 'out'], none: [] });
	});

	it('proposes two imported legs both stored positive', () => {
		const result = proposeTransferPairs(
			[leg('out', { amountCents: 50000 }), leg('in', { accountId: 'savings', kind: 'income' })],
			3
		);
		expect(result.proposed).toEqual([['in', 'out']]);
	});

	it('leaves out legs that are already paired or split, as candidates and as entries', () => {
		const result = proposeTransferPairs(
			[
				leg('out'),
				leg('in', { accountId: 'savings', kind: 'income' }),
				leg('paired', { accountId: 'livret', kind: 'income', transferPairId: 'x' }),
				leg('split', { accountId: 'livret', kind: 'income', splitCount: 2 })
			],
			3
		);
		expect(result).toEqual({ proposed: [['in', 'out']], ambiguous: [], none: [] });
	});

	it('returns the same answer whatever order the legs arrive in', () => {
		const legs = [
			leg('out'),
			leg('in', { accountId: 'savings', kind: 'income', date: '2026-03-11' }),
			leg('out-2', { amountCents: 700, date: '2026-03-20' }),
			leg('in-2', { accountId: 'savings', kind: 'income', amountCents: 700, date: '2026-03-21' })
		];
		expect(proposeTransferPairs([...legs].reverse(), 3)).toEqual(proposeTransferPairs(legs, 3));
	});
});
