import { describe, expect, it } from 'vitest';
import {
	buildNetWorthAssetBreakdown,
	buildNetWorthTimeline,
	computeNegativeBalanceTotal,
	computeNetWorthTotal,
	negativeBalanceDisplayCents,
	isNetWorthAccountType,
	parseNetWorthBalanceCents,
	signedNetWorthCents,
	suggestNetWorthAccountType
} from './netWorth';

/** Named rather than an inline `new Map()`: every case in this file is about accounts that are
 *  still open, and the argument is what says so. */
const NO_CLOSURES = new Map<string, Date>();

describe('isNetWorthAccountType', () => {
	it('accepts the 6 known types', () => {
		expect(isNetWorthAccountType('checking')).toBe(true);
		expect(isNetWorthAccountType('savings')).toBe(true);
		expect(isNetWorthAccountType('investment')).toBe(true);
		expect(isNetWorthAccountType('real_estate')).toBe(true);
		expect(isNetWorthAccountType('other')).toBe(true);
		expect(isNetWorthAccountType('debt')).toBe(true);
	});

	it('rejects an unknown value', () => {
		expect(isNetWorthAccountType('crypto')).toBe(false);
		expect(isNetWorthAccountType('')).toBe(false);
	});
});

describe('parseNetWorthBalanceCents', () => {
	it('parses a decimal amount with a comma', () => {
		expect(parseNetWorthBalanceCents('1 234,56')).toBe(123_456);
	});

	it('accepts zero (unlike a transaction amount)', () => {
		expect(parseNetWorthBalanceCents('0')).toBe(0);
	});

	it('accepts a negative balance (e.g. overdraft)', () => {
		expect(parseNetWorthBalanceCents('-100')).toBe(-10_000);
	});

	it('rejects a non-numeric value', () => {
		expect(parseNetWorthBalanceCents('abc')).toBeNull();
	});

	it('rejects an out-of-bounds amount', () => {
		expect(parseNetWorthBalanceCents('9999999999')).toBeNull();
	});

	it('accepts a value at the new, raised cap (real estate, sizable investment)', () => {
		expect(parseNetWorthBalanceCents('9 000 000')).toBe(900_000_000);
	});

	it('parses a dot as a thousands separator with no decimal part', () => {
		expect(parseNetWorthBalanceCents('1.234')).toBe(123_400);
	});

	it('parses the dot-thousands/comma-decimal convention', () => {
		expect(parseNetWorthBalanceCents('1.234,56')).toBe(123_456);
	});

	it('parses the comma-thousands/dot-decimal convention', () => {
		expect(parseNetWorthBalanceCents('1,234.56')).toBe(123_456);
	});

	it('still parses a plain dot-decimal amount', () => {
		expect(parseNetWorthBalanceCents('12.50')).toBe(1_250);
	});

	it('accepts a value exactly at the cap (inclusive upper bound)', () => {
		expect(parseNetWorthBalanceCents('10000000')).toBe(1_000_000_000);
	});

	it('rejects a value one cent above the cap', () => {
		expect(parseNetWorthBalanceCents('10000000.01')).toBeNull();
	});

	it('parses a negative amount combined with the dot-thousands/comma-decimal convention', () => {
		expect(parseNetWorthBalanceCents('-1.234,56')).toBe(-123_456);
	});

	it('treats 3+ trailing digits after a lone dot as thousands grouping, not a rejected decimal', () => {
		// Documented, deliberate normalizeThousands() behavior: unlike the plain manual/import
		// parsers (which reject 3+ decimal digits outright), the thousands-separator mode here
		// falls back to grouping instead of rejecting once there are 3+ digits after the lone
		// separator (see normalizeThousands' doc comment).
		expect(parseNetWorthBalanceCents('1234.567')).toBe(123_456_700);
	});

	it('rejects whitespace-only input', () => {
		expect(parseNetWorthBalanceCents('   ')).toBeNull();
	});
});

