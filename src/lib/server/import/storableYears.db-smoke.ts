import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { parseCsvTransactions } from './csv';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from './persist';
import type { CsvImportResult } from './types';

/**
 * #758, on a real engine: what a file's boundary years become once STORED and READ BACK.
 *
 * ## The measurement this reproduces (2026-09-27, through `persistImportedTransactions`)
 *
 * | date             | SQLite   | PostgreSQL      | MariaDB                        |
 * | 0000-01-16       | faithful | throws `22008`  | column holds it, reads 2000-01-16 |
 * | 0000-02-29       | faithful | throws `22008`  | throws `1292`                  |
 * | 0001 to 0099     | faithful | faithful        | reads back in 1950 to 2049     |
 * | 0100 to 9999     | faithful | faithful        | faithful                       |
 *
 * So before the fix the same file stored a wrong date that looks right on MariaDB, failed the
 * whole import on PostgreSQL (at `createImportBatch`, whose period starts on the year 0000 row),
 * and stored the year 0000 on SQLite. Every red of this file therefore names its engine's figure:
 * MariaDB's `storedDates` shows `2000-01-16`, `2001-01-01`, `1950-06-15` and `1999-12-31`;
 * PostgreSQL's `writeError` names `22008`.
 *
 * ## Why the boundary is 1000, when the engines measured faithful from 0100
 *
 * 0100 to 0999 read back faithfully here, and MariaDB documents its `DATETIME` range as starting at
 * `1000-01-01`: below it the behaviour is « may work », which is exactly what the 0001 to 0099
 * misreading is. A range resting on undocumented behaviour of one engine is a guess. The ruling
 * and its evidence are on `STORABLE_YEARS` in `domain/transaction.ts`.
 *
 * The leap-day edge rides along: `2000-02-29` is stored, `1900-02-29` is not a date in the
 * Gregorian calendar and is refused as `invalid-date` before the range is even asked, and
 * `0000-02-29` (a leap day to JavaScript, refused by MariaDB) is out of range. It is the LAST row
 * on purpose: on the unfixed tree MariaDB throws on it, and every row before it is already written,
 * so the red of `storedDates` still shows the misread years.
 */

const OUT_OF_RANGE = ['0000-01-16', '0001-01-01', '0050-06-15', '0099-12-31', '0999-12-31'];
const IN_RANGE = [
	'1000-01-01',
	'1899-12-31',
	'1900-01-01',
	'1969-12-31',
	'1970-01-01',
	'2000-02-29',
	'2100-02-28',
	'9999-12-31'
];
const NOT_A_DATE = '1900-02-29';
const LEAP_DAY_OF_YEAR_ZERO = '0000-02-29';

const FILE_DATES = [...OUT_OF_RANGE, ...IN_RANGE, NOT_A_DATE, LEAP_DAY_OF_YEAR_ZERO];
const FILE = [
	'Date,Description,Amount',
	...FILE_DATES.map((date, index) => `${date},ROW ${index},-${index + 1}.00`)
].join('\n');

let parsed: CsvImportResult;
let writeError: unknown = null;
let storedDates: string[] = [];
let storedPeriod: { from: string | null; to: string | null } | null = null;

beforeAll(async () => {
	const stamp = `${Date.now()}-${Math.floor(performance.now())}`;
	const user = await prisma.user.create({
		data: { email: `years758-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const { accountId } = await resolveImportBucketAccount({
		userId: user.id,
		name: `years758-${stamp}`,
		source: 'csv'
	});

	parsed = parseCsvTransactions(FILE);

	let importBatchId: string | null = null;
	try {
		importBatchId = await createImportBatch({
			userId: user.id,
			accountId,
			source: 'csv',
			fileName: 'years.csv',
			profile: parsed.summary.profile,
			rowCount: parsed.summary.totalRows,
			invalidRows: parsed.summary.invalidRows,
			period: parsed.summary.period
		});
		await persistImportedTransactions({
			userId: user.id,
			accountId,
			importBatchId,
			source: 'csv',
			transactions: parsed.transactions
		});
	} catch (caught) {
		// Kept, never rethrown: the rows written before a throw are the figure the MariaDB red names.
		writeError = caught;
	}

	const rows = await prisma.transaction.findMany({
		where: { userId: user.id, accountId },
		select: { date: true }
	});
	storedDates = rows.map((row) => row.date.toISOString().slice(0, 10)).sort();

	if (importBatchId) {
		const batch = await prisma.importBatch.findUniqueOrThrow({
			where: { id: importBatchId },
			select: { periodStart: true, periodEnd: true }
		});
		storedPeriod = {
			from: batch.periodStart?.toISOString().slice(0, 10) ?? null,
			to: batch.periodEnd?.toISOString().slice(0, 10) ?? null
		};
	}
});

describe(`#758 on ${process.env.DATABASE_PROVIDER ?? 'the configured engine'}: boundary years`, () => {
	/**
	 * Separates « nothing reaches the engine that the engine refuses » from PostgreSQL's `22008`
	 * and MariaDB's `1292`, which on the unfixed tree end the import part way through.
	 */
	it('writes the file without an engine error', () => {
		expect.assertions(1);
		expect(writeError).toBeNull();
	});

	/**
	 * THE FIGURE. Every storable day reads back as the file wrote it, and nothing else was stored.
	 * Separates « stored exactly » from MariaDB's misread years (`2000-01-16` for `0000-01-16`) and
	 * from SQLite storing a year 0000 row at all.
	 */
	it('stores exactly the storable days, each read back as written', () => {
		expect.assertions(1);
		expect(storedDates).toEqual(IN_RANGE);
	});

	/**
	 * Separates « refused on its row with the range reason » from « refused as unreadable » and from
	 * « imported ». Lines are the file's: the header is line 1.
	 */
	it('refuses every out-of-range row with date-out-of-range, and the non-date as invalid-date', () => {
		expect.assertions(1);
		const line = (date: string) => FILE_DATES.indexOf(date) + 2;
		expect(
			parsed.invalidRows.map((refusal) => ({
				line: refusal.scope.kind === 'row' ? refusal.scope.line : null,
				code: refusal.fact.code
			}))
		).toEqual(
			[...OUT_OF_RANGE, NOT_A_DATE, LEAP_DAY_OF_YEAR_ZERO]
				.map((date) => ({
					line: line(date),
					code: date === NOT_A_DATE ? 'invalid-date' : 'date-out-of-range'
				}))
				.sort((a, b) => a.line - b.line)
		);
	});

	/**
	 * `ImportBatch.periodStart` is the other `DateTime` a file's dates reach, and the one PostgreSQL
	 * threw on first. Separates « the period spans the storable rows only » from « a refused row's
	 * year widened it ».
	 */
	it('stores the batch period as the first and the last storable day', () => {
		expect.assertions(1);
		expect(storedPeriod).toEqual({ from: '1000-01-01', to: '9999-12-31' });
	});
});
