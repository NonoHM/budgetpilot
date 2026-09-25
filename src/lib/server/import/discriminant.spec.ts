import { describe, expect, it } from 'vitest';
import type { ParsedCsvRow } from './types';
import {
	COUNTERPARTY_ACCOUNT_HEADERS,
	COUNTERPARTY_LAYOUTS,
	DISCRIMINANT_LENGTH,
	assertDiscriminantFree,
	findDiscriminantColumn
} from './discriminant';
import {
	N26_LEGACY_HEADERS,
	REAL_HEADERS,
	RECORDED_ACCOUNT_COLUMNS
} from './profiles/realHeaders.fixture';
import { parseRows } from './utils/csv';
import { foldComparableHeader } from './utils/encoding';

/**
 * `parseRows` returns the HEADER as `rows[0]`, so every fixture here is built the same way the
 * parser hands one over. A helper that took data rows alone would let a reader forget that, and
 * the off-by-one it produces (the header counted as a data row) is exactly the shape that makes a
 * constant column look like a varying one.
 */
function rowsOf(header: string[], dataRows: string[][]): ParsedCsvRow[] {
	return [header, ...dataRows].map((cells, index) => ({ cells, line: index + 1 }));
}

const HEADER = ['Date', 'Libelle', 'Montant', 'Numero de compte'];

/**
 * The IBANs below are the ISO 13616 worked example and a variant of it. Both carry a VERIFIED
 * mod-97 checksum, computed rather than typed: the multi-account fixture the plan carried
 * (`FR7630001007949876543210192`) reads as an IBAN and fails its checksum at 40, so it would have
 * been refused by the grammar and the test would have measured the checksum branch under the name
 * of the constancy branch.
 */
const ACCOUNT_A = 'FR7630001007941234567890185';
const ACCOUNT_B = 'FR3730001007949876543210192';

describe('findDiscriminantColumn', () => {
	it('finds a column whose every data row carries the same account identifier', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', ACCOUNT_A],
				['02/06/2026', 'B', '-2,00', ACCOUNT_A]
			])
		);
		expect(result).toStrictEqual({ kind: 'resolved', index: 3, fragment: '0185' });
	});

	// THE EVIDENCE IS THE CONSTANCY, NOT THE GRAMMAR. A column of well-formed IBANs that DIFFER is
	// not a discriminant, it is a multi-account export, and it is REFUSED with a sentence rather than
	// dropped into a silent rank 3.
	//
	// `contradictory` is what lets #485's fix REFUSE outright on this shape: a mod-97 checksum
	// collision across two genuinely different account numbers is not a realistic accident, so this
	// is proof rather than evidence. See #485 and the `ambiguous` case below, which is not.
	it('refuses a column carrying more than one account, rather than falling through', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', ACCOUNT_A],
				['02/06/2026', 'B', '-2,00', ACCOUNT_B]
			])
		);
		expect(result).toStrictEqual({ kind: 'contradictory', index: 3 });
	});

	// A bare digit run is exactly as consistent with a reference number, an invoice number or a
	// running balance as with a second account: the grammar match is real, but nothing here PROVES
	// the column names accounts. `ambiguous` is what lets #485's fix ASK instead of refuse.
	it('marks a varying bare-digit-run column as unproven rather than as proof of two accounts', () => {
		const result = findDiscriminantColumn(
			rowsOf(
				['Date', 'Libelle', 'Montant', 'Reference'],
				[
					['01/06/2026', 'A', '-1,00', '10000001'],
					['02/06/2026', 'B', '-2,00', '10000002']
				]
			)
		);
		expect(result).toStrictEqual({ kind: 'ambiguous', index: 3 });
	});

	// A column mixing a bare digit run on one row and a checksummed IBAN on another still varies,
	// and the mix is itself evidence the column is not uniformly a verified account identifier: ANY
	// row failing the IBAN check downgrades the whole column to unproven, never to proven-by-majority.
	it('downgrades a varying column to ambiguous when not every value verifies as an IBAN', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', ACCOUNT_A],
				['02/06/2026', 'B', '-2,00', '10000002']
			])
		);
		expect(result).toStrictEqual({ kind: 'ambiguous', index: 3 });
	});

	it('rejects an IBAN whose checksum does not verify', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', 'FR7630001007941234567890186'],
				['02/06/2026', 'B', '-2,00', 'FR7630001007941234567890186']
			])
		);
		expect(result).toStrictEqual({ kind: 'nothing-to-decide' });
	});

	it('finds nothing in a file that carries no identifier column', () => {
		const result = findDiscriminantColumn(
			rowsOf(
				['Date', 'Libelle', 'Montant'],
				[
					['01/06/2026', 'A', '-1,00'],
					['02/06/2026', 'B', '-2,00']
				]
			)
		);
		expect(result).toStrictEqual({ kind: 'nothing-to-decide' });
	});

	it('never returns more than four characters', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', ACCOUNT_A],
				['02/06/2026', 'B', '-2,00', ACCOUNT_A]
			])
		);
		expect(result.kind === 'resolved' && result.fragment.length).toBe(4);
		expect(DISCRIMINANT_LENGTH).toBe(4);
	});

	it('reads a bare account number of at least eight digits', () => {
		const result = findDiscriminantColumn(
			rowsOf(
				['Date', 'Libelle', 'Montant', 'Compte'],
				[
					['01/06/2026', 'A', '-1,00', '12345678901'],
					['02/06/2026', 'B', '-2,00', '12345678901']
				]
			)
		);
		expect(result).toStrictEqual({ kind: 'resolved', index: 3, fragment: '8901' });
	});

	// A date column is a run of digits broken by separators, and an amount column is a run of digits
	// broken by a comma. The grammar matches a WHOLE cell for that reason: matching a substring
	// would make every dated file carry an identifier column.
	it('does not read a date or an amount as an account number', () => {
		const result = findDiscriminantColumn(
			rowsOf(
				['Date', 'Montant'],
				[
					['01/06/2026', '-1234,56'],
					['01/06/2026', '-1234,56']
				]
			)
		);
		expect(result).toStrictEqual({ kind: 'nothing-to-decide' });
	});

	it('skips a column that is blank on any data row', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', ACCOUNT_A],
				['02/06/2026', 'B', '-2,00', '']
			])
		);
		expect(result).toStrictEqual({ kind: 'nothing-to-decide' });
	});

	it('finds nothing in a file that carries no data row at all', () => {
		expect(findDiscriminantColumn(rowsOf(HEADER, []))).toStrictEqual({
			kind: 'nothing-to-decide'
		});
		expect(findDiscriminantColumn([])).toStrictEqual({ kind: 'nothing-to-decide' });
	});
});