describe('signedNetWorthCents / computeNetWorthTotal', () => {
	it('a debt is subtracted from the total', () => {
		expect(signedNetWorthCents('debt', 50_000)).toBe(-50_000);
		expect(signedNetWorthCents('savings', 50_000)).toBe(50_000);
	});

	it('correctly sums several accounts of different types', () => {
		const total = computeNetWorthTotal([
			{ type: 'checking', balanceCents: 100_000 },
			{ type: 'savings', balanceCents: 200_000 },
			{ type: 'debt', balanceCents: 50_000 }
		]);
		expect(total).toBe(250_000);
	});
});

describe('buildNetWorthAssetBreakdown / computeNegativeBalanceTotal', () => {
	it('groups checking/savings/investment and computes each share of the asset total, debt excluded', () => {
		const accounts = [
			{ type: 'checking' as const, balanceCents: 1_200_00 },
			{ type: 'savings' as const, balanceCents: 2_800_00 },
			{ type: 'investment' as const, balanceCents: 750_00 },
			{ type: 'debt' as const, balanceCents: 5_450_00 }
		];

		const breakdown = buildNetWorthAssetBreakdown(accounts);

		expect(breakdown).toEqual([
			{ type: 'checking', totalCents: 1_200_00, pct: expect.closeTo(25.26, 1) },
			{ type: 'savings', totalCents: 2_800_00, pct: expect.closeTo(58.95, 1) },
			{ type: 'investment', totalCents: 750_00, pct: expect.closeTo(15.79, 1) }
		]);
		expect(computeNegativeBalanceTotal(accounts)).toBe(-5_450_00);
	});

	it('sums multiple accounts of the same type into a single entry', () => {
		const accounts = [
			{ type: 'savings' as const, balanceCents: 100_00 },
			{ type: 'savings' as const, balanceCents: 200_00 }
		];
		expect(buildNetWorthAssetBreakdown(accounts)).toEqual([
			{ type: 'savings', totalCents: 300_00, pct: 100 }
		]);
	});

	it('returns an empty array when there are no asset accounts (debt only, or no accounts)', () => {
		expect(buildNetWorthAssetBreakdown([])).toEqual([]);
		expect(buildNetWorthAssetBreakdown([{ type: 'debt', balanceCents: 100_00 }])).toEqual([]);
		expect(computeNegativeBalanceTotal([])).toBe(0);
	});

	it('regression: an overdrawn checking account must not blank out other positive asset types, and must surface in the negative-balance total instead', () => {
		// A negative balance is a legal value for an asset account (overdraft — see
		// parseNetWorthBalanceCents), but it must never drag the whole donut empty just
		// because it makes the RAW sum across types <= 0. Only the positive types' own
		// total should back the percentage base. The money doesn't just vanish though: it
		// must reappear in computeNegativeBalanceTotal (the "Soldes négatifs" line), since
		// that's the only other place a non-debt negative balance can be seen.
		const accounts = [
			{ type: 'checking' as const, balanceCents: -4_000_00 },
			{ type: 'savings' as const, balanceCents: 2_800_00 },
			{ type: 'investment' as const, balanceCents: 550_00 }
		];

		const breakdown = buildNetWorthAssetBreakdown(accounts);

		expect(breakdown).toEqual([
			{ type: 'savings', totalCents: 2_800_00, pct: expect.closeTo(83.58, 1) },
			{ type: 'investment', totalCents: 550_00, pct: expect.closeTo(16.42, 1) }
		]);
		// Percentages must stay within [0, 100] and sum to ~100 — never inflated past 100%
		// by including the negative checking type in the percentage base.
		const totalPct = breakdown.reduce((sum, entry) => sum + entry.pct, 0);
		expect(totalPct).toBeCloseTo(100, 5);
		for (const entry of breakdown) {
			expect(entry.pct).toBeGreaterThan(0);
			expect(entry.pct).toBeLessThanOrEqual(100);
		}
		// The overdrawn checking account (a non-debt type) surfaces here, not just in the total.
		expect(computeNegativeBalanceTotal(accounts)).toBe(-4_000_00);
	});

	it('regression: reflects a freshly created account immediately, without a full reload', () => {
		// Simulates the exact flow of readNetWorthAccounts() being called again right after
		// createNetWorthAccount() — the caller must recompute from the NEW array, not reuse
		// a total/breakdown computed before the account existed.
		const before = [
			{ type: 'savings' as const, balanceCents: 1_500_00 },
			{ type: 'investment' as const, balanceCents: 3_200_00 }
		];
		expect(computeNegativeBalanceTotal(before)).toBe(0);
		expect(buildNetWorthAssetBreakdown(before)).toHaveLength(2);

		// A new debt account is created and the accounts list is re-read (simulating
		// readNetWorthAccounts() after createNetWorthAccount()).
		const after = [...before, { type: 'debt' as const, balanceCents: 7_500_00 }];

		expect(computeNegativeBalanceTotal(after)).toBe(-7_500_00);
		expect(buildNetWorthAssetBreakdown(after)).toEqual(buildNetWorthAssetBreakdown(before));
	});

	it('regression: a debt plus a negative non-debt balance combine additively, never net against each other', () => {
		// debt's balanceCents is stored as a positive "amount owed" while a negative non-debt
		// balance is already negative on its own terms — summing raw balanceCents across both
		// conventions would net them (7500 + -5000 = 2500, displayed as -2500€) instead of
		// combining their negative impact (-7500€ + -5000€ = -12500€).
		const accounts = [
			{ type: 'debt' as const, balanceCents: 7_500_00 },
			{ type: 'investment' as const, balanceCents: -5_000_00 }
		];
		expect(computeNegativeBalanceTotal(accounts)).toBe(-12_500_00);
	});

	it('invariant: the donut total plus the negative-balance total always equals computeNetWorthTotal', () => {
		const accounts = [
			{ type: 'checking' as const, balanceCents: 1_200_00 },
			{ type: 'checking' as const, balanceCents: -300_00 },
			{ type: 'savings' as const, balanceCents: 2_800_00 },
			{ type: 'investment' as const, balanceCents: -5_000_00 },
			{ type: 'debt' as const, balanceCents: 7_500_00 }
		];

		const breakdown = buildNetWorthAssetBreakdown(accounts);
		const donutTotalCents = breakdown.reduce((sum, entry) => sum + entry.totalCents, 0);
		const negativeBalanceTotalCents = computeNegativeBalanceTotal(accounts);

		expect(donutTotalCents + negativeBalanceTotalCents).toBe(computeNetWorthTotal(accounts));
	});

	it('omits a type with a zero total from the breakdown', () => {
		const accounts = [
			{ type: 'checking' as const, balanceCents: 100_00 },
			{ type: 'investment' as const, balanceCents: 0 }
		];
		expect(buildNetWorthAssetBreakdown(accounts)).toEqual([
			{ type: 'checking', totalCents: 100_00, pct: 100 }
		]);
	});
});

