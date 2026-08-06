import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategoryBudgetSummary } from '$lib/domain/budget';
import type { Transaction } from '$lib/domain/transaction';
import { allocationsOf, type CategoryAllocation } from '$lib/domain/allocation';
import { getEffectiveTransactionNature } from '$lib/server/transactions/nature';
import {
	computeBudgetAlerts,
	computeUnusualSpendingInsight,
	getRemainingDaysInMonth,
	rankAlertedBudgets,
	spendByEffectiveCategory
} from './insights';

function summary(overrides: Partial<CategoryBudgetSummary>): CategoryBudgetSummary {
	return {
		category: 'Restaurants',
		limitCents: 20000,
		spentCents: 20000,
		remainingCents: 0,
		usagePercentage: 100,
		status: 'ok',
		isOverBudget: false,
		...overrides
	};
}

function transaction(overrides: Partial<Transaction>): Transaction {
	return {
		id: 'tx-1',
		date: '2026-06-10',
		label: 'Achat',
		amountCents: -1000,
		type: 'expense',
		category: 'Restaurants',
		source: 'manual',
		...overrides
	};
}

/**
 * The one CategoryAllocation an unsplit transaction fixture yields, resolved the same way the
 * production boundary does: `nature` defaults through the real getEffectiveTransactionNature rule
 * (never hand-typed here) when the fixture does not pin one, then allocationsOf (the real
 * remainder rule) turns the transaction into its allocation.
 */
function allocationOf(tx: Transaction): CategoryAllocation {
	const nature =
		tx.nature ??
		getEffectiveTransactionNature(
			{ amountCents: tx.amountCents, type: tx.type, category: tx.category },
			new Map()
		).nature;

	return allocationsOf({ ...tx, nature })[0];
}

describe('rankAlertedBudgets', () => {
	it('filters out ok budgets and ranks over_budget before near_limit', () => {
		const ranked = rankAlertedBudgets([
			summary({ category: 'OK', status: 'ok' }),
			summary({ category: 'Near', status: 'near_limit', usagePercentage: 85 }),
			summary({ category: 'Over', status: 'over_budget', remainingCents: -2300 })
		]);

		expect(ranked.map((s) => s.category)).toEqual(['Over', 'Near']);
	});

	it('ranks the most overshot budget first among several over_budget', () => {
		const ranked = rankAlertedBudgets([
			summary({ category: 'SmallOver', status: 'over_budget', remainingCents: -500 }),
			summary({ category: 'BigOver', status: 'over_budget', remainingCents: -5000 })
		]);

		expect(ranked.map((s) => s.category)).toEqual(['BigOver', 'SmallOver']);
	});

	it('ranks the closest-to-limit budget first among several near_limit', () => {
		const ranked = rankAlertedBudgets([
			summary({ category: 'A', status: 'near_limit', usagePercentage: 82 }),
			summary({ category: 'B', status: 'near_limit', usagePercentage: 95 })
		]);

		expect(ranked.map((s) => s.category)).toEqual(['B', 'A']);
	});
});

describe('computeBudgetAlerts', () => {
	it('caps alerts at 2 and reports the overflow count', () => {
		const { alerts, overflowCount } = computeBudgetAlerts(
			[
				summary({ category: 'A', status: 'over_budget', remainingCents: -100 }),
				summary({ category: 'B', status: 'over_budget', remainingCents: -200 }),
				summary({ category: 'C', status: 'near_limit', usagePercentage: 90 })
			],
			[],
			[],
			10
		);

		expect(alerts).toHaveLength(2);
		expect(overflowCount).toBe(1);
	});

	it('computes "dépassé" remaining cents without a daily pace for over_budget', () => {
		const { alerts } = computeBudgetAlerts(
			[summary({ category: 'Restaurants', status: 'over_budget', remainingCents: -2300 })],
			[],
			[],
			6
		);

		expect(alerts[0].remainingCents).toBe(-2300);
		expect(alerts[0].dailyPaceCents).toBeNull();
		expect(alerts[0].remainingDays).toBe(6);
	});

	it('computes the daily pace for near_limit as remaining / days left', () => {
		const { alerts } = computeBudgetAlerts(
			[
				summary({
					category: 'Loisirs',
					status: 'near_limit',
					remainingCents: 2000,
					usagePercentage: 90
				})
			],
			[],
			[],
			6
		);

		expect(alerts[0].dailyPaceCents).toBe(Math.round(2000 / 6));
	});

	it('omits remainingDays/dailyPace when there are no days left in the month', () => {
		const { alerts } = computeBudgetAlerts(
			[summary({ category: 'Loisirs', status: 'near_limit', remainingCents: 2000 })],
			[],
			[],
			0
		);

		expect(alerts[0].remainingDays).toBeNull();
		expect(alerts[0].dailyPaceCents).toBeNull();
	});

	it('picks the top 3 biggest expenses for the alerted category, ignoring other categories', () => {
		const transactionsThisMonth = [
			transaction({ id: '1', category: 'Restaurants', amountCents: -1000 }),
			transaction({ id: '2', category: 'Restaurants', amountCents: -5000 }),
			transaction({ id: '3', category: 'Restaurants', amountCents: -2000 }),
			transaction({ id: '4', category: 'Restaurants', amountCents: -500 }),
			transaction({ id: '5', category: 'Autre', amountCents: -9000 }),
			transaction({ id: '6', category: 'Restaurants', amountCents: 3000, type: 'income' })
		];

		const { alerts } = computeBudgetAlerts(
			[summary({ category: 'Restaurants', status: 'over_budget', remainingCents: -100 })],
			transactionsThisMonth.map(allocationOf),
			transactionsThisMonth,
			6
		);

		expect(alerts[0].topExpenses.map((e) => e.amountCents)).toEqual([-5000, -2000, -1000]);
	});
});