/**
 * #702. N26's export, recorded in `realHeaders.fixture.ts`, carries `Partner Iban`: the IBAN of
 * the OTHER party to each transfer. Header and row are the recorded ones, parsed by the real
 * `parseRows`; only the Partner Iban cell is varied, with this file's two verified IBANs, so the
 * grammar is satisfied on every row and only the header can tell the column apart from an own
 * account column.
 */
describe('a counterparty account column (#702)', () => {
	const [, n26Header, n26Row] = REAL_HEADERS.find(([name]) => name === 'N26')!;
	const header = parseRows(n26Header)[0].cells;
	const recordedRow = parseRows(n26Row)[0].cells;
	const partner = header.indexOf('Partner Iban');

	/** The recorded row once per value, with the Partner Iban cell replaced. */
	function n26(partnerIbans: string[], extra?: { header: string; values: string[] }) {
		return rowsOf(
			extra ? [...header, extra.header] : header,
			partnerIbans.map((iban, i) => {
				const cells = recordedRow.map((cell, index) => (index === partner ? iban : cell));
				return extra ? [...cells, extra.values[i]] : cells;
			})
		);
	}

	it('finds the Partner Iban column in the recorded header', () => {
		// The premise of every case below: without it, `partner` is -1, nothing is replaced, and the
		// cases measure the recorded row's own IBAN rather than the values they name.
		expect(partner).toBe(3);
	});

	// SEPARATES: « the counterparty column is not a candidate » FROM « a constant counterparty IBAN
	// pins the file to the counterparty's account ». The one-row statement is the recorded row
	// itself: every one-row N26 file is constant by construction.
	it('does not read a one-row statement’s counterparty IBAN as the file’s account', () => {
		expect(findDiscriminantColumn(rowsOf(header, [recordedRow]))).toStrictEqual({
			kind: 'nothing-to-decide'
		});
	});

	it('does not read a constant counterparty IBAN as the file’s account', () => {
		expect(findDiscriminantColumn(n26([ACCOUNT_A, ACCOUNT_A]))).toStrictEqual({
			kind: 'nothing-to-decide'
		});
	});

	// SEPARATES: « the counterparty column is not evidence about the holder's accounts » FROM « an
	// ordinary N26 statement of transfers to two people is a PROVEN multi-account export ».
	it('does not read varying counterparty IBANs as two of the holder’s accounts', () => {
		expect(findDiscriminantColumn(n26([ACCOUNT_A, ACCOUNT_B]))).toStrictEqual({
			kind: 'nothing-to-decide'
		});
	});

	// THE CALIBRATION, in the same file shape: an own account column beside the counterparty one is
	// still read, at ITS index. SEPARATES « the counterparty column is skipped » FROM « a file
	// carrying a counterparty column is skipped whole », which would pass the three cases above.
	it('still reads a constant own account column that sits beside it', () => {
		expect(
			findDiscriminantColumn(
				n26([ACCOUNT_B, ACCOUNT_A], { header: 'Compte', values: [ACCOUNT_A, ACCOUNT_A] })
			)
		).toStrictEqual({ kind: 'resolved', index: header.length, fragment: '0185' });
	});

	// SEPARATES: « a constant counterparty column cannot pin the file » FROM « it pins the file and
	// hides a proven two-account own column behind it », which is the order rule in
	// `findDiscriminantColumn`'s doc (a constant column wins) applied to the wrong column.
	it('does not let a constant counterparty IBAN hide a varying own account column', () => {
		expect(
			findDiscriminantColumn(
				n26([ACCOUNT_A, ACCOUNT_A], { header: 'Compte', values: [ACCOUNT_A, ACCOUNT_B] })
			)
		).toStrictEqual({ kind: 'contradictory', index: header.length });
	});
});