describe('negativeBalanceDisplayCents', () => {
	it('regression: a zero total renders as plain zero, never negative zero', () => {
		// formatCents(-0) would otherwise render "-0,00 €" (Intl.NumberFormat's negative-zero
		// quirk), which looks exactly like a negative balance that silently wasn't counted.
		expect(Object.is(negativeBalanceDisplayCents(0), -0)).toBe(false);
		expect(Object.is(negativeBalanceDisplayCents(0), 0)).toBe(true);
	});

	it('passes an already-negative total through unchanged', () => {
		// Unlike the old debt-only total (stored positive, negated only for display),
		// computeNegativeBalanceTotal() already returns a correctly-signed negative number.
		expect(negativeBalanceDisplayCents(-7_500_00)).toBe(-7_500_00);
	});
});

describe('buildNetWorthTimeline', () => {
	it('returns an empty array with no snapshot', () => {
		expect(buildNetWorthTimeline([], NO_CLOSURES)).toEqual([]);
	});

	it('aggregates PER ACCOUNT the last known snapshot of each account, never the latest snapshot across all rows', () => {
		// Account A updated in January and March; account B updated only in February.
		// A naive "latest global snapshot" aggregate would miss A's March balance (300)
		// and would wrongly take B's (500) as the only data point for March.
		const snapshots = [
			{
				accountId: 'a',
				type: 'checking' as const,
				balanceCents: 100_00,
				capturedAt: new Date('2026-01-10T00:00:00Z')
			},
			{
				accountId: 'b',
				type: 'savings' as const,
				balanceCents: 500_00,
				capturedAt: new Date('2026-02-15T00:00:00Z')
			},
			{
				accountId: 'a',
				type: 'checking' as const,
				balanceCents: 300_00,
				capturedAt: new Date('2026-03-05T00:00:00Z')
			}
		];

		const series = buildNetWorthTimeline(snapshots, NO_CLOSURES);
		const byTimestamp = new Map(series.map((point) => [point.capturedAt, point.totalCents]));

		// A's Jan snapshot: only A exists yet. B doesn't exist until Feb.
		expect(byTimestamp.get('2026-01-10T00:00:00.000Z')).toBe(100_00);
		// B's Feb snapshot: A carries forward its last known balance (100) + B (500).
		expect(byTimestamp.get('2026-02-15T00:00:00.000Z')).toBe(100_00 + 500_00);
		// A's Mar snapshot: A moves to 300, B still carries forward its last known balance (500).
		expect(byTimestamp.get('2026-03-05T00:00:00.000Z')).toBe(300_00 + 500_00);
		expect(series).toHaveLength(3);
	});

	/**
	 * The carrying-forward above is right for an OPEN account and wrong for a closed one: it ran
	 * past the moment the user removed the account, so a closed account went on contributing to
	 * « today » forever and the curve's present point disagreed with the headline above it.
	 * Measured on the real screen at 2 400,00 € against 10 900,00 €.
	 */
	it('stops carrying a closed account forward, and marks the closure as its own point', () => {
		const snapshots = [
			{
				accountId: 'kept',
				type: 'checking' as const,
				balanceCents: 100_00,
				capturedAt: new Date('2026-01-10T00:00:00Z')
			},
			{
				accountId: 'closed',
				type: 'savings' as const,
				balanceCents: 500_00,
				capturedAt: new Date('2026-02-15T00:00:00Z')
			}
		];
		const closures = new Map([['closed', new Date('2026-03-05T00:00:00Z')]]);

		const series = buildNetWorthTimeline(snapshots, closures);
		const byTimestamp = new Map(series.map((point) => [point.capturedAt, point.totalCents]));

		// Calibration: BEFORE the closure the closed account still counts, so the figure after it is
		// evidence about the cutoff and not about the fixture having lost a snapshot.
		expect(byTimestamp.get('2026-02-15T00:00:00.000Z')).toBe(100_00 + 500_00);

		// Soft-deleting writes no snapshot, so without a point of its own the change would not
		// appear until the next unrelated edit — at a later date than the one the user acted on.
		expect(byTimestamp.get('2026-03-05T00:00:00.000Z')).toBe(100_00);
		expect(series).toHaveLength(3);
	});

	it('adds no point for a closure of an account the series never knew', () => {
		const snapshots = [
			{
				accountId: 'kept',
				type: 'checking' as const,
				balanceCents: 100_00,
				capturedAt: new Date('2026-01-10T00:00:00Z')
			}
		];

		// A point at which nothing changed is noise on the curve, and it would read as an event.
		const series = buildNetWorthTimeline(
			snapshots,
			new Map([['never-snapshotted', new Date('2026-03-05T00:00:00Z')]])
		);

		expect(series).toEqual([{ capturedAt: '2026-01-10T00:00:00.000Z', totalCents: 100_00 }]);
	});

	it("applies the debt's negative sign in the aggregated series", () => {
		const snapshots = [
			{
				accountId: 'a',
				type: 'savings' as const,
				balanceCents: 1_000_00,
				capturedAt: new Date('2026-01-01T00:00:00Z')
			},
			{
				accountId: 'd',
				type: 'debt' as const,
				balanceCents: 400_00,
				capturedAt: new Date('2026-01-02T00:00:00Z')
			}
		];

		const series = buildNetWorthTimeline(snapshots, NO_CLOSURES);
		expect(
			series.every(
				(point) => point.totalCents === 1_000_00 - 400_00 || point.totalCents === 1_000_00
			)
		).toBe(true);
		expect(series[series.length - 1].totalCents).toBe(1_000_00 - 400_00);
	});

	it('ignores an account with no snapshot at all in every point of the timeline', () => {
		// "orphan" simply never appears in the snapshots array — nothing else references it.
		const snapshots = [
			{
				accountId: 'a',
				type: 'checking' as const,
				balanceCents: 100_00,
				capturedAt: new Date('2026-01-01T00:00:00Z')
			}
		];

		const series = buildNetWorthTimeline(snapshots, NO_CLOSURES);
		expect(series.every((point) => point.totalCents === 100_00)).toBe(true);
	});

	it('produces one distinct point per snapshot timestamp, even several updates the same day', () => {
		// Regression: 3 balance updates on the same account, same day, must yield 3
		// visible points on the timeline — not be collapsed into a single monthly point.
		const snapshots = [
			{
				accountId: 'a',
				type: 'checking' as const,
				balanceCents: 2_800_00,
				capturedAt: new Date('2026-06-15T08:00:00Z')
			},
			{
				accountId: 'a',
				type: 'checking' as const,
				balanceCents: 2_000_00,
				capturedAt: new Date('2026-06-15T12:00:00Z')
			},
			{
				accountId: 'a',
				type: 'checking' as const,
				balanceCents: 3_000_00,
				capturedAt: new Date('2026-06-15T18:00:00Z')
			}
		];

		const series = buildNetWorthTimeline(snapshots, NO_CLOSURES);

		expect(series).toHaveLength(3);
		expect(series.map((point) => point.totalCents)).toEqual([2_800_00, 2_000_00, 3_000_00]);
	});

	it('regression: a later type change does not retroactively flip the sign of past points (bug #1)', () => {
		// The account was created as "savings" (+1000), then its type was changed to "debt"
		// without a balance change. Each snapshot freezes the type it was captured with, so
		// the January point must stay a +1000 asset even though the account is a debt today.
		const snapshots = [
			{
				accountId: 'a',
				type: 'savings' as const,
				balanceCents: 1_000_00,
				capturedAt: new Date('2026-01-01T00:00:00Z')
			},
			{
				accountId: 'a',
				type: 'debt' as const,
				balanceCents: 1_000_00,
				capturedAt: new Date('2026-02-01T00:00:00Z')
			}
		];

		const series = buildNetWorthTimeline(snapshots, NO_CLOSURES);

		expect(series[0].totalCents).toBe(1_000_00);
		expect(series[1].totalCents).toBe(-1_000_00);
	});

	it('regression: a soft-deleted account keeps contributing its historically-correct sign to past points', () => {
		// The account no longer exists in the live accounts list (soft-deleted), but its
		// past snapshots must still surface in the timeline — this function only ever
		// receives snapshots, never the accounts list, so deletion can't erase history here.
		const snapshots = [
			{
				accountId: 'gone',
				type: 'checking' as const,
				balanceCents: 500_00,
				capturedAt: new Date('2026-01-01T00:00:00Z')
			}
		];

		expect(buildNetWorthTimeline(snapshots, NO_CLOSURES)[0].totalCents).toBe(500_00);
	});
});

