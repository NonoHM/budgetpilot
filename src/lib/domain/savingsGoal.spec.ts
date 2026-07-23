import { describe, expect, it } from 'vitest';
import {
	computeSavingsGoalProgress,
	computeSuggestedMonthlyPaceCents,
	formatGoalDelta,
	isSavingsGoalLinkableAccountType,
	resolveSavingsGoalCurrentAmountCents
} from './savingsGoal';
import { NET_WORTH_ACCOUNT_TYPES } from './netWorth';

describe('isSavingsGoalLinkableAccountType', () => {
	it('excludes debt even though it is a linkable NetWorthAccount type in general', () => {
		expect(isSavingsGoalLinkableAccountType('debt')).toBe(false);
	});

	it('allows the accumulation-oriented transactional types', () => {
		expect(isSavingsGoalLinkableAccountType('checking')).toBe(true);
		expect(isSavingsGoalLinkableAccountType('savings')).toBe(true);
		expect(isSavingsGoalLinkableAccountType('investment')).toBe(true);
	});

	it('excludes the purely declarative types (real_estate, other)', () => {
		expect(isSavingsGoalLinkableAccountType('real_estate')).toBe(false);
		expect(isSavingsGoalLinkableAccountType('other')).toBe(false);
	});

	it('only checking/savings/investment are ever allowed, out of every known type', () => {
		const allowed = NET_WORTH_ACCOUNT_TYPES.filter((type) =>
			isSavingsGoalLinkableAccountType(type)
		);
		expect(allowed.sort()).toEqual(['checking', 'investment', 'savings']);
	});
});

describe('resolveSavingsGoalCurrentAmountCents', () => {
	it('uses the linked account balance when present', () => {
		expect(resolveSavingsGoalCurrentAmountCents({ currentAmountCents: 1_000 }, 5_000)).toBe(5_000);
	});

	it('falls back to the declarative currentAmountCents when unlinked', () => {
		expect(resolveSavingsGoalCurrentAmountCents({ currentAmountCents: 1_000 }, null)).toBe(1_000);
	});

	it('accepts a zero linked balance without falling back', () => {
		expect(resolveSavingsGoalCurrentAmountCents({ currentAmountCents: 1_000 }, 0)).toBe(0);
	});
});

