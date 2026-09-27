import { describe, expect, it } from 'vitest';
import { readImportFile, IMPORT_FILE_MAX_BYTES } from './file';
import { parseCsvTransactionRows } from './csv';
import { buildInvalidRowDetails } from './invalidRowDetails';
import { groupInvalidRows } from '$lib/domain/groupInvalidRows';
import { refusalLabel } from '$lib/i18n/refusalLabel';

/**
 * #692 through the pieces `/import` chains, in its order: read the upload, parse it, shape the
 * refused rows, fold them into groups, and render each group's heading. Each piece has its own
 * spec; this one is about the JOIN, which is where a heading naming one row's currency over a
 * group of several would come from.
 *
 * The route passes more options than this (`maxBytes` aside, a mapping and category rules); none
 * of them reaches the currency check, which reads the file's own `currency` column.
 */
describe('the rows table on a file refused on two currencies', () => {
	it('gives each currency its own heading, naming that currency', async () => {
		const file = new File(
			[
				[
					'date,label,amount,category,currency',
					'2026-06-01,Libraire,-12.40,Loisirs,USD',
					'2026-06-02,Cafe,-3.10,Sorties,GBP',
					'2026-06-03,Musee,-9.00,Loisirs,USD',
					'2026-06-04,Boulangerie,-2.20,Courses,EUR'
				].join('\n')
			],
			'mixed-currencies.csv',
			{ type: 'text/csv' }
		);

		const read = await readImportFile(file);
		const result = parseCsvTransactionRows(read.rows, { maxBytes: IMPORT_FILE_MAX_BYTES });
		const groups = groupInvalidRows(buildInvalidRowDetails(read.previewRowsByLine, result));

		expect(
			groups.map((group) => ({ heading: refusalLabel(group.head.fact), count: group.count }))
		).toEqual([
			{ heading: 'devise non prise en charge : « USD »', count: 2 },
			{ heading: 'devise non prise en charge : « GBP »', count: 1 }
		]);
	});
});
