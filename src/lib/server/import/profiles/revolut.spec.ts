import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from '../csv';
import { REAL_HEADERS } from './realHeaders.fixture';

/**
 * The English Revolut export, which imported NOTHING before this profile learned its column
 * spellings: it failed `matchesRevolutHeader`, fell through to `generic`, and was refused with
 * nine `Colonne non autorisée` lines.
 *
 * The header is only half of it. An English file writes `COMPLETED` in the State column, so a
 * header fix alone would have left every row refused as `état Revolut non terminé`. The two
 * halves fail independently, so they are asserted independently.
 *
 * The fixture is the REAL ten column header, taken from the same source as the acceptance
 * fixture rather than composed here, because a synthetic header proves the parser accepts what
 * this file imagines Revolut writes.
 */

const EN_HEADER = REAL_HEADERS.find(([name]) => name === 'Revolut EN')![1];
const EN_ROW = REAL_HEADERS.find(([name]) => name === 'Revolut EN')![2];

const FR_HEADER =
	'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde';
const FR_ROW =
	'CARD_PAYMENT,Current,2026-08-01 10:00:00,2026-08-01 10:00:00,Tesco,-12.30,0.00,EUR,TERMINÉ,500.00';

describe('the Revolut profile and its English export', () => {
	it('detects the English header as Revolut rather than falling through to generic', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(`${EN_HEADER}\n${EN_ROW}\n`);

		// The profile label is the half a transaction count cannot show: a file that imported
		// through `generic` would also produce one transaction, and would be the wrong parse.
		expect(result.summary.profile).toBe('revolut');
		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
	});

	it('reads an English row through the canonical fields, so the values land in the right places', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(`${EN_HEADER}\n${EN_ROW}\n`);
		const transaction = result.transactions[0];

		// Every one of these comes from a DIFFERENT English column, so a normaliser that mapped
		// one spelling and dropped the rest cannot satisfy all four.
		//
		// Note the convention, which is this profile's own and not `generic`'s: the amount is
		// stored ABSOLUTE with the direction in `metadata.type`, so asserting a negative here
		// would be asserting the wrong contract rather than catching a defect.
		expect(transaction.date).toBe('2026-08-01'); // Completed Date
		expect(transaction.label).toBe('Tesco'); // Description
		expect(transaction.amountCents).toBe(1230); // Amount, absolute
		expect(transaction.metadata?.type).toBe('expense'); // Amount, its sign
	});

	it('still reads a French export identically, which is what makes this a widening', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(`${FR_HEADER}\n${FR_ROW}\n`);

		expect(result.summary.profile).toBe('revolut');
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].amountCents).toBe(1230);
	});

	it('accepts the ten columns in any order, since nothing downstream reads by position', () => {
		expect.assertions(2);

		// The same ten English names, reversed. Revolut has changed its export across regions
		// and over time, and a matcher keyed on order is what would break next.
		const reversed = EN_HEADER.split(',').reverse().join(',');
		const reversedRow = EN_ROW.split(',').reverse().join(',');

		const result = parseCsvTransactions(`${reversed}\n${reversedRow}\n`);

		expect(result.summary.profile).toBe('revolut');
		expect(result.transactions).toHaveLength(1);
	});

	it('refuses a row whose state is neither TERMINE nor COMPLETED, naming the reason', () => {
		expect.assertions(3);

		const pending = EN_ROW.replace('COMPLETED', 'PENDING');
		const result = parseCsvTransactions(`${EN_HEADER}\n${pending}\n`);

		// The allow list is two values, not a pattern: widening it must not have turned the
		// State column into something that accepts anything.
		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'state-not-completed',
			state: 'PENDING'
		});
	});

	it('STILL refuses a non EUR row, which this PR does not change and a GB user will meet', () => {
		expect.assertions(3);

		const gbp = EN_ROW.replace(',EUR,', ',GBP,');
		const result = parseCsvTransactions(`${EN_HEADER}\n${gbp}\n`);

		// Recorded rather than left as a surprise. A GB or IE Revolut user gets past the header
		// and the state after this change and is then refused row by row on the currency. That
		// is a product decision about a EUR only application, to be taken on its own, and this
		// test exists so the chantier's end is not read as "Revolut works now".
		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'unsupported-currency',
			currency: 'GBP'
		});
	});

	it('refuses a header carrying a duplicate column, which the set based match must not hide', () => {
		expect.assertions(2);

		// Ten cells, but nine distinct names. A set based matcher that only checked "every name
		// is known" would accept this; the size check is what refuses it.
		const duplicated = EN_HEADER.split(',');
		duplicated[9] = duplicated[8];
		const result = parseCsvTransactions(`${duplicated.join(',')}\n${EN_ROW}\n`);

		expect(result.summary.profile).not.toBe('revolut');
		expect(result.transactions).toStrictEqual([]);
	});
});