describe('computeSavingsGoalProgress', () => {
	const createdAt = new Date('2026-01-01T00:00:00Z');

	it('reports "reached" once current meets or exceeds target, regardless of targetDate', () => {
		const result = computeSavingsGoalProgress({
			targetAmountCents: 5_000_00,
			currentAmountCents: 5_000_00,
			startingBalanceCents: 0,
			targetDate: null,
			createdAt,
			now: new Date('2026-03-01T00:00:00Z')
		});
		expect(result.status).toBe('reached');
		expect(result.progressPercent).toBe(100);
	});

	it('clamps progressPercent at 100 when current exceeds target', () => {
		const result = computeSavingsGoalProgress({
			targetAmountCents: 1_000_00,
			currentAmountCents: 2_000_00,
			startingBalanceCents: 0,
			targetDate: null,
			createdAt,
			now: createdAt
		});
		expect(result.progressPercent).toBe(100);
	});

	it('stays "in_progress" without a targetDate, no matter the pace', () => {
		const result = computeSavingsGoalProgress({
			targetAmountCents: 10_000_00,
			currentAmountCents: 100_00,
			startingBalanceCents: 100_00,
			targetDate: null,
			createdAt,
			now: new Date('2027-01-01T00:00:00Z')
		});
		expect(result.status).toBe('in_progress');
	});

	it('is "behind" when the real pace since creation is below the pace required to hit the deadline', () => {
		// Created with 0€, now (6 months later) at 100€, needs to reach 10 000€ in 1 more month.
		// Real pace ~16.67€/month, required pace 9 900€/month → behind.
		const result = computeSavingsGoalProgress({
			targetAmountCents: 10_000_00,
			currentAmountCents: 100_00,
			startingBalanceCents: 0,
			targetDate: new Date('2026-08-01T00:00:00Z'),
			createdAt,
			now: new Date('2026-07-01T00:00:00Z')
		});
		expect(result.status).toBe('behind');
	});

	it('is "in_progress" when the real pace meets or exceeds the pace required to hit the deadline', () => {
		// Created with 0€, now (~6 months later) at 3 000€ (real pace ~500€/month), needs only
		// 500€ more over the next ~6 months (required pace ~83€/month) → comfortably on pace.
		const result = computeSavingsGoalProgress({
			targetAmountCents: 3_500_00,
			currentAmountCents: 3_000_00,
			startingBalanceCents: 0,
			targetDate: new Date('2027-01-01T00:00:00Z'),
			createdAt,
			now: new Date('2026-07-01T00:00:00Z')
		});
		expect(result.status).toBe('in_progress');
	});

	it('is "behind" once the deadline has passed and the goal is not reached', () => {
		const result = computeSavingsGoalProgress({
			targetAmountCents: 1_000_00,
			currentAmountCents: 500_00,
			startingBalanceCents: 0,
			targetDate: new Date('2026-01-15T00:00:00Z'),
			createdAt,
			now: new Date('2026-02-01T00:00:00Z')
		});
		expect(result.status).toBe('behind');
	});

	it('does not divide by zero when now equals createdAt with a future targetDate (grace period keeps it "in_progress")', () => {
		const result = computeSavingsGoalProgress({
			targetAmountCents: 1_000_00,
			currentAmountCents: 0,
			startingBalanceCents: 0,
			targetDate: new Date('2026-06-01T00:00:00Z'),
			createdAt,
			now: createdAt
		});
		expect(result.status).toBe('in_progress');
		expect(Number.isFinite(result.progressPercent)).toBe(true);
	});

	describe('grace period (goal younger than one full month)', () => {
		it('never reports "behind" via the pace comparison for a goal created seconds ago, even with an aggressive deadline', () => {
			// Same setup as the "is behind" pace-comparison test above (0€ now, needs 10 000€ in
			// 1 month), but only 2 weeks after creation instead of 6 months — without the grace
			// period this would read "behind" immediately, which is the exact noise the grace
			// period exists to suppress.
			const result = computeSavingsGoalProgress({
				targetAmountCents: 10_000_00,
				currentAmountCents: 0,
				startingBalanceCents: 0,
				targetDate: new Date('2026-02-01T00:00:00Z'),
				createdAt,
				now: new Date('2026-01-15T00:00:00Z')
			});
			expect(result.status).toBe('in_progress');
		});

		it('never reports "behind" via the past-deadline branch for a goal created seconds ago', () => {
			// targetDate already passed relative to `now`, but createdAt is only 2 weeks before
			// `now` — still within the grace period.
			const result = computeSavingsGoalProgress({
				targetAmountCents: 1_000_00,
				currentAmountCents: 0,
				startingBalanceCents: 0,
				targetDate: new Date('2026-01-10T00:00:00Z'),
				createdAt,
				now: new Date('2026-01-15T00:00:00Z')
			});
			expect(result.status).toBe('in_progress');
		});

		it('applies the normal pace comparison once a full month has elapsed since creation', () => {
			const result = computeSavingsGoalProgress({
				targetAmountCents: 10_000_00,
				currentAmountCents: 0,
				startingBalanceCents: 0,
				targetDate: new Date('2026-02-15T00:00:00Z'),
				createdAt,
				now: new Date('2026-02-05T00:00:00Z') // > 1 month after createdAt
			});
			expect(result.status).toBe('behind');
		});

		it('exits the grace period at exactly 1 full month elapsed (>= threshold, not just >)', () => {
			// MS_PER_MONTH = (365.25 / 12) days = 2_629_800_000 ms exactly. At now = createdAt +
			// exactly that many ms, monthsElapsed === GRACE_PERIOD_MONTHS (1): the grace period
			// must already be over (`monthsElapsed < GRACE_PERIOD_MONTHS` is the guard, so equal
			// does not count as "within"), so the past-deadline branch reports "behind".
			const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;
			const now = new Date(createdAt.getTime() + MS_PER_MONTH);
			const result = computeSavingsGoalProgress({
				targetAmountCents: 1_000_00,
				currentAmountCents: 0,
				startingBalanceCents: 0,
				targetDate: createdAt, // already past relative to `now` -> past-deadline branch
				createdAt,
				now
			});
			expect(result.status).toBe('behind');
		});

		it('stays within the grace period 1ms before the 1-month threshold', () => {
			const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;
			const now = new Date(createdAt.getTime() + MS_PER_MONTH - 1);
			const result = computeSavingsGoalProgress({
				targetAmountCents: 1_000_00,
				currentAmountCents: 0,
				startingBalanceCents: 0,
				targetDate: createdAt,
				createdAt,
				now
			});
			expect(result.status).toBe('in_progress');
		});

		it('a goal created 3 weeks ago with a deadline 1 week away stays "in_progress" (informational tradeoff, not a bug)', () => {
			// Genuinely urgent (1 week left, nothing saved), but still under 1 month old: the
			// grace period intentionally keeps this neutral rather than alarming, per design.
			const result = computeSavingsGoalProgress({
				targetAmountCents: 1_000_00,
				currentAmountCents: 0,
				startingBalanceCents: 0,
				targetDate: new Date('2026-01-22T00:00:00Z'), // 1 week after `now`
				createdAt,
				now: new Date('2026-01-15T00:00:00Z') // 2 weeks after createdAt (< 1 month)
			});
			expect(result.status).toBe('in_progress');
		});

		it('keeps progressPercent correct while status is forced to in_progress during the grace period', () => {
			const result = computeSavingsGoalProgress({
				targetAmountCents: 1_000_00,
				currentAmountCents: 400_00,
				startingBalanceCents: 0,
				targetDate: new Date('2026-01-20T00:00:00Z'),
				createdAt,
				now: new Date('2026-01-10T00:00:00Z')
			});
			expect(result.status).toBe('in_progress');
			expect(result.progressPercent).toBe(40);
		});

		it('still reports "reached" for a goal created seconds ago that already met its target', () => {
			const result = computeSavingsGoalProgress({
				targetAmountCents: 1_000_00,
				currentAmountCents: 1_000_00,
				startingBalanceCents: 0,
				targetDate: new Date('2026-02-01T00:00:00Z'),
				createdAt,
				now: createdAt
			});
			expect(result.status).toBe('reached');
		});
	});

	it('floors progressPercent at 0 for a negative currentAmountCents', () => {
		const result = computeSavingsGoalProgress({
			targetAmountCents: 1_000_00,
			currentAmountCents: -500_00,
			startingBalanceCents: 0,
			targetDate: null,
			createdAt,
			now: createdAt
		});
		expect(result.progressPercent).toBe(0);
	});

	it('returns 0% progress for a zero target instead of dividing by zero', () => {
		const result = computeSavingsGoalProgress({
			targetAmountCents: 0,
			currentAmountCents: 0,
			startingBalanceCents: 0,
			targetDate: null,
			createdAt,
			now: createdAt
		});
		expect(result.progressPercent).toBe(0);
	});
});