describe('suggestNetWorthAccountType', () => {
	it('maps CACC to checking', () => {
		expect(suggestNetWorthAccountType('CACC', false)).toBe('checking');
	});

	it('maps SVGS to savings', () => {
		expect(suggestNetWorthAccountType('SVGS', false)).toBe('savings');
	});

	it('maps LOAN to debt', () => {
		expect(suggestNetWorthAccountType('LOAN', false)).toBe('debt');
	});

	it('maps CARD to debt when hasCreditLimit is true', () => {
		expect(suggestNetWorthAccountType('CARD', true)).toBe('debt');
	});

	it('maps CARD to checking when hasCreditLimit is false (conservative default)', () => {
		expect(suggestNetWorthAccountType('CARD', false)).toBe('checking');
	});

	it('returns null for CASH', () => {
		expect(suggestNetWorthAccountType('CASH', false)).toBeNull();
	});

	it('returns null for OTHR', () => {
		expect(suggestNetWorthAccountType('OTHR', false)).toBeNull();
	});

	it('returns null for an unrecognized string', () => {
		expect(suggestNetWorthAccountType('WHATEVER', false)).toBeNull();
	});

	it('returns null for null', () => {
		expect(suggestNetWorthAccountType(null, false)).toBeNull();
	});

	it('ignores hasCreditLimit for non-CARD codes', () => {
		expect(suggestNetWorthAccountType('CACC', true)).toBe('checking');
		expect(suggestNetWorthAccountType('LOAN', true)).toBe('debt');
	});
});
