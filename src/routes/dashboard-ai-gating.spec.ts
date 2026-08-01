import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		user: {
			findUniqueOrThrow: vi.fn(async () => ({ aiInsightsEnabled: true, aiIncludeLabels: false }))
		},
		category: {
			findMany: vi.fn(async () => [])
		}
	}
}));

const budgetDashboard = vi.hoisted(() => ({
	createManualTransaction: vi.fn(),
	readDashboardDataForRange: vi.fn(async () => ({ transactions: [], budgets: [] })),
	readDashboardData: vi.fn(async () => ({ transactions: [], budgets: [] })),
	saveBudget: vi.fn()
}));

const dateRange = vi.hoisted(() => ({
	getPreviousMonthRange: vi.fn(() => null),
	parseDateRange: vi.fn(() => ({
		from: new Date('2026-06-01T00:00:00.000Z'),
		to: new Date('2026-07-01T00:00:00.000Z'),
		label: 'Juin 2026',
		budgetMonth: '2026-06'
	})),
	serializePeriodParams: vi.fn(() => '')
}));

const insightsIndex = vi.hoisted(() => ({
	getBudgetInsights: vi.fn(async () => ({
		summary: {},
		insights: [
			{
				id: 'x',
				title: 't',
				message: 'm',
				severity: 'info',
				category: 'budget',
				source: 'local-llm'
			}
		],
		localAiUnavailable: false
	}))
}));

const localLlm = vi.hoisted(() => ({
	isLocalLlmEnabled: vi.fn(() => true)
}));

const dashboardInsights = vi.hoisted(() => ({
	loadDashboardInsights: vi.fn(async () => [])
}));

const nature = vi.hoisted(() => ({
	analyzeTransactionNatures: vi.fn(() => ({}))
}));

const savingsGoals = vi.hoisted(() => ({
	readSavingsGoals: vi.fn(async () => [])
}));

const upcomingBills = vi.hoisted(() => ({
	loadUpcomingBillsWidget: vi.fn(async () => ({
		rows: [],
		overdueCount: 0,
		remainingExpenseCents: 0,
		hasStreams: false,
		emptyState: 'none-detected',
		todayIso: '2026-06-15'
	}))
}));

const forecast = vi.hoisted(() => ({
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
vi.mock('$lib/server/budget/dashboard', () => budgetDashboard);
vi.mock('$lib/server/date-range', () => dateRange);
vi.mock('$lib/server/insights', () => insightsIndex);
vi.mock('$lib/server/insights/local-llm', () => localLlm);
vi.mock('$lib/server/dashboard/insights', () => dashboardInsights);
vi.mock('$lib/server/transactions/nature', () => nature);
vi.mock('$lib/server/savings-goals/service', () => savingsGoals);
vi.mock('$lib/server/forecast', () => forecast);
vi.mock('$lib/server/upcoming-bills/service', () => upcomingBills);

const { load } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

function buildLoadEvent() {
	return {
		locals: { user: testUser },
		url: new URL('http://localhost/')
	} as Parameters<typeof load>[0];
}

describe('/ (dashboard) — gating IA à 3 états', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			aiInsightsEnabled: true,
			aiIncludeLabels: false
		});
		db.prisma.category.findMany.mockResolvedValue([]);
		budgetDashboard.readDashboardDataForRange.mockResolvedValue({ transactions: [], budgets: [] });
		dateRange.getPreviousMonthRange.mockReturnValue(null);
	});

	it('n’appelle jamais getBudgetInsights quand LLM_ENABLED est false globalement', async () => {
		expect.assertions(2);

		localLlm.isLocalLlmEnabled.mockReturnValue(false);
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			aiInsightsEnabled: true,
			aiIncludeLabels: false
		});

		const data = (await load(buildLoadEvent())) as Awaited<ReturnType<typeof load>> & {
			aiAllowed: boolean;
		};

		expect(insightsIndex.getBudgetInsights).not.toHaveBeenCalled();
		expect(data.aiAllowed).toBe(false);
	});

	it('n’appelle jamais getBudgetInsights quand l’utilisateur a désactivé les conseils IA (même si LLM_ENABLED=true)', async () => {
		expect.assertions(2);

		localLlm.isLocalLlmEnabled.mockReturnValue(true);
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			aiInsightsEnabled: false,
			aiIncludeLabels: false
		});

		const data = (await load(buildLoadEvent())) as Awaited<ReturnType<typeof load>> & {
			aiAllowed: boolean;
		};

		expect(insightsIndex.getBudgetInsights).not.toHaveBeenCalled();
		expect(data.aiAllowed).toBe(false);
	});

	it('appelle getBudgetInsights et expose aiAllowed=true quand LLM global et préférence utilisateur sont activés', async () => {
		expect.assertions(3);

		localLlm.isLocalLlmEnabled.mockReturnValue(true);
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			aiInsightsEnabled: true,
			aiIncludeLabels: true
		});

		const data = (await load(buildLoadEvent())) as Awaited<ReturnType<typeof load>> & {
			aiAllowed: boolean;
			advice: unknown;
		};

		expect(insightsIndex.getBudgetInsights).toHaveBeenCalledTimes(1);
		expect(data.aiAllowed).toBe(true);
		expect(data.advice).not.toBeNull();
	});

	it('transmet includeLabels de la préférence utilisateur à getBudgetInsights', async () => {
		expect.assertions(1);

		localLlm.isLocalLlmEnabled.mockReturnValue(true);
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			aiInsightsEnabled: true,
			aiIncludeLabels: true
		});

		await load(buildLoadEvent());

		expect(insightsIndex.getBudgetInsights).toHaveBeenCalledWith(
			expect.objectContaining({ includeLabels: true })
		);
	});

	it('attend loadUpcomingBillsWidget (contrairement à aiAdvice, jamais un flux) et le scope à l’utilisateur', async () => {
		expect.assertions(3);

		const resolved = {
			rows: [],
			overdueCount: 0,
			remainingExpenseCents: 0,
			hasStreams: false,
			emptyState: 'none-detected',
			todayIso: '2026-06-15'
		};
		// `Once`, not `mockResolvedValue`: the suite's `beforeEach` runs `vi.clearAllMocks()`, which
		// clears calls but NOT implementations, so a permanent override here would leak into whatever
		// test runs next. Harmless only while this one happens to be last — a property any reorder
		// removes silently.
		upcomingBills.loadUpcomingBillsWidget.mockResolvedValueOnce(resolved);

		const data = (await load(buildLoadEvent())) as Awaited<ReturnType<typeof load>> & {
			upcomingBills: unknown;
		};

		expect(upcomingBills.loadUpcomingBillsWidget).toHaveBeenCalledWith(testUser.id);
		expect(data.upcomingBills).not.toBeInstanceOf(Promise);
		expect(data.upcomingBills).toEqual(resolved);
	});
});
