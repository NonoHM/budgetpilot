/**
 * #485: a file spanning more than one account used to import entirely into ONE account, silently.
 * `findDiscriminantColumn` already detected it (`multiAccountFile` on the summary) but gated
 * nothing — the notice rendered AFTER the rows were already written. This file is the door's
 * side of the fix: `csv.ts` refuses or asks BEFORE any row is written, following the same
 * proven/exhibited split `discriminant.ts` computes as its `kind` (contradictory vs ambiguous).
 *
 * MEASURED on `main` before this fix, the fixture this repo's own plan carried: 8 rows, a true
 * split of 5 rows into one account and 3 into another, imported as 8/8 into one account holding
 * the sum of both. This file does not reproduce that exact fixture (AGENTS.md forbids publishing
 * anything derived from a real statement's shape); the two-row IBAN and digit-run fixtures below
 * exercise the same defect through the synthetic accounts this repo already uses in
 * `discriminant.spec.ts` and `sourceSignature.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import type { CsvRefusal } from './refusals';
import { REAL_HEADERS } from './profiles/realHeaders.fixture';
import { parseRows } from './utils/csv';

const HEADER = 'date,label,amount,compte';

/** Two verified IBANs (mod-97), same pair `discriminant.spec.ts` uses. `kind: 'contradictory'`: PROVEN. */
const PROVEN_TWO_ACCOUNTS =
	`${HEADER}\n` +
	'2026-06-01,Salaire,2500.50,FR7630001007941234567890185\n' +
	'2026-06-02,Courses,-42.10,FR3730001007949876543210192';

/** Two bare digit runs that vary: `kind: 'ambiguous'`. EXHIBITED, never proven. */
const AMBIGUOUS_TWO_VALUES =
	`${HEADER}\n` + '2026-06-01,Salaire,2500.50,12349032\n' + '2026-06-02,Courses,-42.10,12340185';

/** The same shape, one account: the control every assertion below is read against. */
const SINGLE_ACCOUNT =
	`${HEADER}\n` +
	'2026-06-01,Salaire,2500.50,FR7630001007941234567890185\n' +
	'2026-06-02,Courses,-42.10,FR7630001007941234567890185';

/** A column that varies and LOOKS like it might matter, but never qualifies the grammar at all:
 *  a reference under eight digits, mixing letters in. Neither refuses nor asks. */
const LOOKS_LIKE_BUT_ISNT =
	`${HEADER}\n` + '2026-06-01,Salaire,2500.50,REF01\n' + '2026-06-02,Courses,-42.10,REF02';

describe('a proven multi-account file (kind: contradictory)', () => {
	it('refuses outright, before any row is written', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(PROVEN_TWO_ACCOUNTS);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0]).toEqual({
			scope: { kind: 'file' },
			fact: { code: 'multi-account-file', column: 3 }
		} satisfies CsvRefusal);
	});

	// The plate-7 promotion: once a bare digit run is CONFIRMED to name accounts, it is refused
	// exactly like the proven case, never split.
	it('refuses the same way once an ambiguous column is confirmed to name accounts', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(AMBIGUOUS_TWO_VALUES, {
			accountColumnAnswer: 'is-account'
		});

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]?.fact).toEqual({ code: 'multi-account-file', column: 3 });
	});
});

describe('an unproven multi-account column (kind: ambiguous)', () => {
	it('asks instead of refusing, and instead of guessing, when nothing has answered yet', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(AMBIGUOUS_TWO_VALUES);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]?.fact).toEqual({
			code: 'ambiguous-account-column',
			column: 3,
			sample: '12349032'
		});
	});

	it('imports normally once the column is confirmed to name something else', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(AMBIGUOUS_TWO_VALUES, {
			accountColumnAnswer: 'not-account'
		});

		expect(result.invalidRows).toHaveLength(0);
		expect(result.transactions).toHaveLength(2);
	});
});

