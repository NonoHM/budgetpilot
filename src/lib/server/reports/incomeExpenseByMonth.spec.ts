import { describe, expect, it } from 'vitest';
import type { CategoryAllocation } from '$lib/domain/allocation';
import { buildIncomeExpenseByMonth, reportMonths } from '$lib/domain/incomeExpenseByMonth';
import { buildMonthlyReport } from './monthly';

function allocation(
	overrides: Partial<CategoryAllocation> &
		Pick<CategoryAllocation, 'transactionId' | 'date' | 'amountCents' | 'kind'>
): CategoryAllocation {
	return { category: 'Courses', nature: 'spending', transferPaired: false, ...overrides };
}

// Twelve whole months before January 2026, then January 2026 in progress.
const MONTHS = reportMonths('2026-01-15');

const allocations: CategoryAllocation[] = [
	allocation({
		transactionId: 'salary-dec',
		date: '2025-12-01',
		amountCents: 250_000,
		kind: 'income',
		nature: 'income'
	}),
	// One purchase split in two parts: each part counts once.
	allocation({ transactionId: 'split', date: '2025-12-10', amountCents: -6_000, kind: 'expense' }),
	allocation({
		transactionId: 'split',
		date: '2025-12-10',
		amountCents: -4_000,
		kind: 'expense',
		category: 'Maison'
	}),
	allocation({
		transactionId: 'refund',
		date: '2025-12-12',
		amountCents: 1_500,
		kind: 'income',
		nature: 'refund'
	}),
	// A confirmed transfer pair straddling the year: each leg leaves its own month (#212, R3 v2).
	allocation({
		transactionId: 'leg-out',
		date: '2025-12-31',
		amountCents: -50_000,
		kind: 'expense',
		nature: 'transfer',
		transferPaired: true
	}),
	allocation({
		transactionId: 'leg-in',
		date: '2026-01-01',
		amountCents: 50_000,
		kind: 'income',
		nature: 'transfer',
		transferPaired: true
	}),
	allocation({
		transactionId: 'rent-jan',
		date: '2026-01-03',
		amountCents: -80_000,
		kind: 'expense'
	}),
	// Outside the thirteen months: before the first and after today's month.
	allocation({
		transactionId: 'too-old',
		date: '2024-12-31',
		amountCents: -9_999,
		kind: 'expense'
	}),
	allocation({ transactionId: 'future', date: '2026-02-01', amountCents: 7_777, kind: 'income' })
];

describe('reportMonths', () => {
	// The two boundaries the contradiction pass named: today in January, and today on 31 December.
	it.each([
		['2027-01-15', '2026-01', '2027-01'],
		['2026-12-31', '2025-12', '2026-12']
	])('from %s runs %s to %s', (today, first, last) => {
		const months = reportMonths(today).map((month) => month.month);
		expect([months.length, months[0], months[12]]).toEqual([13, first, last]);
	});

	it('is the twelve whole months before today, then today, across a year boundary', () => {
		expect(MONTHS.map((month) => month.month)).toEqual([
			'2025-01',
			'2025-02',
			'2025-03',
			'2025-04',
			'2025-05',
			'2025-06',
			'2025-07',
			'2025-08',
			'2025-09',
			'2025-10',
			'2025-11',
			'2025-12',
			'2026-01'
		]);
	});

	it('marks only the last month as in progress', () => {
		expect(MONTHS.filter((month) => month.partial).map((month) => month.month)).toEqual([
			'2026-01'
		]);
	});

	it('gives each month its first and last day, for the link to its rows', () => {
		expect(MONTHS.find((month) => month.month === '2025-02')).toMatchObject({
			from: '2025-02-01',
			to: '2025-02-28'
		});
		expect(MONTHS.find((month) => month.month === '2025-12')).toMatchObject({
			from: '2025-12-01',
			to: '2025-12-31'
		});
	});
});

describe('buildIncomeExpenseByMonth', () => {
	const series = buildIncomeExpenseByMonth(allocations, MONTHS);

	it('has one entry per month, empty months included', () => {
		expect(series).toHaveLength(13);
		expect(series[0]).toMatchObject({ month: '2025-01', incomeCents: 0, expenseCents: 0 });
	});

	// Separates « the chart and /reports agree » from « the chart has its own rule ».
	it('shows for every month the figures the period report shows for that month', () => {
		for (const entry of series) {
			const report = buildMonthlyReport([], allocations, entry.month);
			expect({
				month: entry.month,
				income: entry.incomeCents,
				expense: entry.expenseCents
			}).toEqual({
				month: entry.month,
				income: report.incomeCents,
				expense: report.expenseCents
			});
		}
	});

	// Absolute figures, so the agreement above cannot pass on two copies of one wrong rule.
	it('counts split parts once each, keeps refunds as income and drops each transfer leg in its own month', () => {
		expect(series.find((entry) => entry.month === '2025-12')).toMatchObject({
			incomeCents: 251_500,
			expenseCents: 10_000
		});
		expect(series.find((entry) => entry.month === '2026-01')).toMatchObject({
			incomeCents: 0,
			expenseCents: 80_000,
			partial: true
		});
	});

	it('leaves out what falls before the first month or after today’s month', () => {
		const total = series.reduce((sum, entry) => sum + entry.incomeCents + entry.expenseCents, 0);
		expect(total).toBe(251_500 + 10_000 + 80_000);
	});
});