/**
 * #702, over the WHOLE set rather than the one header that prompted it, so a member added later is
 * covered the day it is added and a member that could never match fails here rather than silently.
 */
describe('every header in COUNTERPARTY_ACCOUNT_HEADERS', () => {
	it('is a non-empty set', () => {
		// An empty set turns every `it.each` below into zero tests, which reads as green.
		expect(COUNTERPARTY_ACCOUNT_HEADERS.length).toBeGreaterThan(0);
	});

	// SEPARATES: « the member matches what the fold produces » FROM « the member is written in a
	// form `foldComparableHeader` never returns, so it matches no header and excludes nothing ».
	it.each(COUNTERPARTY_ACCOUNT_HEADERS)('is written in the fold’s own form: %s', (member) => {
		expect(foldComparableHeader(member)).toBe(member);
	});

	// SEPARATES: « the member is a header a real export carries » FROM « it was added from
	// recollection ». A header naming the other party throws away a column that decides where rows
	// are filed, so it earns its place with a recorded header row, never with a memory of one.
	it.each(COUNTERPARTY_ACCOUNT_HEADERS)(
		'is carried by a recorded real header row: %s',
		(member) => {
			const recorded = [...REAL_HEADERS, ...N26_LEGACY_HEADERS].flatMap(([, headerRow]) =>
				parseRows(headerRow)[0].cells.map((cell) => foldComparableHeader(cell))
			);
			expect(recorded).toContain(member);
		}
	);

	const SHAPES: Array<[shape: string, values: [string, string]]> = [
		['a constant IBAN', [ACCOUNT_A, ACCOUNT_A]],
		['two different IBANs', [ACCOUNT_A, ACCOUNT_B]],
		['a constant digit run', ['12344417', '12344417']],
		['two different digit runs', ['12349032', '12340185']]
	];
	const SPELLINGS: Array<[spelling: string, spell: (member: string) => string]> = [
		['as listed', (member) => member],
		['upper cased', (member) => member.toUpperCase()],
		['padded', (member) => `  ${member.replace(/ /g, '  ')} `]
	];
	const cases = COUNTERPARTY_ACCOUNT_HEADERS.flatMap((member) =>
		SPELLINGS.flatMap(([spelling, spell]) =>
			SHAPES.map(([shape, values]) => [spell(member), spelling, shape, values] as const)
		)
	);

	// SEPARATES: « a counterparty column is no candidate in ANY state » FROM « it is skipped only
	// when constant », which the varying shapes catch, and FROM « it is skipped only when spelled
	// exactly as listed », which the spellings catch.
	it.each(cases)('is no candidate: %j %s, carrying %s', (spelled, _spelling, _shape, values) => {
		const result = findDiscriminantColumn(
			rowsOf(
				['Date', 'Libelle', 'Montant', spelled],
				values.map((value, i) => [`0${i + 1}/06/2026`, 'A', '-1,00', value])
			)
		);
		expect(result).toStrictEqual({ kind: 'nothing-to-decide' });
	});

	// THE CALIBRATION, same shapes, through the same helper: the account headers this tree carries
	// that are NOT in the set still read. Without it an exclusion firing on every header would pass
	// every case above. `IBAN` is here on purpose: it does not say whose account it is, so it stays
	// a candidate (see the set's own doc).
	it.each(['Compte', 'Numero de compte', 'accountNum', 'IBAN'])(
		'leaves a header outside the set a candidate: %s',
		(own) => {
			const result = findDiscriminantColumn(
				rowsOf(
					['Date', 'Libelle', 'Montant', own],
					[
						['01/06/2026', 'A', '-1,00', ACCOUNT_A],
						['02/06/2026', 'B', '-2,00', ACCOUNT_A]
					]
				)
			);
			expect(result).toStrictEqual({ kind: 'resolved', index: 3, fragment: '0185' });
		}
	);
});