describe('computeUnusualSpendingInsight', () => {
	it('returns null when fewer than 2 historical months have any data', () => {
		const result = computeUnusualSpendingInsight(new Map([['Alimentation', 32000]]), [
			new Map([['Alimentation', 22000]]),
			new Map(),
			new Map()
		]);

		expect(result).toBeNull();
	});

	it('flags a category with a large increase vs its historical average', () => {
		const result = computeUnusualSpendingInsight(new Map([['Alimentation', 32000]]), [
			new Map([['Alimentation', 22000]]),
			new Map([['Alimentation', 22100]]),
			new Map([['Alimentation', 21900]])
		]);

		expect(result?.category).toBe('Alimentation');
		expect(result?.averageCents).toBeCloseTo(22000, 0);
		expect(result?.increasePercentage).toBeGreaterThan(30);
	});

	it('does not flag a category below the increase threshold', () => {
		const result = computeUnusualSpendingInsight(new Map([['Alimentation', 23000]]), [
			new Map([['Alimentation', 22000]]),
			new Map([['Alimentation', 22000]])
		]);

		expect(result).toBeNull();
	});

	it('ignores categories with no historical baseline (average of 0)', () => {
		const result = computeUnusualSpendingInsight(new Map([['NouvelleCategorie', 5000]]), [
			new Map([['Alimentation', 22000]]),
			new Map([['Alimentation', 22000]])
		]);

		expect(result).toBeNull();
	});

	it('ignores small absolute amounts even with a high percentage increase', () => {
		const result = computeUnusualSpendingInsight(new Map([['Divers', 1500]]), [
			new Map([['Divers', 500]]),
			new Map([['Divers', 500]])
		]);

		expect(result).toBeNull();
	});

	it('picks the category with the highest increase when several qualify', () => {
		const result = computeUnusualSpendingInsight(
			new Map([
				['Alimentation', 30000],
				['Loisirs', 40000]
			]),
			[
				new Map([
					['Alimentation', 22000],
					['Loisirs', 20000]
				]),
				new Map([
					['Alimentation', 22000],
					['Loisirs', 20000]
				])
			]
		);

		expect(result?.category).toBe('Loisirs');
	});
});

describe('spendByEffectiveCategory', () => {
	it('excludes transfer and investment natures from spending totals', () => {
		const spend = spendByEffectiveCategory(
			[
				transaction({ id: '1', category: 'Épargne', amountCents: -50000, nature: 'transfer' }),
				transaction({ id: '2', category: 'Bourse', amountCents: -30000, nature: 'investment' }),
				transaction({ id: '3', category: 'Alimentation', amountCents: -2000, nature: 'spending' })
			].map(allocationOf)
		);

		expect(spend.get('Épargne')).toBeUndefined();
		expect(spend.get('Bourse')).toBeUndefined();
		expect(spend.get('Alimentation')).toBe(2000);
	});

	it('excludes income transactions', () => {
		const spend = spendByEffectiveCategory(
			[transaction({ id: '1', category: 'Salaire', amountCents: 320000, type: 'income' })].map(
				allocationOf
			)
		);

		expect(spend.size).toBe(0);
	});

	it("exclut une transaction income même quand sa nature est explicitement 'income'", () => {
		const spend = spendByEffectiveCategory(
			[
				transaction({
					id: '1',
					category: 'Revenus',
					amountCents: 320000,
					type: 'income',
					nature: 'income'
				})
			].map(allocationOf)
		);

		expect(spend.size).toBe(0);
	});
});

describe('getRemainingDaysInMonth', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns 0 when the given month is not the current local month', () => {
		vi.setSystemTime(new Date(2026, 5, 15));
		expect(getRemainingDaysInMonth('2026-05')).toBe(0);
	});

	it('counts today as a remaining day (inclusive)', () => {
		vi.setSystemTime(new Date(2026, 5, 24));
		expect(getRemainingDaysInMonth('2026-06')).toBe(7);
	});

	it('returns 1 on the last day of the month', () => {
		vi.setSystemTime(new Date(2026, 5, 30));
		expect(getRemainingDaysInMonth('2026-06')).toBe(1);
	});

	it('handles February in a leap year', () => {
		vi.setSystemTime(new Date(2028, 1, 1));
		expect(getRemainingDaysInMonth('2028-02')).toBe(29);
	});

	it('is based on local time, not UTC, matching getCurrentMonth()', () => {
		// Regression for the UTC/local mismatch: just after local midnight on the 1st,
		// UTC may still read the previous month depending on the server's timezone offset.
		vi.setSystemTime(new Date(2026, 6, 1, 0, 30));
		expect(getRemainingDaysInMonth('2026-07')).toBe(31);
	});
});
