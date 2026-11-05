import { describe, expect, it } from 'vitest';
import { columnProposals } from './columnProposals';
import { REQUIRED_COLUMN_ALIASES, REQUIRED_ROLES } from './profiles/columnAliases';
import { foldComparableHeader } from './utils/encoding';
import { isDateCellUnderEitherReading, parseRows } from './utils/csv';
import { parseAmountCents } from './utils/money';

/**
 * Two premises `rowProvenance` (`$lib/domain/designationLayer`) rests on, asserted against the
 * PRODUCTION producers rather than restated (#1207 C2b).
 *
 * 1. A detected designation's layer follows from `hasHeaderRow` alone: under a header row every
 *    designated role's header is in that role's alias list (a rule), and without one only the
 *    currency is designated (by its values, the file).
 * 2. Joint assignment across roles needs no code: no cell parses as both a date and an amount, so
 *    no column is a candidate under both. Measured 0 of 67 synthetic files on 2026-11-05.
 */
const HEADER_FILES = [
	['Date;Libellé;Montant', '03/02/2026;CARREFOUR;-24,90', '24/02/2026;ORANGE;-39,99'],
	[
		'Date opération;Date valeur;Libellé;Débit;Crédit',
		'03/02/2026;04/02/2026;CB A;24,90;',
		'24/02/2026;25/02/2026;VIR B;;100,00'
	],
	['date,description,amount,currency', '2026-02-03,Coffee,-3.20,EUR', '2026-02-24,Rent,-900.00,EUR']
];
const HEADERLESS_FILES = [
	['03/02/2026;CARREFOUR;-24,90;EUR', '24/02/2026;ORANGE;-39,99;EUR'],
	['2026-02-03,Coffee,-3.20', '2026-02-24,Rent,-900.00']
];

describe('the layer of a detected designation follows from the header-row answer', () => {
	// Separates « designated by its header name » from « designated by its values » under a header row.
	it('designates, under a header row, only a column whose header is in the role alias list', () => {
		let designated = 0;
		for (const lines of HEADER_FILES) {
			const rows = parseRows(lines.join('\n'));
			const headers = rows[0].cells.map((cell) => foldComparableHeader(cell));
			const { designated: roles } = columnProposals(rows, true);
			for (const role of REQUIRED_ROLES) {
				const index = roles[role];
				if (index === null) continue;
				designated += 1;
				expect((REQUIRED_COLUMN_ALIASES[role] as readonly string[]).includes(headers[index])).toBe(
					true
				);
			}
			expect(roles.currency).toBeNull();
			expect(roles.category).toBeNull();
		}
		// The positive the loop needs: a premise over zero designations proves nothing.
		expect(designated).toBeGreaterThanOrEqual(6);
	});

	// Separates « headerless designates the currency by its values » from « headerless designates a
	// required role by its shape », which would make that role a file proof, not a currency code.
	it('designates, without a header row, the currency alone', () => {
		let currencies = 0;
		for (const lines of HEADERLESS_FILES) {
			const { designated } = columnProposals(parseRows(lines.join('\n')), false);
			expect({ ...designated, currency: null }).toEqual({
				date: null,
				label: null,
				amount: null,
				category: null,
				currency: null
			});
			if (designated.currency !== null) currencies += 1;
		}
		expect(currencies).toBe(1);
	});
});

describe('no cell is a candidate for both the date and the amount', () => {
	/**
	 * Exhaustive over the shapes a bank cell takes: one to three numeric groups of 1, 2 or 4 digits
	 * under every separator, with and without a sign and a decimal comma or point, and bare digit
	 * runs up to 8 (compact dates). The day a parser widens to read `20260203` as a date, this reds,
	 * and `columnProposals` needs a joint assignment.
	 */
	it('finds no value read both as a date and as an amount', () => {
		const groups = ['3', '03', '12', '24', '2026'];
		const cells = new Set<string>();
		for (const sep of ['/', '-', '.', ' ', ',']) {
			for (const a of groups) {
				for (const b of groups) {
					cells.add(`${a}${sep}${b}`);
					for (const c of groups) cells.add(`${a}${sep}${b}${sep}${c}`);
				}
			}
		}
		for (const run of ['1', '12', '123', '1234', '12345', '120326', '1203202', '20260203'])
			for (const sign of ['', '-', '+']) cells.add(`${sign}${run}`);
		const both = [...cells].filter(
			(cell) => isDateCellUnderEitherReading(cell) && parseAmountCents(cell) !== null
		);
		// Calibration: the set holds dates and amounts, so an empty intersection is a finding.
		expect([...cells].filter((cell) => isDateCellUnderEitherReading(cell)).length).toBeGreaterThan(
			20
		);
		expect([...cells].filter((cell) => parseAmountCents(cell) !== null).length).toBeGreaterThan(20);
		expect(both).toEqual([]);
	});
});