/**
 * #702's second set: account headers whose party only the header ROW proves, enumerated whole.
 * Every recorded row, current and legacy, is read, so a pair carried by no recorded layout fails.
 */
describe('every pair in COUNTERPARTY_LAYOUTS', () => {
	const RECORDED_HEADER_ROWS = [...REAL_HEADERS, ...N26_LEGACY_HEADERS].map(([, headerRow]) =>
		parseRows(headerRow)[0].cells.map((cell) => foldComparableHeader(cell))
	);

	it('is a non-empty set', () => {
		expect(COUNTERPARTY_LAYOUTS.length).toBeGreaterThan(0);
	});

	// SEPARATES: « both headers match what the fold produces » FROM « one is written in a form the
	// fold never returns, so the pair matches no row and excludes nothing ».
	it.each(COUNTERPARTY_LAYOUTS)('is written in the fold’s own form: $payee / $account', (pair) => {
		expect([foldComparableHeader(pair.payee), foldComparableHeader(pair.account)]).toStrictEqual([
			pair.payee,
			pair.account
		]);
	});

	// SEPARATES: « the pair is one recorded layout » FROM « two headers that never share a row ».
	it.each(COUNTERPARTY_LAYOUTS)(
		'is carried by one recorded header row: $payee / $account',
		(pair) => {
			expect(
				RECORDED_HEADER_ROWS.some((row) => row.includes(pair.payee) && row.includes(pair.account))
			).toBe(true);
		}
	);

	const SHAPES: Array<[shape: string, values: [string, string]]> = [
		['a constant IBAN', [ACCOUNT_A, ACCOUNT_A]],
		['two different IBANs', [ACCOUNT_A, ACCOUNT_B]],
		['a constant digit run', ['12344417', '12344417']],
		['two different digit runs', ['12349032', '12340185']]
	];
	const SPELLINGS: Array<[spelling: string, spell: (member: string) => string]> = [
		['as listed', (member) => member],
		['upper cased', (member) => member.toUpperCase()],
		['padded', (member) => `  ${member.replace(/ /g, '  ')} `]
	];
	const cases = COUNTERPARTY_LAYOUTS.flatMap((pair) =>
		SPELLINGS.flatMap(([spelling, spell]) =>
			SHAPES.map(
				([shape, values]) =>
					[spell(pair.payee), spell(pair.account), spelling, shape, values] as const
			)
		)
	);

	function withPayee(payee: string | null, account: string, values: readonly string[]) {
		const header =
			payee === null ? ['Date', 'Montant', account] : ['Date', payee, 'Montant', account];
		return findDiscriminantColumn(
			rowsOf(
				header,
				values.map((value, i) =>
					payee === null
						? [`0${i + 1}/06/2026`, '-1,00', value]
						: [`0${i + 1}/06/2026`, 'Paul Mercier', '-1,00', value]
				)
			)
		);
	}

	// SEPARATES: « beside its payee column, the account column is no candidate in ANY state » FROM
	// « it is skipped only when constant » and « only when spelled as listed ».
	it.each(cases)(
		'is no candidate beside %j: %j %s, carrying %s',
		(payee, account, _s, _h, values) => {
			expect(withPayee(payee, account, values)).toStrictEqual({ kind: 'nothing-to-decide' });
		}
	);

	// THE HOLDER CALIBRATION: the same account word in a row WITHOUT a payee column is still read.
	// `Numéro de compte` is the holder's column in other banks' exports; without this, excluding
	// the word unconditionally would pass every case above.
	it.each(COUNTERPARTY_LAYOUTS)('leaves $account a candidate with no payee column', (pair) => {
		expect(withPayee(null, pair.account, [ACCOUNT_A, ACCOUNT_A])).toStrictEqual({
			kind: 'resolved',
			index: 2,
			fragment: '0185'
		});
	});

	// SEPARATES: « a pair is one layout » FROM « any payee header excludes any listed account
	// header », the cross product nothing records.
	const crossed = COUNTERPARTY_LAYOUTS.flatMap((pair) =>
		COUNTERPARTY_LAYOUTS.filter((other) => other !== pair).map(
			(other) => [other.payee, pair.account] as const
		)
	);
	it.each(crossed)('leaves %j beside %j a candidate', (payee, account) => {
		expect(withPayee(payee, account, [ACCOUNT_A, ACCOUNT_A])).toStrictEqual({
			kind: 'resolved',
			index: 3,
			fragment: '0185'
		});
	});
});

