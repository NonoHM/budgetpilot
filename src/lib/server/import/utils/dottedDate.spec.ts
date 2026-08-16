import { describe, expect, it } from 'vitest';
import { normalizeDate } from './csv';
import { parseCsvTransactions } from '../csv';

/**
 * `01.06.2026` read as the first of June, and what that widening must NOT do.
 *
 * ## Why the form is accepted rather than merely explained
 *
 * #362 put the accepted forms into the refusal and deliberately left this open: « Whether a
 * fourth date form is worth accepting is a separate question and is not answered here. » The
 * question is answered here, and the answer is yes, because the alternative was measured. A
 * blind session met a statement written this way, read a message it could act on, and could
 * still only act on it by opening the file in a text editor and replacing twenty-five dots.
 * Designating columns cannot help: naming which column holds the date does not change how the
 * value in it parses.
 *
 * ## Why it does not carry the ordering risk `/` carries
 *
 * The repository already refuses to add `posting date` to the date aliases, because Chase writes
 * `08/01/2026` for 1 August and `normalizeDate` reads `dd/mm`, so that file would import six
 * months wrong — and a file that imports with a wrong date is worse than the refusal it
 * replaces. **The dot does not reopen that.** `dd.mm.yyyy` is the German, Swiss and Austrian
 * convention and those are day-first without exception; the month-first convention is written
 * with slashes, never with dots. So adding `.` to the separator class is strictly safer than the
 * `/` and `-` already there, and the tests below pin the reading rather than trusting that
 * sentence.
 */
describe('a date written with dots', () => {
	it('reads day first, like the two separators already accepted', () => {
		expect.assertions(3);

		expect(normalizeDate('01.06.2026')).toBe('2026-06-01');
		// The three separators agree, which is the property that makes this a widening of one
		// rule rather than a fourth rule with its own behaviour.
		expect(normalizeDate('01.06.2026')).toBe(normalizeDate('01/06/2026'));
		expect(normalizeDate('01.06.2026')).toBe(normalizeDate('01-06-2026'));
	});

	it('is never read month first', () => {
		expect.assertions(2);

		// 8 January, not 1 August. The value that would expose a month-first reading, named
		// rather than left to a fixture where the two readings agree.
		expect(normalizeDate('08.01.2026')).toBe('2026-01-08');
		expect(normalizeDate('08.01.2026')).not.toBe('2026-08-01');
	});

	it('refuses a dotted value that is not a date, rather than passing it through', () => {
		expect.assertions(3);

		// The widening is to the SEPARATOR, not to the shape. Two digits, two digits, four.
		expect(normalizeDate('1.6.2026')).toBe('1.6.2026');
		expect(normalizeDate('01.06.26')).toBe('01.06.26');
		// A real refusal, through the parser, so the guard is asserted where the user meets it.
		const result = parseCsvTransactions('date,label,amount\n01.06.26,Mercerie Lafayette,-45.20');
		expect(result.invalidRows[0].fact).toEqual({
			code: 'invalid-date',
			column: 'date',
			value: '01.06.26'
		});
	});

	it('still refuses an impossible day, so a separator is not a licence', () => {
		expect.assertions(1);

		const result = parseCsvTransactions('date,label,amount\n31.02.2026,Mercerie Lafayette,-45.20');

		expect(result.transactions).toHaveLength(0);
	});

	it('imports the statement end to end, which is the whole point', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(
			'date,label,amount\n01.06.2026,Mercerie Lafayette,-45.20\n03.06.2026,Salaire,2450.00'
		);

		expect(result.invalidRows).toHaveLength(0);
		expect(result.transactions).toHaveLength(2);
		expect(result.transactions[0].date).toBe('2026-06-01');
		expect(result.summary.period).toEqual({ from: '2026-06-01', to: '2026-06-03' });
	});
});
