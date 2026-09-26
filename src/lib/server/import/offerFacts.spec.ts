import { describe, expect, it } from 'vitest';
import {
	CSV_REFUSAL_CODES,
	DESIGNATION_REACH,
	designationReach,
	refusedForBounds,
	type CsvRefusalCode,
	type CsvRefusalFact
} from './refusals';
import { designationCanHelp } from './offerFacts';

/**
 * « CAN A DESIGNATION HELP THIS FILE? », ONE ANSWER FOR BOTH DOORS (#351, #628).
 *
 * Every refusal code is classified once, beside the union, and every case below takes its codes
 * FROM that registry rather than from a list typed here: a code added to `refusals.ts` is either
 * classified or does not compile, and whichever class it lands in, the gate's behaviour for that
 * class is already asserted over it.
 */

/** A fact carrying only its code: the gate reads nothing else, and the payloads vary per code. */
const factOf = (code: CsvRefusalCode) => ({ code }) as CsvRefusalFact;
const codesReaching = (reach: string) =>
	CSV_REFUSAL_CODES.filter((code) => designationReach(code) === reach);
const HEADERS = ['date', 'label', 'amount'];

describe('the classification of every refusal code', () => {
	/**
	 * Break (a code deleted from `DESIGNATION_REACH` behind a cast): red on that code, separating
	 * « every code of the union is classified » from « the codes somebody remembered are ».
	 */
	it.each(CSV_REFUSAL_CODES)('classifies %s', (code) => {
		expect.assertions(1);
		expect(['repairable', 'unrepairable', 'dimensions']).toContain(designationReach(code));
	});

	/** The other direction: a key the union no longer has is a classification of nothing. */
	it('classifies exactly the codes of the union', () => {
		expect.assertions(1);
		expect(Object.keys(DESIGNATION_REACH).sort()).toEqual([...CSV_REFUSAL_CODES].sort());
	});

	/**
	 * #628's question, answered: the bound codes and the cannot-repair codes were two lists that
	 * disagreed. They are now one table, and `refusedForBounds` reads its `dimensions` member. The
	 * two predicates are compared over EVERY code, which is the only input set that distinguishes
	 * them. Break (`refusedForBounds` given its own list back): red on each code the lists split on.
	 */
	it.each(CSV_REFUSAL_CODES)('agrees with refusedForBounds on %s', (code) => {
		expect.assertions(1);
		const result = { invalidRows: [{ scope: { kind: 'file' as const }, fact: factOf(code) }] };
		expect(refusedForBounds(result)).toBe(designationReach(code) === 'dimensions');
	});

	/** A figure beside the absence assertions below: each class these cases range over is inhabited. */
	it('has members in each class, so no case below ranges over nothing', () => {
		expect.assertions(3);
		expect(codesReaching('repairable').length).toBeGreaterThan(0);
		expect(codesReaching('unrepairable').length).toBeGreaterThan(0);
		expect(codesReaching('dimensions')).toEqual(
			expect.arrayContaining(['file-empty', 'too-many-rows', 'too-many-columns'])
		);
	});
});

describe('designationCanHelp', () => {
	/**
	 * Break (the dimensions clause removed): red, separating « no arrangement of columns changes a
	 * row count » from « the user said the columns are wrong, so open the screen ». Asserted with
	 * `columnsDisowned`, the input that would otherwise open it.
	 */
	it.each(codesReaching('dimensions'))('refuses a file refused on %s, at either door', (code) => {
		expect.assertions(2);
		const refusals = [factOf(code)];
		expect(designationCanHelp({ headerCells: HEADERS, refusals, columnsDisowned: true })).toBe(
			false
		);
		expect(designationCanHelp({ headerCells: HEADERS, refusals, columnsDisowned: false })).toBe(
			false
		);
	});

	/** Break (the repairable clause inverted): red on every repairable code. */
	it.each(codesReaching('repairable'))('offers the screen to a file refused on %s', (code) => {
		expect.assertions(1);
		expect(
			designationCanHelp({ headerCells: HEADERS, refusals: [factOf(code)], columnsDisowned: false })
		).toBe(true);
	});

	/** Break (`some` read as « any refusal at all »): red on every unrepairable code. */
	it.each(codesReaching('unrepairable'))('does not offer it on %s alone', (code) => {
		expect.assertions(1);
		expect(
			designationCanHelp({ headerCells: HEADERS, refusals: [factOf(code)], columnsDisowned: false })
		).toBe(false);
	});

	/** `some`, not `every`: one row beyond repair does not close the screen to the rest. */
	it('offers it when one refusal among unrepairable ones is repairable', () => {
		expect.assertions(1);
		const refusals = [factOf('unsupported-currency'), factOf('invalid-date')];
		expect(designationCanHelp({ headerCells: HEADERS, refusals, columnsDisowned: false })).toBe(
			true
		);
	});

	/** The correction door: the user's own statement that the columns are wrong is the repairable fact. */
	it('opens the correction door on a file with no refusal', () => {
		expect.assertions(2);
		expect(designationCanHelp({ headerCells: HEADERS, refusals: [], columnsDisowned: true })).toBe(
			true
		);
		// And the upload door, which has no such statement, does not open on nothing.
		expect(designationCanHelp({ headerCells: HEADERS, refusals: [], columnsDisowned: false })).toBe(
			false
		);
	});

	it('never opens on a file with no header cell to designate', () => {
		expect.assertions(1);
		expect(
			designationCanHelp({
				headerCells: [],
				refusals: [factOf('header-not-recognized')],
				columnsDisowned: true
			})
		).toBe(false);
	});

	/**
	 * #712's other half. A profile that reads a debit/credit pair is not a split refusal, and the
	 * screen's one amount role still cannot express it: `/import/columns` would refuse the pair
	 * after the work. Break (the clause removed): red, separating the two.
	 */
	it('does not offer the screen for a file whose profile reads its amounts from two columns', () => {
		expect.assertions(1);
		expect(
			designationCanHelp({
				headerCells: HEADERS,
				refusals: [factOf('invalid-date')],
				columnsDisowned: false,
				amountPairRead: true
			})
		).toBe(false);
	});
});
