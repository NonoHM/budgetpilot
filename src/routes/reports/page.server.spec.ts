import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const db = vi.hoisted(() => ({
	prisma: {
		transaction: {
			findMany: vi.fn(async ({ where }) => {
				const start = where.date.gte.toISOString();
				return start === '2026-06-01T00:00:00.000Z'
					? [
							{
								id: 'income',
								date: new Date('2026-06-01T00:00:00.000Z'),
								label: 'Salaire',
								amountCents: 200_000,
								type: 'income',
								source: 'manual',
								manualCategory: null,
								category: { name: 'Revenus' }
							},
							{
								id: 'expense',
								date: new Date('2026-06-02T00:00:00.000Z'),
								label: 'Courses',
								amountCents: -50_000,
								type: 'expense',
								source: 'unknown_source',
								manualCategory: 'Maison',
								category: { name: 'Alimentation' }
							}
						]
					: [
							{
								id: 'previous-income',
								date: new Date('2026-05-01T00:00:00.000Z'),
								label: 'Salaire',
								amountCents: 180_000,
								type: 'income',
								source: 'csv',
								manualCategory: null,
								category: { name: 'Revenus' }
							},
							{
								id: 'previous-expense',
								date: new Date('2026-05-02T00:00:00.000Z'),
								label: 'Courses',
								amountCents: -40_000,
								type: 'expense',
								source: 'csv',
								manualCategory: 'Maison',
								category: { name: 'Alimentation' }
							}
						];
			})
		},
		monthlyBudget: {
			findMany: vi.fn(async () => [
				{
					id: 'budget-food',
					categoryName: 'Maison',
					amountCents: 40_000,
					createdAt: new Date('2026-06-01T00:00:00.000Z'),
					updatedAt: new Date('2026-06-02T00:00:00.000Z')
				}
			])
		},
		categoryNatureMapping: {
			findMany: vi.fn(async () => [
				{
					id: 'mapping-1',
					categoryName: 'Maison',
					nature: 'transfer',
					createdAt: new Date('2026-06-01T00:00:00.000Z'),
					updatedAt: new Date('2026-06-01T00:00:00.000Z')
				}
			])
		},
		category: {
			findMany: vi.fn(async () => [{ name: 'Maison', defaultKey: null }])
		}
	}
}));

const forecast = vi.hoisted(() => ({
	FORECAST_REPORTS_HORIZON_DAYS: 90,
	FORECAST_REPORTS_HORIZON_MONTHS: 3,
	loadCashFlowForecast: vi.fn(async () => ({
		flows: [],
		ledger: { days: [], todayIndex: 0 },
		hasBalanceAnchor: false
	})),
	toDisplayCashFlowForecast: vi.fn(() => ({
		hasBalanceAnchor: false,
		days: [],
		todayIndex: 0,
		flows: []
	}))
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$lib/server/forecast', () => forecast);

const { load } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

describe('/reports load', () => {
	it('affiche le libellé rapport de période et le bloc à retenir', () => {
		expect.assertions(3);

		const page = readFileSync(resolve(root, 'src/routes/reports/+page.svelte'), 'utf8');

		expect(page).toContain('{m.reports_heading()}');
		expect(page).toContain('{m.reports_takeaways_heading()}');
		expect(page).toContain('m.reports_forecast_chart_title({ months: forecastHorizonMonths })');
	});

	it('affiche un résumé de période personnalisée sans filtre source', async () => {
		expect.assertions(19);

		const data = (await load({
			locals: { user: testUser },
			url: new URL('/reports?period=custom&from=2026-06-01&to=2026-06-30', 'http://localhost')
		} as Parameters<typeof load>[0])) as Awaited<ReturnType<typeof load>> & {
			forecastHorizonMonths: number;
			report: {
				incomeCents: number;
				expenseCents: number;
				balanceCents: number;
				transactionCount: number;
				expenseAveragePerDayCents: number;
				savingsRate: number | null;
				topCategories: Array<{ category: string; percentageOfExpenses: number }>;
				natureAnalysis: { transferCents: number; spendingCents: number };
				takeaways: unknown[];
				previousMonth?: { expenseDeltaCents: number };
			};
		};

		expect(db.prisma.transaction.findMany).toHaveBeenCalledTimes(1);
		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userId: testUser.id,
					date: {
						gte: new Date('2026-06-01T00:00:00.000Z'),
						lt: new Date('2026-07-01T00:00:00.000Z')
					}
				}
			})
		);
		expect(db.prisma.transaction.findMany.mock.calls[0][0].where.source).toBeUndefined();
		expect(db.prisma.monthlyBudget.findMany).toHaveBeenCalledWith({
			where: { userId: testUser.id },
			orderBy: { categoryName: 'asc' }
		});
		expect(db.prisma.categoryNatureMapping.findMany).toHaveBeenCalledWith({
			where: { userId: testUser.id },
			orderBy: { categoryName: 'asc' }
		});
		expect(forecast.loadCashFlowForecast).toHaveBeenCalledWith(testUser.id, 90);
		expect(data.forecastHorizonMonths).toBe(3);
		expect(data.report.incomeCents).toBe(200_000);
		expect(data.report.expenseCents).toBe(50_000);
		expect(data.report.balanceCents).toBe(150_000);
		expect(data.report.transactionCount).toBe(2);
		expect(data.report.expenseAveragePerDayCents).toBe(1_667);
		expect(data.report.savingsRate).toBe(0.75);
		expect(data.report.topCategories[0].category).toBe('Maison');
		expect(data.report.topCategories[0].percentageOfExpenses).toBe(1);
		expect(data.report.natureAnalysis.transferCents).toBe(50_000);
		expect(data.report.natureAnalysis.spendingCents).toBe(0);
		expect(data.report.takeaways.length).toBeGreaterThanOrEqual(2);
		expect(data.report.previousMonth).toBeUndefined();
	});

	it('all-time interroge depuis epoch et moyenne sur les jours réellement couverts', async () => {
		expect.assertions(4);

		db.prisma.transaction.findMany.mockClear();

		const data = (await load({
			locals: { user: testUser },
			url: new URL('/reports?period=all-time', 'http://localhost')
		} as Parameters<typeof load>[0])) as Awaited<ReturnType<typeof load>> & {
			report: { expenseAveragePerDayCents: number; previousMonth?: unknown };
		};

		// No comparison period for all-time → a single transaction query, epoch lower bound.
		expect(db.prisma.transaction.findMany).toHaveBeenCalledTimes(1);
		expect(db.prisma.transaction.findMany.mock.calls[0][0].where.date.gte).toEqual(new Date(0));
		// dayCount falls back to the covered span (May 1 → May 2 = 2 days), not ~20k epoch days.
		expect(data.report.expenseAveragePerDayCents).toBe(20_000);
		expect(data.report.previousMonth).toBeUndefined();
	});
});
