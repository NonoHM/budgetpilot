import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from '../csv';
import { CHASE, CREDIT_AGRICOLE, REAL_HEADERS } from './realHeaders.fixture';

/**
 * The acceptance for the widening, asserted PER FILE rather than as a count.
 *
 * A count is satisfied by three of any three, so it cannot tell "the aliases work" from "the
 * aliases work for the wrong banks". Per file, a break that unblocks nothing and a break that
 * unblocks the wrong one read differently.
 *
 * The two refused files are asserted with their REASON, not merely as refused, because the
 * whole point of the refusal contract is that two guards in sequence are indistinguishable
 * when the assertion only says a refusal happened.
 */

describe('real bank headers', () => {
	it.each(REAL_HEADERS)('imports something rather than nothing: %s', (_name, header, row) => {
		expect.assertions(3);

		const result = parseCsvTransactions(`${header}\n${row}\n`);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
		// The absolute figure beside the emptiness assertion: an empty invalidRows is also what
		// a parser that read nothing produces, and a transaction with no label would pass a
		// bare length check.
		expect(result.transactions[0].label.length).toBeGreaterThan(0);
	});

	it.each(REAL_HEADERS)('resolves a real date rather than a fallback: %s', (_name, header, row) => {
		expect.assertions(2);

		const result = parseCsvTransactions(`${header}\n${row}\n`);

		// 1 August 2026 is what all three fixture rows say, in three different notations. A
		// date column resolved to the wrong column, or not resolved at all, cannot land here.
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].date).toBe('2026-08-01');
	});

	it('refuses Credit Agricole, naming the amount column it has no single value for', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(`${CREDIT_AGRICOLE[0]}\n${CREDIT_AGRICOLE[1]}\n`);

		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows).toHaveLength(1);
		// It carries a Debit/Credit PAIR, not one signed amount. Collapsing that needs a stated
		// sign rule, deliberately deferred, so `amount` really is missing and saying so is true.
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'missing-required-column',
			role: 'amount'
		});
	});

	it('refuses Chase by ABSENCE of its date alias, not by the collision rule', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(`${CHASE[0]}\n${CHASE[1]}\n`);

		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'missing-required-column',
			role: 'date'
		});
		// The distinction this test exists for: Chase carries ONE date column, so it is not
		// ambiguous. It is refused because `posting date` is deliberately absent from the alias
		// table, since 08/01/2026 is 1 August at source and normalizeDate reads dd/mm. Adding
		// the alias would import it dated 8 January, which is worse than refusing.
		expect(result.invalidRows[0].fact.code).not.toBe('ambiguous-column-mapping');
	});
});
