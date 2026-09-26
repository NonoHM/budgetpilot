import { describe, expect, it } from 'vitest';
import { declareHeaderRow, readWithHeaderRow } from './headerRowReading';
import {
	DESIGNATION_FIXED_FIELDS,
	DESIGNATION_ROW_FACTS,
	type DesignationFile,
	type DesignationRowFacts
} from './columnDesignation';

/**
 * The measured case: a four-column file whose first line detection read as headers.
 *
 * The fixture separates the two readings on EVERY per-row fact the screen shows: each value under
 * `otherHeaderRowFacts` differs from its counterpart above it, which is what a fixture agreeing on
 * one of them could not do. The values are what the server's `designationRowFacts` computes for
 * these lines, written out by hand.
 */
const AS_DATA: DesignationRowFacts = {
	samples: [
		['Zone A', '03/03/2019', '04/03/2019'],
		['Zone B', 'BOULANGERIE', 'LIBRAIRIE'],
		['Zone C', 'W001', 'W002'],
		['Zone D', '-8,20', '-15,50']
	],
	firstRow: ['Zone A', 'Zone B', 'Zone C', 'Zone D'],
	previewRows: [
		['Zone A', 'Zone B', 'Zone C', 'Zone D'],
		['03/03/2019', 'BOULANGERIE', 'W001', '-8,20'],
		['04/03/2019', 'LIBRAIRIE', 'W002', '-15,50']
	],
	coverage: [3, 3, 3, 3],
	dateStates: ['no-dates', 'no-dates', 'no-dates', 'no-dates'],
	dateReadings: [
		{ dayFirst: [null, null, '2019-03-03'], monthFirst: [null, null, '2019-03-03'] },
		{ dayFirst: [null], monthFirst: [null] },
		{ dayFirst: [null], monthFirst: [null] },
		{ dayFirst: [null], monthFirst: [null] }
	]
};

const FILE: DesignationFile = {
	name: 'walk.csv',
	headers: ['Zone A', 'Zone B', 'Zone C', 'Zone D'],
	samples: [['03/03/2019'], ['BOULANGERIE'], ['W001'], ['-8,20']],
	firstRow: ['03/03/2019', 'BOULANGERIE', 'W001', '-8,20'],
	previewRows: [
		['03/03/2019', 'BOULANGERIE', 'W001', '-8,20'],
		['04/03/2019', 'LIBRAIRIE', 'W002', '-15,50']
	],
	coverage: [2, 2, 2, 2],
	dateStates: ['ambiguous', 'no-dates', 'no-dates', 'no-dates'],
	dateReadings: [
		{ dayFirst: ['2019-03-03'], monthFirst: ['2019-03-03'] },
		{ dayFirst: [], monthFirst: [] },
		{ dayFirst: [], monthFirst: [] },
		{ dayFirst: [], monthFirst: [] }
	],
	rowCount: 2,
	detectedHeaderRow: true,
	otherHeaderRowFacts: AS_DATA
};

describe('readWithHeaderRow', () => {
	// The RESOLVED shape, which is not the same type as what went in: the guess is replaced by the
	// answer rather than sitting beside it, so no consumer can read the wrong one.
	it('leaves the file alone while the user agrees with detection', () => {
		const { detectedHeaderRow: _guess, otherHeaderRowFacts: _other, ...rest } = FILE;

		expect(readWithHeaderRow(FILE, true)).toStrictEqual({ ...rest, hasHeaderRow: true });
	});

	// THE FIELDS ARE GONE, not merely ignored. This is what makes reading the guess, or the facts
	// under the answer the user did not give, a compile error downstream rather than a comment.
	it('carries neither the detection guess nor the other answer on the way out', () => {
		const read = readWithHeaderRow(FILE, false);

		expect(read).not.toHaveProperty('detectedHeaderRow');
		expect(read).not.toHaveProperty('otherHeaderRowFacts');
	});

	// THE FALSE FIGURE. The primary reads this count, and the server read three where it promised
	// two: the header line is a transaction once the user says it is.
	it('counts the header line as a row once it is declared data', () => {
		expect(readWithHeaderRow(FILE, false).rowCount).toBe(3);
	});

	/**
	 * #735, ENUMERATED FROM THE REGISTRY. Every per-row fact is the other answer's once line 1 is
	 * declared data. Separates « the fact follows the switch » from « the fact still describes the
	 * file with line 1 skipped », per fact, because the fixture makes every pair differ.
	 */
	it.each(DESIGNATION_ROW_FACTS)('swaps %s for the facts under the answer given', (fact) => {
		expect.assertions(2);
		// The fixture must distinguish, or the swap and its absence are the same green.
		expect(AS_DATA[fact]).not.toStrictEqual(FILE[fact]);
		expect(readWithHeaderRow(FILE, false)[fact]).toStrictEqual(AS_DATA[fact]);
	});

	// The fixed fields do NOT move with the answer; `rowCount` moves by one line, asserted above.
	it.each(DESIGNATION_FIXED_FIELDS.filter((field) => field === 'name' || field === 'headers'))(
		'keeps %s as it is',
		(field) => {
			expect(readWithHeaderRow(FILE, false)[field]).toStrictEqual(FILE[field]);
		}
	);

	/**
	 * A payload with no facts for the other answer (the recap has no rows to compute them from)
	 * shows NO evidence once flipped. Separates « nothing to show » from « the old facts, about the
	 * wrong lines », which is #735 itself.
	 */
	it('shows no evidence when the payload carries no facts for the answer given', () => {
		const { otherHeaderRowFacts: _other, ...withoutOther } = FILE;
		const read = readWithHeaderRow(withoutOther, false);

		expect({
			samples: read.samples,
			firstRow: read.firstRow,
			previewRows: read.previewRows,
			coverage: read.coverage,
			dateStates: read.dateStates,
			dateReadings: read.dateReadings
		}).toStrictEqual({
			samples: [[], [], [], []],
			firstRow: undefined,
			previewRows: undefined,
			coverage: undefined,
			dateStates: undefined,
			dateReadings: undefined
		});
	});

	// The original is not mutated: the screen holds one file and derives the other on every render.
	it('does not mutate the file it was given', () => {
		readWithHeaderRow(FILE, false);

		expect(FILE.rowCount).toBe(2);
		expect(FILE.previewRows).toHaveLength(2);
		expect(FILE.otherHeaderRowFacts).toBe(AS_DATA);
	});
});

/**
 * The duplicate-statement repost reopens the screen with the user's answer AS the guess. Declaring
 * it swaps the facts and moves the count, and declaring the original answer again restores both, so
 * the flip is an involution: no fact is lost or duplicated by going back and forth.
 */
describe('declareHeaderRow', () => {
	it('returns to the same file after declaring the other answer and back', () => {
		expect(declareHeaderRow(declareHeaderRow(FILE, false), true)).toStrictEqual(FILE);
	});

	it('moves the count down by the line that becomes headers again', () => {
		const asData = declareHeaderRow(FILE, false);

		expect(asData.rowCount).toBe(3);
		expect(readWithHeaderRow(asData, true).rowCount).toBe(2);
	});
});
