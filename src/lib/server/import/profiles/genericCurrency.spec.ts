import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from '../csv';
import { MAISON_V2_HEADER } from './maison-v2';

/**
 * A file that declares a currency other than the euro is refused, because this application has
 * nowhere honest to put it: an amount is stored as a bare `amountCents` and rendered with a euro
 * symbol at every one of `formatCents`'s call sites. Importing a pound as a euro writes the right
 * number under the wrong unit.
 *
 * **This file narrows, and that is the thing to test carefully.** A widening's tests assert more
 * is accepted, and the loss hides in what stopped being refused. A narrowing is the mirror: the
 * tests assert more is refused, and the loss hides in what stopped being ACCEPTED. So the three
 * "still imports" cases below are not padding, they are the half that can actually fail. Without
 * them, a parser that refused every file would satisfy the refusal tests perfectly.
 */

const GBP = 'date;label;amount;currency\n2026-08-01;Tesco;-12,30;GBP\n';

describe('a generic file that declares its currency', () => {
	it('refuses a non EUR row, naming the currency it found', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(GBP);

		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows).toHaveLength(1);
		// The CODE and the value, not merely that a refusal happened: the reason is the only part
		// of a refusal a user ever sees, and it is what tells them their bank is not in euros
		// rather than that their file is malformed.
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'unsupported-currency',
			currency: 'GBP'
		});
	});

	it('is the same refusal Revolut already gives, so the two paths say the same thing', () => {
		expect.assertions(2);

		const revolut = parseCsvTransactions(
			'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
				'CARD_PAYMENT,Current,2026-08-01 10:00:00,2026-08-01 10:00:00,Tesco,-12.30,0.00,GBP,COMPLETED,500.00\n'
		);
		const generic = parseCsvTransactions(GBP);

		expect(revolut.invalidRows[0].fact).toStrictEqual(generic.invalidRows[0].fact);
		// And the profiles really are different, so the equality above is not two runs of one
		// parser agreeing with itself.
		expect(revolut.summary.profile).not.toBe(generic.summary.profile);
	});

	it('accepts `devise` as the column name too', () => {
		expect.assertions(2);

		const result = parseCsvTransactions('date;label;amount;devise\n2026-08-01;Tesco;-12,30;USD\n');

		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'unsupported-currency',
			currency: 'USD'
		});
	});

	it('refuses only the offending rows, and imports the rest of the file', () => {
		expect.assertions(3);

		const mixed =
			'date;label;amount;currency\n' +
			'2026-08-01;Tesco;-12,30;GBP\n' +
			'2026-08-02;Monoprix;-8,40;EUR\n';
		const result = parseCsvTransactions(mixed);

		// Per row, like Revolut, because the column is per row. A file that is mostly euros does
		// not become unimportable because one row is not.
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].label).toBe('Monoprix');
		expect(result.invalidRows).toHaveLength(1);
	});
});

describe('what must STILL import, which is where a narrowing loses things', () => {
	it('a currency column that says EUR', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			'date;label;amount;currency\n2026-08-01;Monoprix;-8,40;EUR\n'
		);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
	});

	it('a currency column left EMPTY, which is not a declaration', () => {
		expect.assertions(2);

		const result = parseCsvTransactions('date;label;amount;currency\n2026-08-01;Monoprix;-8,40;\n');

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
	});

	it('a file with no currency column at all, which is the common case', () => {
		expect.assertions(2);

		const result = parseCsvTransactions('date;label;amount\n2026-08-01;Monoprix;-8,40\n');

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
	});

	it('lowercase and padded spellings of EUR, since a file is not required to shout', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			'date;label;amount;currency\n2026-08-01;Monoprix;-8,40; eur \n'
		);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
	});

	it("this application's own export, which carries no currency column", () => {
		expect.assertions(2);

		// The regression that would hurt most: refusing on the ABSENCE of a signal would make
		// BudgetPilot unable to re-import its own export, and `docs/getting-started.md` promises
		// that round trip.
		const result = parseCsvTransactions(
			`${MAISON_V2_HEADER}\n` +
				'2026-08-01;Monoprix;Alimentation;-8,40;expense;spending;CB;-8,40;1/1;Alimentation\n'
		);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
	});
});
