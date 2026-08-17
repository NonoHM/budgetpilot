import { describe, it, expect } from 'vitest';
import { periodsOverlap } from './periodOverlap';

/**
 * The boundary is where the two candidate operators disagree, so it is the only interesting input.
 *
 * `<=` against `<` differ on exactly one value: the day where one period ends and the other begins.
 * A fixture picked for legibility — June against July — passes under both, so it would be a test of
 * nothing. Every case below names the day the two operators disagree about, or the reason it is not
 * a boundary at all.
 */

const JUNE = { from: '2026-06-01', to: '2026-06-30' };

describe('periodsOverlap', () => {
	it('is true for the same month read two ways, which is every legitimate correction', () => {
		// The case the guard must never fire on. Re-designating the DATE column shifts a batch's
		// period by days, never by months, so the corrected read of one statement always lands inside
		// the old one's span.
		expect(periodsOverlap(JUNE, { from: '2026-06-03', to: '2026-06-28' })).toBe(true);
	});

	it('is true when one period ends on the day the other begins', () => {
		// THE BOUNDARY, and the whole reason both bounds are documented as inclusive: this is one
		// shared day, so `<` would report no overlap and the guard would withhold on a statement that
		// really does touch the old one.
		expect(periodsOverlap({ from: '2026-05-01', to: '2026-06-01' }, JUNE)).toBe(true);
		expect(periodsOverlap(JUNE, { from: '2026-06-30', to: '2026-07-31' })).toBe(true);
	});

	it('is false one day past the boundary, in both directions', () => {
		// The value immediately outside, which is what proves the test above measured the boundary
		// rather than an always-true comparison.
		expect(periodsOverlap({ from: '2026-05-01', to: '2026-05-31' }, JUNE)).toBe(false);
		expect(periodsOverlap(JUNE, { from: '2026-07-01', to: '2026-07-31' })).toBe(false);
	});

	it('is false for the statement of another month, which is the defect it exists for', () => {
		// June's file handed back as a correction for a July import. Walked in a browser before this
		// existed: July's transactions were deleted and replaced with a second copy of June.
		expect(periodsOverlap(JUNE, { from: '2026-07-01', to: '2026-07-24' })).toBe(false);
	});

	it('is true whenever either side is undated, in every combination', () => {
		// Not a defaulted direction. An undated batch holds no dated transaction, so the delete
		// destroys nothing and withholding would cost the old journey to protect nothing. Asserted
		// per bound rather than once, because a guard reading only `from` passes a single-null test.
		expect(periodsOverlap(JUNE, { from: null, to: null })).toBe(true);
		expect(periodsOverlap(JUNE, { from: '2026-07-01', to: null })).toBe(true);
		expect(periodsOverlap(JUNE, { from: null, to: '2026-07-31' })).toBe(true);
		expect(periodsOverlap({ from: null, to: null }, JUNE)).toBe(true);
	});

	it('reads a full instant and a date-only string as the same day', () => {
		// The two sides genuinely arrive in different shapes: Prisma serialises a batch's period with
		// a time part and a parsed run's is date-only. A comparison over the raw strings would put
		// `2026-06-30T00:00:00.000Z` after `2026-06-30` and lose the boundary above.
		expect(
			periodsOverlap(
				{ from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z' },
				{ from: '2026-06-30', to: '2026-07-31' }
			)
		).toBe(true);
		expect(
			periodsOverlap(
				{ from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z' },
				{ from: '2026-07-01', to: '2026-07-31' }
			)
		).toBe(false);
	});

	it('is symmetric, which the withhold site relies on without saying so', () => {
		// The call site passes the batch first and the run second. Nothing enforces that order, and a
		// one-sided implementation would be correct at exactly one call site.
		const other = { from: '2026-06-15', to: '2026-07-15' };
		expect(periodsOverlap(JUNE, other)).toBe(periodsOverlap(other, JUNE));
		const away = { from: '2026-09-01', to: '2026-09-30' };
		expect(periodsOverlap(JUNE, away)).toBe(periodsOverlap(away, JUNE));
	});
});
