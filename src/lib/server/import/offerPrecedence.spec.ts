import { describe, expect, it } from 'vitest';
import { resolveZeroTransactionOffer } from './offerPrecedence';

/**
 * THE ONE ORDER, tested as a table over every pair the two doors can actually produce together,
 * per the rule this file's own docstring states: split > header > multiAccount > accountColumn >
 * dateOrder > generic. Written as a table rather than one test per rung for the reason
 * `dateOrderDecision.spec.ts` gives for its own table: the thing that can go wrong here is not one
 * rung computing the wrong verdict, it is a PAIR nobody thought about.
 */

const SPLIT = { code: 'amount-split-across-columns', columns: '« Debit » et « Credit »' } as const;
const HEADER = { code: 'header-not-recognized', profile: 'CSV' } as const;
const MULTI_ACCOUNT = { code: 'multi-account-file', column: 3 } as const;
const ACCOUNT_COLUMN = {
	code: 'ambiguous-account-column',
	column: 3,
	sample: '10000001'
} as const;
const DATE_ORDER = { code: 'ambiguous-date-order', column: 0, sample: '06/01/2026' } as const;

describe('resolveZeroTransactionOffer', () => {
	it('answers generic when the door computed nothing at all', () => {
		expect(resolveZeroTransactionOffer({})).toStrictEqual({ rung: 'generic' });
	});

	it('answers each rung alone, on the door that computes only that one', () => {
		expect(resolveZeroTransactionOffer({ split: SPLIT })).toStrictEqual({
			rung: 'split',
			fact: SPLIT
		});
		expect(resolveZeroTransactionOffer({ header: HEADER })).toStrictEqual({
			rung: 'header',
			fact: HEADER
		});
		expect(resolveZeroTransactionOffer({ multiAccount: MULTI_ACCOUNT })).toStrictEqual({
			rung: 'multiAccount',
			fact: MULTI_ACCOUNT
		});
		expect(resolveZeroTransactionOffer({ accountColumn: ACCOUNT_COLUMN })).toStrictEqual({
			rung: 'accountColumn',
			fact: ACCOUNT_COLUMN
		});
		expect(resolveZeroTransactionOffer({ dateOrder: DATE_ORDER })).toStrictEqual({
			rung: 'dateOrder',
			fact: DATE_ORDER
		});
	});

	// THE PAIR THE PLAN NAMES: a file that is both multi-account and date-ambiguous. Measured
	// already at the door in `multiAccountRefusal.spec.ts`'s "order against #433" cases; this
	// asserts the SAME order at the one place both doors now read it from.
	it('answers multiAccount over dateOrder, whichever order the door computed them in', () => {
		expect(
			resolveZeroTransactionOffer({ multiAccount: MULTI_ACCOUNT, dateOrder: DATE_ORDER })
		).toStrictEqual({ rung: 'multiAccount', fact: MULTI_ACCOUNT });
		expect(
			resolveZeroTransactionOffer({ dateOrder: DATE_ORDER, multiAccount: MULTI_ACCOUNT })
		).toStrictEqual({ rung: 'multiAccount', fact: MULTI_ACCOUNT });
	});

	it('answers accountColumn over dateOrder', () => {
		expect(
			resolveZeroTransactionOffer({ accountColumn: ACCOUNT_COLUMN, dateOrder: DATE_ORDER })
		).toStrictEqual({ rung: 'accountColumn', fact: ACCOUNT_COLUMN });
	});

	it('answers multiAccount over accountColumn, which the door itself cannot produce together but the order still covers', () => {
		expect(
			resolveZeroTransactionOffer({ multiAccount: MULTI_ACCOUNT, accountColumn: ACCOUNT_COLUMN })
		).toStrictEqual({ rung: 'multiAccount', fact: MULTI_ACCOUNT });
	});

	it('answers split over every other rung at once', () => {
		expect(
			resolveZeroTransactionOffer({
				split: SPLIT,
				header: HEADER,
				multiAccount: MULTI_ACCOUNT,
				accountColumn: ACCOUNT_COLUMN,
				dateOrder: DATE_ORDER
			})
		).toStrictEqual({ rung: 'split', fact: SPLIT });
	});

	it('answers header over multiAccount, accountColumn and dateOrder', () => {
		expect(
			resolveZeroTransactionOffer({
				header: HEADER,
				multiAccount: MULTI_ACCOUNT,
				accountColumn: ACCOUNT_COLUMN,
				dateOrder: DATE_ORDER
			})
		).toStrictEqual({ rung: 'header', fact: HEADER });
	});
});
