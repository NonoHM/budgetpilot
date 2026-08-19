import { describe, expect, it } from 'vitest';
import { readWithHeaderRow } from './headerRowReading';
import type { DesignationFile } from './columnDesignation';

/**
 * The measured case: a four-column file whose first line detection read as headers.
 *
 * The fixture separates the two readings on EVERY figure the screen shows, which is what a fixture
 * agreeing on one of them could not do.
 */
const FILE = {
	name: 'walk.csv',
	headers: ['Zone A', 'Zone B', 'Zone C', 'Zone D'],
	samples: [['03/03/2019'], ['BOULANGERIE'], ['W001'], ['-8,20']],
	previewRows: [
		['03/03/2019', 'BOULANGERIE', 'W001', '-8,20'],
		['04/03/2019', 'LIBRAIRIE', 'W002', '-15,50']
	],
	rowCount: 2,
	detectedHeaderRow: true
} as DesignationFile;

describe('readWithHeaderRow', () => {
	// The RESOLVED shape, which is not the same type as what went in: the guess is replaced by the
	// answer rather than sitting beside it, so no consumer can read the wrong one.
	it('leaves the file alone while the user agrees with detection', () => {
		const { detectedHeaderRow: _guess, ...rest } = FILE;

		expect(readWithHeaderRow(FILE, true)).toStrictEqual({ ...rest, hasHeaderRow: true });
	});

	// THE FIELD IS GONE, not merely ignored. This is what makes reading the guess downstream a
	// compile error rather than a comment somebody has to notice, which is the whole repair.
	it('carries no detection guess at all on the way out', () => {
		expect(readWithHeaderRow(FILE, false)).not.toHaveProperty('detectedHeaderRow');
	});

	// THE FALSE FIGURE. The primary reads this count, and the server read three where it promised
	// two: the header line is a transaction once the user says it is.
	it('counts the header line as a row once it is declared data', () => {
		expect(readWithHeaderRow(FILE, false).rowCount).toBe(3);
	});

	// And it is SHOWN, at the top, where it belongs. A count that changed while the preview did not
	// would be a second disagreement rather than a repair.
	it('puts that line back at the top of the preview', () => {
		const read = readWithHeaderRow(FILE, false);

		expect(read.previewRows).toHaveLength(3);
		expect(read.previewRows?.[0]).toStrictEqual(['Zone A', 'Zone B', 'Zone C', 'Zone D']);
		expect(read.previewRows?.[1]).toStrictEqual(FILE.previewRows?.[0]);
	});

	// The original is not mutated: the screen holds one file and derives the other on every render.
	it('does not mutate the file it was given', () => {
		readWithHeaderRow(FILE, false);

		expect(FILE.rowCount).toBe(2);
		expect(FILE.previewRows).toHaveLength(2);
	});
});
