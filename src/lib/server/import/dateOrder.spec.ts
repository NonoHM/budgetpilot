import { describe, expect, it } from 'vitest';
import { detectDateOrder, AMBIGUOUS_DATE_PATTERN } from './dateOrder';
import { normalizeDate } from './utils/csv';

/**
 * Reading the date order off the COLUMN, which is the only place the evidence exists.
 *
 * ## The rule, in one line
 *
 * A component greater than 12 cannot be a month, so it names its own position. Evidence for one
 * reading resolves the file; evidence for BOTH refuses it; evidence for neither is a question for
 * the user, never a guess.
 *
 * ## Why the fourth state exists
 *
 * « No evidence » and « nothing to decide » are different files and must not collapse. A file of
 * ISO dates has no ambiguous cell at all and has nothing to ask about; a file whose every cell
 * reads both ways has a real question with no answer in the bytes. Collapsing them would either
 * interrogate a user about an ISO file or guess at a genuinely ambiguous one, and the second is
 * #433.
 */
describe('reading a date order off a column', () => {
	/**
	 * Separates « a day above 12 proves day-first » from « the detector defaults to day-first ».
	 * The second cell is the proof; the first two are ambiguous and must not decide anything.
	 */
	it('resolves day-first from a component that cannot be a month', () => {
		expect.assertions(2);

		const verdict = detectDateOrder(['06/01/2026', '24/06/2026', '03/06/2026']);

		expect(verdict).toMatchObject({ kind: 'resolved', order: 'day-first' });
		// The cell that decided it, so a refusal or a screen can show the user their own evidence
		// rather than asserting a conclusion they cannot check.
		expect(verdict).toMatchObject({ evidence: '24/06/2026' });
	});

	/**
	 * Separates « a SECOND component above 12 proves month-first » from « the detector only ever
	 * finds day-first ». This is the Chase shape, and it is the case #433 imports silently wrong.
	 */
	it('resolves month-first from a second component that cannot be a month', () => {
		expect.assertions(2);

		const verdict = detectDateOrder(['06/01/2026', '06/24/2026', '06/03/2026']);

		expect(verdict).toMatchObject({ kind: 'resolved', order: 'month-first' });
		expect(verdict).toMatchObject({ evidence: '06/24/2026' });
	});

	/**
	 * THE ACCEPTANCE CRITERION, and the one a range heuristic gets wrong.
	 *
	 * A statement whose transactions all fall on the same low day of the month, six months
	 * running, is ambiguous in every cell: day-first it is the fifth of six consecutive months,
	 * month-first it is six consecutive days in May. Both are ordinary statements. PocketSmith's
	 * published approach picks whichever reading spans a plausible range, which here has to invent
	 * an answer; ours asks.
	 *
	 * Separates « the detector reports it has no evidence » from « the detector guessed and
	 * happened to agree with the default ».
	 */
	it('asks rather than guessing when every cell reads both ways', () => {
		expect.assertions(2);

		const verdict = detectDateOrder([
			'05/01/2026',
			'05/02/2026',
			'05/03/2026',
			'05/04/2026',
			'05/05/2026',
			'05/06/2026'
		]);

		expect(verdict.kind).toBe('ambiguous');
		// A cell to show the user, for the same reason `evidence` exists above: a question about
		// a file is answerable only beside a value from it.
		expect(verdict).toMatchObject({ sample: '05/01/2026' });
	});

	/**
	 * The constructed adversarial case. **No real French statement is known to carry a mixed date
	 * column**, and none in this repository's fixtures does: this file is written by hand to
	 * exercise a branch that has never fired on real material, and it is labelled as such rather
	 * than presented as a shape banks produce.
	 *
	 * It matters anyway, because the alternative is worse than a refusal. Three of the five rows
	 * below import under either reading, and the two that disagree import with a wrong date and
	 * nothing says so: data written wrong that looks right.
	 *
	 * Separates « both readings are proven and the file is refused » from « the first proof wins
	 * and the rest of the file is read against it ».
	 */
	it('refuses outright when the column proves both readings', () => {
		expect.assertions(3);

		const verdict = detectDateOrder(['24/06/2026', '06/24/2026', '01/02/2026']);

		expect(verdict.kind).toBe('mixed');
		// BOTH cells, in file order. Naming one would send the user to a row that is not the
		// problem: neither cell is wrong on its own, it is the pair that cannot both be right.
		expect(verdict).toMatchObject({ dayFirstEvidence: '24/06/2026' });
		expect(verdict).toMatchObject({ monthFirstEvidence: '06/24/2026' });
	});

	/**
	 * Separates « an ISO file has nothing to decide » from « an ISO file is ambiguous ». Reported
	 * apart so that nothing ever puts a date-order question in front of a user whose file cannot
	 * carry one.
	 */
	it('reports nothing to decide when no cell carries the ambiguous grammar', () => {
		expect.assertions(2);

		expect(detectDateOrder(['2026-06-01', '2026-06-24']).kind).toBe('nothing-to-decide');
		// An empty column is the same answer, not a crash and not an ambiguity.
		expect(detectDateOrder([]).kind).toBe('nothing-to-decide');
	});

	/**
	 * Separates « a cell no reading can place is ignored » from « it counts as evidence for
	 * both ». `31/13/2026` places neither component as a month, so it proves nothing about the
	 * file and must not turn an ordinary column into a mixed refusal. It is refused as an
	 * ordinary `invalid-date` by the row loop, which is where it belongs.
	 */
	it('takes no evidence from a cell that neither reading can place', () => {
		expect.assertions(1);

		expect(detectDateOrder(['31/13/2026', '06/01/2026']).kind).toBe('ambiguous');
	});

	/**
	 * The detector and the parser must agree on what an ambiguous date IS. Separates « one
	 * grammar, used twice » from « two grammars that happen to agree today ».
	 *
	 * A retyped pattern is the copied-predicate shape: the two would drift the first time either
	 * gained a separator, and the symptom would be a file the detector called unambiguous and the
	 * parser read as a date. So `normalizeDate` is driven BY this pattern rather than beside it,
	 * and this asserts the two answer alike on the separator set.
	 */
	it('shares one grammar with the parser rather than restating it', () => {
		expect.assertions(4);

		for (const cell of ['24/06/2026', '24.06.2026', '24-06-2026']) {
			expect(AMBIGUOUS_DATE_PATTERN.test(cell)).toBe(normalizeDate(cell) !== cell);
		}
		// A form neither accepts, so the agreement above is not two constants that are both true.
		expect(AMBIGUOUS_DATE_PATTERN.test('2026-06-24')).toBe(false);
	});
});
