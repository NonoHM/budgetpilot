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
	 * SUPERSEDED, #433'S REMAINDER CLOSED ON THIS PATH. This used to pin the silent five-month
	 * displacement: three rows in, three rows out, nothing refused, dates wrong. `generic` is a
	 * REGISTERED profile, so `dateOrderSeam.spec.ts`'s "a registered profile asks instead of
	 * silently defaulting" now covers exactly this shape, and the file is refused rather than
	 * silently misread. `AUTHOR_DATES` stays for the sibling test above, which still needs it to
	 * prove the override moved anything.
	 */
	it('asks instead of silently displacing every row by five months', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(MONTH_FIRST_FILE);

		expect(result.transactions).toEqual([]);
		expect(result.summary.fileLevelRefusals).toBe(1);
		expect(result.invalidRows[0].fact.code).toBe('ambiguous-date-order');
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
	 * another name », at the level of `normalizeDate` itself.
	 *
	 * `13` cannot be a MONTH, so the two readings disagree about whether the cell is readable at
	 * all: day-first gives a date, month-first gives `2026-13-01`, which `isValidIsoDate` refuses
	 * and a caller turns into `invalid-date`. This function's contract is that an impossible date
	 * is still NORMALISED rather than rejected here (its own docstring gives `31/02/2026` becoming
	 * `2026-02-31`), so the swap is what is asserted and the refusal belongs to the caller.
	 *
	 * ## THIS USED TO BE ASSERTED THROUGH THE PARSER, AND #613 TOOK THAT AWAY
	 *
	 * It read a one-cell file through `parseCsvTransactions` with `dateOrder: 'month-first'` and
	 * required the row to be refused. That is no longer what the parser does, and the change is
	 * deliberate rather than a regression: a column containing `13/01/2026` PROVES day-first, and
	 * the order is now derived from the column rather than taken from the option. The test below
	 * asserts the new behaviour at that level, and this one keeps the unit-level claim that the
	 * option still swaps when it is the thing deciding.
	 */
	it('swaps the two components, so an unplaceable month normalises to one', () => {
		expect.assertions(2);

		expect(normalizeDate('13/01/2026', 'month-first')).toBe('2026-13-01');
		expect(normalizeDate('13/01/2026', 'day-first')).toBe('2026-01-13');
	});

	/**
	 * Separates « the file's own proof decides the reading » from « whatever was asked for
	 * decides it ». THE CASE THAT MADE #613 DEVIATE from the ladder the issue wrote down.
	 *
	 * `13/01/2026` cannot be month-first, so an override saying month-first is asking for a
	 * reading this file disproves. Honouring it refuses a row that is perfectly readable and
	 * leaves the user with `invalid-date` on a date their spreadsheet opens without complaint.
	 * Reading the proof instead imports the thirteenth of January, which is what the cell says.
	 *
	 * The override is not thereby useless: it is the only thing that can settle a column the file
	 * leaves genuinely AMBIGUOUS, which is the two tests at the top of this file.
	 */
	it('reads a column that proves day-first day-first, even when asked for month-first', () => {
		expect.assertions(3);

		const file = ['Date,Description,Amount', '13/01/2026,COFFEE,-4.50'].join('\n');
		const result = parseCsvTransactions(file, { dateOrder: 'month-first' });

		expect(result.summary.validRows).toBe(1);
		expect(result.invalidRows).toEqual([]);
		expect(result.transactions[0].date).toBe('2026-01-13');
	});
});
