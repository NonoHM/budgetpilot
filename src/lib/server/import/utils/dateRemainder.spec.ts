import { describe, expect, it } from 'vitest';
import { normalizeDate } from './csv';
import { parseCsvTransactions } from '../csv';

/**
 * A date cell is a date and then, at most, a TIME. #366.
 *
 * ## The defect
 *
 * Both date branches in `normalizeDate` are anchored at `^` and not at `$`, so each takes a
 * PREFIX and discards whatever follows. That is deliberate and load-bearing — Revolut writes
 * `2026-08-01 10:00:00` in its date column and every bank that stamps a time relies on it — and
 * the same looseness silently swallows a second date. A `période` column reading
 * `01/01/2026 au 31/01/2026`, which is exactly the column a user designates by mistake on the
 * designation screen, imported EVERY row under 1 January. No refusal, no warning: every monthly
 * total wrong and nothing on screen saying so.
 *
 * ## Why the rule is about the REMAINDER rather than the pattern
 *
 * Anchoring at `$` fixes the defect and breaks Revolut, which would be a far larger regression
 * than the defect. So the date match stays a prefix, and a second, separate rule decides whether
 * what FOLLOWS it is admissible. Only a time is.
 *
 * ## Why an over-tight remainder rule fails SAFE, and a loose one does not
 *
 * A time format no bank in the fixtures writes — `10:00 CET`, say — is refused by this rule.
 * That is a refusal the user can read and act on. The defect it replaces is a wrong date the user
 * cannot see at all. The repository already decides this direction, in the sentence keeping
 * `posting date` out of the alias table: *a file that imports with a wrong date is worse than the
 * refusal it replaces*. Widen the pattern when a real statement demands it, never pre-emptively.
 *
 * ## This block is the calibration and it PASSES BEFORE THE FIX
 *
 * Every value below is a real bank's real date cell, taken from `realHeaders.fixture.ts`, or the
 * timestamp forms #366 names as must-not-break. They are asserted first, with a stated count, so
 * that a fix which over-tightens reddens here rather than being reported as a success elsewhere.
 */
describe('the date cells real statements actually carry', () => {
	it('reads every date form the real header fixtures contain', () => {
		expect.assertions(6);

		// Revolut, `realHeaders.fixture.ts:19` — a space-separated time, the case #366 names as
		// the reason the pattern cannot simply be anchored at `$`.
		expect(normalizeDate('2026-08-01 10:00:00')).toBe('2026-08-01');
		// N26, `:24` — bare ISO, quoted in the file, unquoted by the time it reaches here.
		expect(normalizeDate('2026-08-01')).toBe('2026-08-01');
		// Boursorama, `:29` — bare ISO in two columns.
		expect(normalizeDate('2026-08-01')).toBe('2026-08-01');
		// Banque Populaire, `:41` — day-first with slashes.
		expect(normalizeDate('01/08/2026')).toBe('2026-08-01');
		// Chase, `:57`. 8 January, NOT 1 August: this file reads `dd/mm` and the alias table
		// deliberately refuses `posting date` because of it. Pinned so the fix cannot quietly
		// change the ORDERING while changing the remainder rule.
		expect(normalizeDate('08/01/2026')).toBe('2026-01-08');
		expect(normalizeDate('08/01/2026')).not.toBe('2026-08-01');
	});

	it('reads the timestamp forms the fix must not break', () => {
		expect.assertions(5);

		expect(normalizeDate('01/01/2026 12:00')).toBe('2026-01-01');
		expect(normalizeDate('01/01/2026 12:00:00')).toBe('2026-01-01');
		expect(normalizeDate('2026-01-01T10:00:00Z')).toBe('2026-01-01');
		expect(normalizeDate('2026-01-01T10:00:00.500Z')).toBe('2026-01-01');
		expect(normalizeDate('2026-01-01 10:00:00+02:00')).toBe('2026-01-01');
	});

	it('still produces an impossible date rather than refusing it here', () => {
		expect.assertions(2);

		// `31/02/2026` must go on normalising to `2026-02-31` so the DOWNSTREAM `isValidIsoDate`
		// refuses it as `invalid-date`. Moving that refusal into this function would change which
		// code the user is shown, which is a contract change (#290) and not this issue.
		expect(normalizeDate('31/02/2026')).toBe('2026-02-31');
		expect(normalizeDate('13/13/2026')).toBe('2026-13-13');
	});
});
