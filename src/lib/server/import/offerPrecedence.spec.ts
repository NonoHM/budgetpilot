import { describe, expect, it } from 'vitest';
import {
	OFFER_RUNGS,
	resolveImportOffer,
	type ImportOffer,
	type ImportOffers,
	type OfferRung
} from './offerPrecedence';
import type { AccountOffer } from './accountOffer';

/**
 * THE ONE ORDER, tested as a table over every pair of rungs, per the rule this file's own docstring
 * states. Written as a table rather than one test per rung for the reason `dateOrderDecision.spec.ts`
 * gives for its own table: the thing that can go wrong here is not one rung computing the wrong
 * verdict, it is a PAIR nobody thought about.
 *
 * ## The rungs come from the module, the order comes from this file
 *
 * `OFFER_RUNGS` is the module's own registry, and `EXPECTED_ORDER` below must name exactly its
 * members, so a rung added to the module without a place in this table fails here rather than
 * being silently unranked. The ORDER is written out by hand on purpose: deriving the expected
 * winner of a pair from `OFFER_RUNGS` itself would make the test and the thing under test share a
 * source, and swapping two rungs in the module would then stay green.
 */
const EXPECTED_ORDER = [
	'split',
	'header',
	'multiAccount',
	'accountColumn',
	'generic',
	'account',
	'currency',
	'dateOrder'
] as const satisfies readonly OfferRung[];

const SPLIT = { code: 'amount-split-across-columns', columns: '« Debit » et « Credit »' } as const;
const HEADER = { code: 'header-not-recognized', profile: 'CSV' } as const;
const MULTI_ACCOUNT = { code: 'multi-account-file', column: 3 } as const;
const ACCOUNT_COLUMN = {
	code: 'ambiguous-account-column',
	column: 3,
	sample: '10000001'
} as const;
const DATE_ORDER = { code: 'ambiguous-date-order', column: 0, sample: '06/01/2026' } as const;
const CURRENCY = {
	code: 'declared-currency-mismatch',
	declared: 'EUR',
	destination: 'USD'
} as const;
const ACCOUNT_OFFER: AccountOffer = {
	options: [
		{ id: 'account-courant', name: 'Compte courant', discriminant: null, transactionCount: 0 },
		{ id: 'account-livret', name: 'Livret', discriminant: null, transactionCount: 0 }
	],
	resolution: { rank: 3, kind: 'orphan' },
	memory: null,
	prefillName: 'CSV'
};

/**
 * One door state per rung, in which that rung and no other is pending, with the offer it must
 * produce. `Record<OfferRung, ...>` is the compile-time half of the enumeration: a rung added to
 * the union without a fixture here does not typecheck.
 *
 * `produced` is what the parse would report in that state. The structural refusals and the
 * account-column question only arise on a parse that produced nothing; the account question arises
 * on a parse that produced rows, and the date question on one refused for its dates alone.
 */
const PENDING: Record<OfferRung, { offers: ImportOffers; offer: ImportOffer }> = {
	split: { offers: { produced: false, split: SPLIT }, offer: { rung: 'split', fact: SPLIT } },
	header: { offers: { produced: false, header: HEADER }, offer: { rung: 'header', fact: HEADER } },
	multiAccount: {
		offers: { produced: false, multiAccount: MULTI_ACCOUNT },
		offer: { rung: 'multiAccount', fact: MULTI_ACCOUNT }
	},
	accountColumn: {
		offers: { produced: false, accountColumn: { state: 'open', fact: ACCOUNT_COLUMN } },
		offer: { rung: 'accountColumn', fact: ACCOUNT_COLUMN }
	},
	generic: { offers: { produced: false }, offer: { rung: 'generic' } },
	account: {
		offers: { produced: true, account: { state: 'open', fact: ACCOUNT_OFFER } },
		offer: { rung: 'account', question: { state: 'open', fact: ACCOUNT_OFFER } }
	},
	// #600's refusal: the file declares a currency the destination cannot hold. Computed only once
	// the destination is known, so it arises on a parse that produced rows, and on one whose date
	// question is still open (`csv.ts` carries the declaration out of that empty parse).
	currency: {
		offers: { produced: true, currency: CURRENCY },
		offer: { rung: 'currency', fact: CURRENCY }
	},
	dateOrder: {
		offers: { produced: false, dateOrder: { state: 'open', fact: DATE_ORDER } },
		offer: { rung: 'dateOrder', fact: DATE_ORDER }
	}
};

/** Two door states at once. A parse produced rows only if both states say it did. */
function both(a: ImportOffers, b: ImportOffers): ImportOffers {
	return { ...a, ...b, produced: a.produced && b.produced };
}

/**
 * The one pair that cannot be ranked by position, because one member is DEFINED by the absence of
 * the other: `generic` means « nothing was produced and no question below explains why », and an
 * open date question is exactly such an explanation (`csv.ts` refuses an ambiguous column only on a
 * file that would otherwise have imported). Asserted on its own below rather than skipped.
 */
function isDefinitionalPair(a: OfferRung, b: OfferRung) {
	return (a === 'generic' && b === 'dateOrder') || (a === 'dateOrder' && b === 'generic');
}

