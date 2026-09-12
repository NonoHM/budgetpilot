import { describe, expect, it } from 'vitest';
import { normalizeDate } from './csv';
import { parseCsvTransactions } from '../csv';

/**
 * `06/01/2026` read as the first of June when the file says so, and as the sixth of January
 * when it does not. #433.
 *
 * ## Why the reading is an INPUT rather than something this function decides
 *
 * `normalizeDate` sees one cell. A cell reading `06/01/2026` is two valid dates and carries
 * nothing that separates them: the evidence is a property of the COLUMN, and a function handed
 * one value structurally cannot hold it. So the order is resolved once, before the row loop,
 * and passed in, exactly as `hasHeaderRow` is, and for the same reason its docstring already
 * gives about a header row of plausible values.
 *
 * The default stays day-first. Every file this parser has ever read correctly is day-first, and
 * a default that changed would silently move dates in the other direction for every existing
 * user, which is the defect #433 is about arriving through its own fix.
 */
const AUTHOR_DATES = ['2026-06-01', '2026-07-02', '2026-08-03'];

/** A US-shaped statement: month first, and every row ambiguous by construction (day and month
 *  both 12 or under), so nothing in any single cell can separate the two readings. */
const MONTH_FIRST_FILE = [
	'Date,Description,Amount',
	'06/01/2026,COFFEE,-4.50',
	'07/02/2026,GROCERY,-32.10',
	'08/03/2026,SALARY,2400.00'
].join('\n');

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

describe('a month-first date column', () => {
	/**
	 * Separates « the parser was told the order and honoured it » from « the parser was told and
	 * ignored it ». It cannot pass by accident: the value it demands is the one the day-first
	 * reading never produces.
	 */
	it('parses to the dates the file s author wrote, when the order is given', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(MONTH_FIRST_FILE, { dateOrder: 'month-first' });

		expect(result.transactions.map((transaction) => transaction.date)).toEqual(AUTHOR_DATES);
		// Three rows in, three rows out. A version that refused the file instead of reading it
		// would satisfy the assertion above on an empty array.
		expect(result.summary.validRows).toBe(3);
	});

	/**
	 * Separates « the default is unchanged » from « the fix moved every existing user's dates ».
	 * This is the assertion that has to keep passing, and it is written as the MEASURED
	 * displacement rather than as a list of wrong dates, because the size is what makes #433 a
	 * defect rather than an off-by-one: a figure a reader cannot mistake for a rounding.
	 */
	it('is read day first when the order is not given, displacing every row by five months', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(MONTH_FIRST_FILE);
		const stored = result.transactions.map((transaction) => transaction.date);

		// Silent: three rows in, three rows out, nothing refused. That is the whole defect.
		expect(result.summary.validRows).toBe(3);
		expect(result.summary.invalidRows).toBe(0);
		// The absolute figure, measured here rather than quoted: each row lands this many days
		// BEFORE the date its author wrote.
		expect(stored.map((date, index) => daysBetween(date, AUTHOR_DATES[index]))).toEqual([
			146, 145, 148
		]);
	});

	/**
	 * The direction we are not going. Separates « the option reaches only the ambiguous grammar »
	 * from « the option reaches every date in the file ». An ISO column has no ordering question
	 * to answer, and a `month-first` answer arriving at one must change nothing: a file mixing an
	 * ISO date column with a US one would otherwise have its ISO dates rewritten by an answer
	 * that was never about them.
	 */
	it('leaves an ISO column untouched whatever the order says', () => {
		expect.assertions(3);

		expect(normalizeDate('2026-06-01', 'month-first')).toBe('2026-06-01');
		expect(normalizeDate('2026-06-01', 'day-first')).toBe('2026-06-01');
		// The prefix form Revolut writes, which is the one that would break if the option were
		// applied before the ISO branch rather than inside the slash-separated one.
		expect(normalizeDate('2026-08-01 10:00:00', 'month-first')).toBe('2026-08-01');
	});

	/**
	 * Separates « month-first swaps the two components » from « month-first is day-first under
	 * another name ». `13` cannot be a MONTH, so the two readings disagree about whether the row
	 * is readable at all, and the month-first one must refuse rather than land somewhere.
	 *
	 * Asserted through the parser rather than on `normalizeDate`'s return value, deliberately.
	 * This function's contract is that an impossible date is still NORMALISED (its own
	 * docstring gives `31/02/2026` becoming `2026-02-31`) and refused by the caller's
	 * `isValidIsoDate`. So
	 * the return value here is `2026-13-01`, which says nothing a reader can use; whether the row
	 * imports is the thing that matters and the thing a future change could break.
	 */
	it('refuses a row whose month no reading can place, rather than landing it somewhere', () => {
		expect.assertions(4);

		const file = ['Date,Description,Amount', '13/01/2026,COFFEE,-4.50'].join('\n');

		const monthFirst = parseCsvTransactions(file, { dateOrder: 'month-first' });
		expect(monthFirst.transactions).toHaveLength(0);
		expect(monthFirst.invalidRows[0].fact).toMatchObject({
			code: 'invalid-date',
			// The user's OWN cell, not the normalised form, so the sentence points at something
			// they can find in their file.
			value: '13/01/2026'
		});

		// The same cell day-first is the thirteenth of January and reads fine, which is what makes
		// the refusal above a property of the ORDER rather than of the cell.
		const dayFirst = parseCsvTransactions(file, { dateOrder: 'day-first' });
		expect(dayFirst.transactions).toHaveLength(1);
		expect(dayFirst.transactions[0].date).toBe('2026-01-13');
	});
});
