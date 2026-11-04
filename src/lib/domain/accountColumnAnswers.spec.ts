import { describe, expect, it } from 'vitest';
import { readAccountColumnAnswers, writeAccountColumnAnswer } from './accountColumnAnswer';

/** #1255: each posted answer names the column it answers, `<answer>:<column index>`. */
describe('readAccountColumnAnswers', () => {
	it('reads each answer with the column it names', () => {
		expect(readAccountColumnAnswers(['not-account:1', 'is-account:3'], 10)).toStrictEqual([
			{ column: 1, answer: 'not-account' },
			{ column: 3, answer: 'is-account' }
		]);
	});

	it('round-trips what the page writes', () => {
		const posted = writeAccountColumnAnswer({ column: 7, answer: 'not-account' });
		expect(readAccountColumnAnswers([posted], 10)).toStrictEqual([
			{ column: 7, answer: 'not-account' }
		]);
	});

	// SEPARATES: « an answer with no column is no answer » FROM « a file-wide answer », the defect.
	// One value per assertion: two column-less answers together disagree and would be dropped by the
	// disagreement rule, which hid a reader that accepted them (break B7).
	it.each(['not-account', 'is-account'])('drops %s when it names no column', (bare) => {
		expect(readAccountColumnAnswers([bare], 10)).toStrictEqual([]);
	});

	it('drops a column outside the file width, a non-canonical index, and anything not a string', () => {
		expect(
			readAccountColumnAnswers(
				[
					'not-account:10',
					'not-account:-1',
					'not-account:01',
					'not-account:1.0',
					'yes:1',
					new File([], 'x'),
					null
				],
				10
			)
		).toStrictEqual([]);
	});

	it('keeps the last column inside the width', () => {
		expect(readAccountColumnAnswers(['not-account:9'], 10)).toStrictEqual([
			{ column: 9, answer: 'not-account' }
		]);
	});

	// SEPARATES: « two answers that disagree about one column » (asked again) FROM « either wins ».
	it('drops both answers when two disagree about one column, and keeps one of two that agree', () => {
		expect(
			readAccountColumnAnswers(
				['not-account:2', 'is-account:2', 'not-account:4', 'not-account:4'],
				10
			)
		).toStrictEqual([{ column: 4, answer: 'not-account' }]);
	});
});
