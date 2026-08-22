import { describe, expect, it } from 'vitest';
import type { ParsedCsvRow } from './types';
import {
	DISCRIMINANT_LENGTH,
	assertDiscriminantFree,
	findDiscriminantColumn
} from './discriminant';

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
		expect(result).toStrictEqual({ kind: 'found', index: 3, fragment: '0185' });
	});

	// THE EVIDENCE IS THE CONSTANCY, NOT THE GRAMMAR. A column of well-formed IBANs that DIFFER is
	// not a discriminant, it is a multi-account export, and it is REFUSED with a sentence rather than
	// dropped into a silent rank 3.
	it('refuses a column carrying more than one account, rather than falling through', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', ACCOUNT_A],
				['02/06/2026', 'B', '-2,00', ACCOUNT_B]
			])
		);
		expect(result).toStrictEqual({ kind: 'multi-account', index: 3 });
	});

	it('rejects an IBAN whose checksum does not verify', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', 'FR7630001007941234567890186'],
				['02/06/2026', 'B', '-2,00', 'FR7630001007941234567890186']
			])
		);
		expect(result).toStrictEqual({ kind: 'none' });
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
		expect(result).toStrictEqual({ kind: 'none' });
	});

	it('never returns more than four characters', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', ACCOUNT_A],
				['02/06/2026', 'B', '-2,00', ACCOUNT_A]
			])
		);
		expect(result.kind === 'found' && result.fragment.length).toBe(4);
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
		expect(result).toStrictEqual({ kind: 'found', index: 3, fragment: '8901' });
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
		expect(result).toStrictEqual({ kind: 'none' });
	});

	it('skips a column that is blank on any data row', () => {
		const result = findDiscriminantColumn(
			rowsOf(HEADER, [
				['01/06/2026', 'A', '-1,00', ACCOUNT_A],
				['02/06/2026', 'B', '-2,00', '']
			])
		);
		expect(result).toStrictEqual({ kind: 'none' });
	});

	it('finds nothing in a file that carries no data row at all', () => {
		expect(findDiscriminantColumn(rowsOf(HEADER, []))).toStrictEqual({ kind: 'none' });
		expect(findDiscriminantColumn([])).toStrictEqual({ kind: 'none' });
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
