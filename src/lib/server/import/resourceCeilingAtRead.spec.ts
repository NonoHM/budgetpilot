import { describe, expect, it } from 'vitest';
import { ImportFileError, readImportFile, IMPORT_FILE_MAX_BYTES } from './file';
import { parseCsvTransactionRows } from './csv';
import { parseRows } from './utils/csv';
import { detectSplitAmountPair } from './splitAmount';
import { CSV_DEFAULT_MAX_COLUMNS } from './columnBounds';
import { CSV_MAX_ROWS } from './csv';

/**
 * The shape measured on 2026-09-11: 3,000 columns by 100,000 rows in 206,000 bytes. Sparse, because
 * `parseRows` drops a row whose every cell is blank (`utils/csv.ts:44`), so the header cells and the
 * body rows each carry one character. The presence matrix a consumer builds from this is
 * `columns x rows` regardless of how few cells the file actually has, which is the amplification.
 */
function attackShape(columns: number, rows: number): string {
	return Array.from({ length: columns }, () => 'a').join(',') + '\n' + 'x\n'.repeat(rows);
}

function upload(name: string, content: string): File {
	return new File([content], name);
}

describe('the resource ceiling refuses at the READ, before any consumer', () => {
	/**
	 * This separates "the file is refused before the rows exist" from "the file is refused somewhere
	 * later, after something expensive has already read them". It reproduces the measured premise
	 * first, so a green here is a statement about the attack rather than about an easier file.
	 */
	it('reproduces the measured premise: inside every declared bound, and the caps fire anyway', () => {
		const csv = attackShape(3_000, 100_000);
		const bytes = Buffer.byteLength(csv);

		// PREMISE 1: inside the declared byte ceiling. This is what made the finding a finding.
		expect(bytes).toBeLessThanOrEqual(IMPORT_FILE_MAX_BYTES);
		expect(bytes).toBe(206_000);

		const rows = parseRows(csv);
		expect(rows[0].cells).toHaveLength(3_000);
		expect(rows.length - 1).toBe(100_000);

		// PREMISE 2: the product caps DO fire. The guard worked; the expensive work simply was not
		// inside what it inspects.
		const parsed = parseCsvTransactionRows(rows, {});
		expect(parsed.transactions).toHaveLength(0);
		expect(rows[0].cells.length).toBeGreaterThan(CSV_DEFAULT_MAX_COLUMNS);
		expect(rows.length - 1).toBeGreaterThan(CSV_MAX_ROWS);
	});

	it('refuses the measured attack file at the read', async () => {
		const csv = attackShape(3_000, 100_000);
		await expect(readImportFile(upload('attack.csv', csv))).rejects.toMatchObject({
			code: 'exceeds_resource_ceiling'
		});
		await expect(readImportFile(upload('attack.csv', csv))).rejects.toBeInstanceOf(ImportFileError);
	});

	it('refuses a file whose column count alone is past the ceiling', async () => {
		// Few rows, enormous width: the pair walk is quadratic in columns, so width is bounded on
		// its own rather than only through the cell product.
		const csv = attackShape(60_000, 4);
		expect(Buffer.byteLength(csv)).toBeLessThanOrEqual(IMPORT_FILE_MAX_BYTES);
		await expect(readImportFile(upload('wide.csv', csv))).rejects.toMatchObject({
			code: 'exceeds_resource_ceiling'
		});
	});
});

/**
 * The direction we are NOT going. A ceiling that refuses legitimate files has replaced a denial of
 * service with a denial of the product, and no real statement may reach it.
 */
describe('the ceiling does not refuse files the product allows', () => {
	it('reads an ordinary accounting export', async () => {
		const header = Array.from({ length: 40 }, (_, c) => `col${c}`).join(',');
		const body = Array.from({ length: 1_000 }, (_, r) =>
			Array.from({ length: 40 }, (_, c) => (c === 3 ? String(r) : 'zz')).join(',')
		).join('\n');
		const result = await readImportFile(upload('legit.csv', `${header}\n${body}`));
		expect(result.rows[0].cells).toHaveLength(40);
		expect(result.rows.length - 1).toBe(1_000);
	});

	it('reads a file sitting exactly ON the product limit, which the parser refuses later', async () => {
		// Over the product limit is the PARSER's business and gets the friendly catalogue sentence.
		// The ceiling must stay silent here, or the two rules have collapsed into one.
		const csv = attackShape(CSV_DEFAULT_MAX_COLUMNS, CSV_MAX_ROWS);
		const result = await readImportFile(upload('atcap.csv', csv));
		expect(result.rows[0].cells).toHaveLength(CSV_DEFAULT_MAX_COLUMNS);
	});

	it('reads a file OVER the product limit but under the ceiling, so the user meets the product sentence', async () => {
		const csv = attackShape(CSV_DEFAULT_MAX_COLUMNS + 1, CSV_MAX_ROWS + 1);
		const result = await readImportFile(upload('overcap.csv', csv));
		const parsed = parseCsvTransactionRows(result.rows, {});
		expect(parsed.transactions).toHaveLength(0);
		// And the detector is still safe to run on it once the narrow guard lets it through.
		expect(detectSplitAmountPair(result.rows[0].cells, result.rows)).toBeNull();
	});
});