describe('the direction this fix is not moving in', () => {
	it('leaves a single-account file untouched', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(SINGLE_ACCOUNT);

		expect(result.invalidRows).toHaveLength(0);
		expect(result.transactions).toHaveLength(2);
	});

	it('does not refuse or ask about a column that merely varies without qualifying the grammar', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(LOOKS_LIKE_BUT_ISNT);

		expect(result.invalidRows).toHaveLength(0);
		expect(result.transactions).toHaveLength(2);
	});
});

describe('order against the other auto-path question, #433s ambiguous-date-order', () => {
	// Both ambiguities in one file: the date column is ambiguous by construction (day and month
	// both <= 12) AND the account column is proven multi-account. MEASURED rather than assumed:
	// the proven case is at least as severe as a structural refusal (it cannot be resolved by
	// answering the date question), so it is checked FIRST and wins.
	const PROVEN_AND_AMBIGUOUS_DATE =
		`${HEADER}\n` +
		'01/06/2026,Salaire,2500.50,FR7630001007941234567890185\n' +
		'02/06/2026,Courses,-42.10,FR3730001007949876543210192';

	it('refuses the proven multi-account file even when its date column is also ambiguous', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(PROVEN_AND_AMBIGUOUS_DATE);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]?.fact.code).toBe('multi-account-file');
	});

	// The unproven (ask) case, same compound file shape. MEASURED, same reasoning as above: the
	// account question is checked first, so it is what the user sees FIRST.
	const AMBIGUOUS_ACCOUNT_AND_DATE =
		`${HEADER}\n` + '01/06/2026,Salaire,2500.50,12349032\n' + '02/06/2026,Courses,-42.10,12340185';

	it('asks about the account column first, ahead of the still-unresolved date question', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(AMBIGUOUS_ACCOUNT_AND_DATE);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]?.fact.code).toBe('ambiguous-account-column');
	});

	// The cost this ordering pays, named rather than left to be found: once the account question
	// is answered, THIS SAME PARSE still has to face the date question it has not asked yet. A
	// file carrying both ambiguities costs its user two sequential questions rather than one.
	it('still asks the date question afterward, on the same parse, once the account answer clears', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(AMBIGUOUS_ACCOUNT_AND_DATE, {
			accountColumnAnswer: 'not-account'
		});

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]?.fact.code).toBe('ambiguous-date-order');
	});
});

/**
 * #702 at the parse door. N26's recorded header (`realHeaders.fixture.ts`) carries `Partner Iban`,
 * the OTHER party's IBAN. A statement of transfers to two different people fills it with two
 * verified IBANs, which is exactly the shape `PROVEN_TWO_ACCOUNTS` refuses, so before #702 an
 * ordinary single-account N26 statement was refused as a multi-account export. Header and row are
 * the recorded ones; only the Partner Iban cell is replaced, with the pair `PROVEN_TWO_ACCOUNTS`
 * carries.
 */
describe('a counterparty account column at the parse door (#702)', () => {
	const [, n26Header, n26Row] = REAL_HEADERS.find(([name]) => name === 'N26')!;
	const partner = parseRows(n26Header)[0].cells.indexOf('Partner Iban');

	function n26(partnerIbans: string[]): string {
		const recorded = parseRows(n26Row)[0].cells;
		const lines = partnerIbans.map((iban) =>
			recorded.map((cell, index) => `"${index === partner ? iban : cell}"`).join(',')
		);
		return [n26Header, ...lines].join('\n');
	}

	// SEPARATES: « a varying counterparty column is not evidence against a single account » FROM
	// « an N26 statement of transfers to two people is refused as a proven multi-account file ».
	it('imports a statement whose rows pay two different counterparties', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			n26(['FR7630001007941234567890185', 'FR3730001007949876543210192'])
		);

		expect(partner).toBe(3);
		expect(result.invalidRows).toHaveLength(0);
		expect(result.transactions).toHaveLength(2);
	});
});