describe('computeSuggestedMonthlyPaceCents', () => {
	it('returns null when there is no targetDate', () => {
		expect(computeSuggestedMonthlyPaceCents(1_000_00, 0, null)).toBeNull();
	});

	it('returns null once the deadline has already passed', () => {
		const now = new Date('2026-06-01T00:00:00Z');
		expect(
			computeSuggestedMonthlyPaceCents(1_000_00, 0, new Date('2026-01-01T00:00:00Z'), now)
		).toBeNull();
	});

	it('computes (target - current) / months remaining', () => {
		const now = new Date('2026-01-01T00:00:00Z');
		const targetDate = new Date('2026-02-01T00:00:00Z');
		const pace = computeSuggestedMonthlyPaceCents(1_000_00, 0, targetDate, now);
		expect(pace).not.toBeNull();
		expect(pace!).toBeGreaterThan(900_00);
		expect(pace!).toBeLessThan(1_100_00);
	});

	it('never returns a negative pace even if current already exceeds target', () => {
		const now = new Date('2026-01-01T00:00:00Z');
		const targetDate = new Date('2026-02-01T00:00:00Z');
		expect(computeSuggestedMonthlyPaceCents(1_000_00, 2_000_00, targetDate, now)).toBe(0);
	});
});

describe('formatGoalDelta', () => {
	it('uses a positive tone when reached', () => {
		expect(formatGoalDelta('reached', 0).tone).toBe('positive');
	});

	it('uses a warning tone when behind pace', () => {
		expect(formatGoalDelta('behind', 500_00).tone).toBe('warning');
	});

	it('uses a neutral tone when in progress', () => {
		expect(formatGoalDelta('in_progress', 500_00).tone).toBe('neutral');
	});
});