/**
 * #702, the direction the header sets cannot check for themselves: every account column a
 * recorded header row carries (`RECORDED_ACCOUNT_COLUMNS`), read in ITS OWN recorded row. A
 * counterparty column recorded there and missing from the discriminant's sets goes red here, which
 * the sets' own membership tests cannot notice. The other cells carry a word, so only the column
 * under test can qualify.
 */
describe('every recorded account column, read in its own recorded row', () => {
	const RECORDED_ROWS = new Map<string, string>([
		...REAL_HEADERS.map(([name, headerRow]) => [name, headerRow] as [string, string]),
		...N26_LEGACY_HEADERS
	]);

	function recordedFile(row: string, column: string, values: readonly string[]) {
		const header = parseRows(RECORDED_ROWS.get(row) ?? '')[0]?.cells ?? [];
		const index = header.indexOf(column);
		return {
			index,
			rows: rowsOf(
				header,
				values.map((value) => header.map((_, i) => (i === index ? value : 'x')))
			)
		};
	}

	// The premise: every entry names a recorded row and a column of it. Without it `index` is -1,
	// no column carries the values, and every counterparty case below is green for nothing.
	it.each(RECORDED_ACCOUNT_COLUMNS)('names a column of a recorded row: %s %s', (row, column) => {
		expect(recordedFile(row, column, [ACCOUNT_A]).index).toBeGreaterThanOrEqual(0);
	});

	/** What a HOLDER's column yields for each shape; a counterparty column yields nothing. */
	const SHAPES: Array<[shape: string, values: [string, string], holder: object]> = [
		['a constant IBAN', [ACCOUNT_A, ACCOUNT_A], { kind: 'resolved', fragment: '0185' }],
		['two different IBANs', [ACCOUNT_A, ACCOUNT_B], { kind: 'contradictory' }],
		['a constant digit run', ['12344417', '12344417'], { kind: 'resolved', fragment: '4417' }],
		['two different digit runs', ['12349032', '12340185'], { kind: 'ambiguous' }]
	];
	const cases = RECORDED_ACCOUNT_COLUMNS.flatMap(([row, column, party]) =>
		SHAPES.map(([shape, values, holder]) => [row, column, party, shape, values, holder] as const)
	);

	// SEPARATES: « the column is read as the party its recorded row says it names » FROM « it is
	// read by its values alone », per column and per shape.
	it.each(cases)('%s %s (%s), carrying %s', (row, column, party, _shape, values, holder) => {
		const file = recordedFile(row, column, values);
		expect(findDiscriminantColumn(file.rows)).toStrictEqual(
			party === 'counterparty' ? { kind: 'nothing-to-decide' } : { ...holder, index: file.index }
		);
	});
});

describe('assertDiscriminantFree', () => {
	it('refuses a second account carrying a discriminant another account already holds', () => {
		expect(() => assertDiscriminantFree('0185', [{ discriminant: '0185' }])).toThrow();
		expect(() => assertDiscriminantFree('0185', [{ discriminant: '9032' }])).not.toThrow();
	});

	it('ignores accounts that hold no discriminant', () => {
		expect(() =>
			assertDiscriminantFree('0185', [{ discriminant: null }, { discriminant: null }])
		).not.toThrow();
	});

	// THE FRAGMENT IS A SENSITIVE DATA CLASS. Four characters from the end of an IBAN identify one
	// of a holder's own accounts, so it must not reach a log line, an error message, a telemetry
	// event or a crash breadcrumb. A thrown message is the shortest path to all four at once: it is
	// what a stack trace carries, what an error reporter uploads and what a 500 page can echo.
	it('never puts the fragment in the message it throws', () => {
		let message = '';
		try {
			assertDiscriminantFree('0185', [{ discriminant: '0185' }]);
		} catch (error) {
			message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
		}
		expect(message).not.toBe('');
		expect(message).not.toContain('0185');
	});
});