describe('resolveImportOffer', () => {
	it('ranks exactly the rungs the module declares, no more and no fewer', () => {
		// SEPARATES: « every rung the module can return has a place in this table » FROM « a rung
		// was added to `OFFER_RUNGS` and nothing here ranks it ».
		expect([...EXPECTED_ORDER].sort()).toStrictEqual([...OFFER_RUNGS].sort());
	});

	it('answers none when nothing is pending on a parse that produced rows', () => {
		expect(resolveImportOffer({ produced: true })).toStrictEqual({ rung: 'none' });
	});

	it.each(EXPECTED_ORDER)('answers %s alone, when it is the only thing pending', (rung) => {
		expect(resolveImportOffer(PENDING[rung].offers)).toStrictEqual(PENDING[rung].offer);
	});

	// EVERY PAIR, in both orders of the spread, so « the rung computed later wins » cannot pass.
	// SEPARATES: « the module ranks rung A above rung B » FROM any swap of the two in `OFFER_RUNGS`.
	const pairs = EXPECTED_ORDER.flatMap((higher, index) =>
		EXPECTED_ORDER.slice(index + 1)
			.filter((lower) => !isDefinitionalPair(higher, lower))
			.map((lower) => [higher, lower] as const)
	);
	it.each(pairs)('answers %s over %s', (higher, lower) => {
		expect(resolveImportOffer(both(PENDING[higher].offers, PENDING[lower].offers))).toStrictEqual(
			PENDING[higher].offer
		);
		expect(resolveImportOffer(both(PENDING[lower].offers, PENDING[higher].offers))).toStrictEqual(
			PENDING[higher].offer
		);
	});

	it('asks the date reading, not generic, when an open date question is why nothing was produced', () => {
		expect(
			resolveImportOffer({ produced: false, dateOrder: { state: 'open', fact: DATE_ORDER } })
		).toStrictEqual({ rung: 'dateOrder', fact: DATE_ORDER });
	});

	it('answers generic rather than asking the account for a file that produced nothing unexplained', () => {
		// SEPARATES: « a file that cannot import is refused before anyone is asked about it » FROM
		// « the account question is asked first, answered, and the file is refused anyway », which
		// spends the user's answer on a file no answer can rescue.
		expect(
			resolveImportOffer({ produced: false, account: { state: 'open', fact: ACCOUNT_OFFER } })
		).toStrictEqual({ rung: 'generic' });
	});

	/**
	 * THE LOOP, as the ordering sees it. On `main` since 1.1.1 the account question lived in the
	 * route's control flow and the date question in this function, so neither knew the other was
	 * answered. These are the pairs the owner named.
	 */
	describe('an answered question is never asked again', () => {
		it('date answered, account not: asks the account', () => {
			// SEPARATES: « the answered date question is skipped » FROM « a question in the table
			// is asked whatever its state », which re-asks the date reading after it was answered.
			expect(
				resolveImportOffer({
					produced: true,
					dateOrder: { state: 'answered' },
					account: { state: 'open', fact: ACCOUNT_OFFER }
				})
			).toStrictEqual({ rung: 'account', question: { state: 'open', fact: ACCOUNT_OFFER } });
		});

		it('account answered, date not: asks the date reading', () => {
			// SEPARATES: « the answered account question is skipped » FROM « it is asked again »,
			// the other half of the alternation.
			expect(
				resolveImportOffer({
					produced: false,
					account: { state: 'answered' },
					dateOrder: { state: 'open', fact: DATE_ORDER }
				})
			).toStrictEqual({ rung: 'dateOrder', fact: DATE_ORDER });
		});

		it('both answered: asks nothing and the import proceeds', () => {
			expect(
				resolveImportOffer({
					produced: true,
					account: { state: 'answered' },
					dateOrder: { state: 'answered' },
					accountColumn: { state: 'answered' }
				})
			).toStrictEqual({ rung: 'none' });
		});

		it('account-column answered: asks the account next rather than the column again', () => {
			expect(
				resolveImportOffer({
					produced: true,
					accountColumn: { state: 'answered' },
					account: { state: 'open', fact: ACCOUNT_OFFER }
				})
			).toStrictEqual({ rung: 'account', question: { state: 'open', fact: ACCOUNT_OFFER } });
		});
	});

	/**
	 * THE OWNER'S RULE, as the ladder sees it: a refusal the file proves comes before any question.
	 * These are the two states a real `/import` reaches (the table above covers every pair; this
	 * names the one the rule is about).
	 */
	describe('a declared currency the destination contradicts is refused before the date question', () => {
		it('account answered, date open, currency contradicted: refuses, and asks nothing', () => {
			// SEPARATES: « refused before the reading is asked » FROM « the reading is asked, answered,
			// and the file is refused afterwards », which spends the user's answer on a refused file.
			expect(
				resolveImportOffer({
					produced: false,
					account: { state: 'answered' },
					currency: CURRENCY,
					dateOrder: { state: 'open', fact: DATE_ORDER }
				})
			).toStrictEqual({ rung: 'currency', fact: CURRENCY });
		});

		it('account still open: asks the account first, since the refusal needs it', () => {
			// No currency fact can exist yet (the destination is the open question), so this is the
			// ordering the rule reaches through: the account, then the refusal, then the reading.
			expect(
				resolveImportOffer({
					produced: false,
					account: { state: 'open', fact: ACCOUNT_OFFER },
					dateOrder: { state: 'open', fact: DATE_ORDER }
				})
			).toStrictEqual({ rung: 'account', question: { state: 'open', fact: ACCOUNT_OFFER } });
		});
	});

	it('refuses at the account rung when the posted account does not resolve', () => {
		// A posted answer that names no account of this user's is not an answer. It holds the
		// account rung's place, so a date question below it is not asked on the strength of it.
		expect(
			resolveImportOffer({
				produced: false,
				account: { state: 'refused', reason: 'archived' },
				dateOrder: { state: 'open', fact: DATE_ORDER }
			})
		).toStrictEqual({ rung: 'account', question: { state: 'refused', reason: 'archived' } });
	});
});
