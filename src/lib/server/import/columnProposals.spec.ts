import { describe, expect, it } from 'vitest';
import { columnProposals } from './columnProposals';
import { parseRows } from './utils/csv';

/**
 * Arbitration B3, as the plate rules it: « Une règle, pas un score : nom sans ambiguïté et valeurs
 * analysables. » A role is DESIGNATED only when its header names exactly one column and that
 * column's values parse for the role; two equal columns leave the row empty and are both proposed;
 * a value shape alone proposes and never designates (#352).
 *
 * Every assertion compares the WHOLE result, because a proposal present in the wrong role or present
 * twice satisfies any check written about its presence.
 */
const NONE = { date: [], label: [], amount: [], category: [] };
const EMPTY = { date: null, label: null, amount: null, category: null };

function rows(...lines: string[]) {
	return parseRows(lines.join('\n'));
}

describe('columnProposals, the designation screen proposal rule', () => {
	/**
	 * Separates « the header names one column whose values parse » (designated) from « recognised but
	 * left for the member ». The label header `Détail` is in no alias list, so that row stays empty
	 * and nothing is proposed for it: every text column would qualify on values alone.
	 */
	it('designates the roles whose header names one column with parseable values', () => {
		expect.assertions(1);
		const result = columnProposals(
			rows('Date;Détail;Montant', '03/02/2026;CARREFOUR;-24,90', '24/02/2026;ORANGE;-39,99'),
			true
		);
		expect(result).toEqual({
			designated: { ...EMPTY, date: 0, amount: 2 },
			candidates: { ...NONE, date: [0], amount: [2] }
		});
	});

	/**
	 * Separates counting COLUMNS from counting ALIASES. `resolveRequiredColumns` counts aliases, so
	 * two columns both headed `Montant` read there as one; designating it would pick one of two equal
	 * columns, which B3 forbids by name (« la machine ne tranche pas entre égaux »).
	 */
	it('leaves a role empty and proposes both when two columns carry the same header', () => {
		expect.assertions(1);
		const result = columnProposals(
			rows('Date;Montant;Détail;Montant', '24/02/2026;-24,90;CARREFOUR;-24,90'),
			true
		);
		expect(result).toEqual({
			designated: { ...EMPTY, date: 0 },
			candidates: { ...NONE, date: [0], amount: [1, 3] }
		});
	});

	/** Separates « one alias present » from « two different aliases of one role present ». */
	it('leaves a role empty and proposes both when two aliases of the role name two columns', () => {
		expect.assertions(1);
		const result = columnProposals(
			rows('Booking Date;Date;Détail;Amount', '03/02/2026;04/02/2026;CARREFOUR;-24.90'),
			true
		);
		expect(result).toEqual({
			designated: { ...EMPTY, amount: 3 },
			candidates: { ...NONE, date: [0, 1], amount: [3] }
		});
	});

	/**
	 * Separates « the name is unambiguous » from « the name AND the values are ». A `Montant` column
	 * whose cells are words is proposed, never designated: the plate needs both halves.
	 */
	it('proposes without designating a named column whose values do not parse', () => {
		expect.assertions(1);
		const result = columnProposals(rows('Date;Montant', '24/02/2026;vingt euros'), true);
		expect(result).toEqual({
			designated: { ...EMPTY, date: 0 },
			candidates: { ...NONE, date: [0], amount: [1] }
		});
	});

	/**
	 * Separates « every non-empty cell parses » from « some cell does ». `columnDateState` calls a
	 * column `proven-shape` on ONE date; a trailer line in the date column must stop a designation.
	 */
	it('does not designate a date column holding one cell that is not a date', () => {
		expect.assertions(1);
		const result = columnProposals(
			rows('Date;Montant', '03/02/2026;-24,90', 'Solde final;-24,90'),
			true
		);
		expect(result).toEqual({
			designated: { ...EMPTY, amount: 1 },
			candidates: { ...NONE, date: [0], amount: [1] }
		});
	});

	/** Separates a date column with one reading from one that proves both orders. */
	it('does not designate a date column that proves both day-first and month-first', () => {
		expect.assertions(1);
		const result = columnProposals(
			rows('Date;Montant', '24/02/2026;-1,00', '02/24/2026;-1,00'),
			true
		);
		expect(result).toEqual({
			designated: { ...EMPTY, amount: 1 },
			candidates: { ...NONE, date: [0], amount: [1] }
		});
	});

	/**
	 * Separates a date column whose order the file settles from one whose every cell reads both ways.
	 * The second is not « l'univoque »: designated, it would reach the submit without the reading
	 * question ever being asked (#352, final pass F1); since #1200 the server refuses that submit.
	 * Proposed instead, so opening it asks.
	 */
	it('proposes without designating a date column whose order is ambiguous', () => {
		expect.assertions(1);
		const result = columnProposals(
			rows('Date;Montant', '01/02/2026;-1,00', '03/04/2026;-1,00'),
			true
		);
		expect(result).toEqual({
			designated: { ...EMPTY, amount: 1 },
			candidates: { ...NONE, date: [0], amount: [1] }
		});
	});

	/** Separates a named column with a value from a named column blank on every row. */
	it('does not designate a named column that is blank on every row', () => {
		expect.assertions(1);
		const result = columnProposals(rows('Date;Libellé;Montant', '24/02/2026;;-24,90'), true);
		expect(result).toEqual({
			designated: { ...EMPTY, date: 0, amount: 2 },
			candidates: { ...NONE, date: [0], label: [1], amount: [2] }
		});
	});

	/**
	 * Separates « a header names the column » from « the values look like the role ». With no alias
	 * anywhere, date-shaped and amount-shaped columns are proposed and nothing is designated, and the
	 * label is not proposed from values at all.
	 */
	it('proposes value-shaped columns and designates nothing when no header is recognised', () => {
		expect.assertions(1);
		const result = columnProposals(
			rows('Col A;Col B;Col C;Col D', '03/02/2026;CARREFOUR;-24,90;04/02/2026'),
			true
		);
		expect(result).toEqual({
			designated: EMPTY,
			candidates: { ...NONE, date: [0, 3], amount: [2] }
		});
	});

	/**
	 * Separates the two answers about line 1. When line 1 is data, its cells are not names, so the
	 * same bytes that designate under « en-têtes » designate nothing, and only value shapes propose,
	 * now read over line 1 as well.
	 */
	it('designates nothing from line 1 when line 1 is declared data', () => {
		expect.assertions(1);
		const result = columnProposals(
			rows('Date;Libellé;Montant', '03/02/2026;CARREFOUR;-24,90'),
			false
		);
		expect(result).toEqual({ designated: EMPTY, candidates: NONE });
	});

	/** Separates the three required roles, which have aliases, from Catégorie, which has none. */
	it('never proposes a category column', () => {
		expect.assertions(1);
		const result = columnProposals(
			rows('Date;Libellé;Montant;Catégorie', '03/02/2026;CARREFOUR;-24,90;Courses'),
			true
		);
		expect(result.candidates.category).toEqual([]);
	});
});
