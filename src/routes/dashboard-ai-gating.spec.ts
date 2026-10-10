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
	// `allocations` is not optional padding: `load` reads the MONEY view for the budget summary and
	// the nature analysis, and the IDENTITY view for everything that counts bank lines. A mock
	// returning only one of the two is a boundary that forgot the other.
	readDashboardDataForRange: vi.fn(async () => ({
		transactions: [],
		allocations: [],
		budgets: []
	})),
	readDashboardData: vi.fn(async () => ({ transactions: [], allocations: [], budgets: [] })),
	// Models the EMPTY account faithfully rather than throwing: this spec is about AI gating, and an
	// account-level span of zero is a real, coherent state for every case it exercises (all of which
	// already return no transactions above). A fake that refused to answer here would fail these
	// tests for a reason none of them is about.
	readAccountTransactionSpan: vi.fn(async () => ({ count: 0, firstDate: null, lastDate: null })),
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

/**
 * The model's two calls, counted. Since #535 the load never reaches either: the dashboard returns a
 * key and the card posts to `/insights/advice`. A load that called the model again, a hover prefetch
 * included, would show here as a non-zero count.
 */
const localLlm = vi.hoisted(() => ({
	isLocalLlmEnabled: vi.fn(() => true),
	probeLocalLlm: vi.fn(async () => null),
	requestLocalBudgetInsights: vi.fn(async () => null)
}));

const gatewaySpy = vi.hoisted(() => ({ failPrepare: false }));

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
vi.mock('$lib/server/insights/local-llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/insights/local-llm')>()),
	...localLlm
}));
// The real prepareAdvice, with a switch that makes it throw: the load must survive that (rev 1 F7).
vi.mock('$lib/server/ai/gateway', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/ai/gateway')>();
	return {
		...original,
		prepareAdvice: (...args: Parameters<typeof original.prepareAdvice>) => {
			if (gatewaySpy.failPrepare) throw new Error('refused key in payload');
			return original.prepareAdvice(...args);
		}
	};
});
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
		budgetDashboard.readDashboardDataForRange.mockResolvedValue({
			transactions: [],
			allocations: [],
			budgets: []
		});
		dateRange.getPreviousMonthRange.mockReturnValue(null);
	});

	type AiData = { aiAllowed: boolean; aiAdviceKey: string | null; aiAdvice?: unknown };
	async function loadAi(): Promise<AiData> {
		return (await load(buildLoadEvent())) as unknown as AiData;
	}
	function expectNoModelCall() {
		expect(localLlm.probeLocalLlm).not.toHaveBeenCalled();
		expect(localLlm.requestLocalBudgetInsights).not.toHaveBeenCalled();
	}

	it.each([
		['LLM_ENABLED is false for the instance', false, true],
		['the member turned the AI off', true, false]
	])('when %s: aiAllowed false, no key, no model call', async (_name, instance, member) => {
		localLlm.isLocalLlmEnabled.mockReturnValue(instance);
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			aiInsightsEnabled: member,
			aiIncludeLabels: false
		});
		const data = await loadAi();
		expect(data.aiAllowed).toBe(false);
		expect(data.aiAdviceKey).toBeNull();
		expectNoModelCall();
	});

	// #535: the load, which a hover prefetch also runs, starts no generation, versus 9.7 s of GPU per
	// hover. It returns the key the card posts on instead, and no advice promise at all.
	it.each([true, false])(
		'with the AI on (labels %s), returns a key and never calls the model',
		async (labels) => {
			localLlm.isLocalLlmEnabled.mockReturnValue(true);
			db.prisma.user.findUniqueOrThrow.mockResolvedValue({
				aiInsightsEnabled: true,
				aiIncludeLabels: labels
			});
			const data = await loadAi();
			expect(data.aiAllowed).toBe(true);
			expect(data.aiAdviceKey).toMatch(/^[0-9a-f]{64}$/);
			expect('aiAdvice' in data).toBe(false);
			expectNoModelCall();
		}
	);

	// Spec F2: the card refetches when the key changes, so the key must follow the data and the
	// period, and stay put when neither moved (versus a card that never refreshes, or one that
	// regenerates on every load).
	it('the key is stable across identical loads and moves with the period, the data and the labels choice', async () => {
		localLlm.isLocalLlmEnabled.mockReturnValue(true);
		const first = (await loadAi()).aiAdviceKey;
		expect((await loadAi()).aiAdviceKey).toBe(first);

		dateRange.parseDateRange.mockReturnValueOnce({
			from: new Date('2026-05-01T00:00:00.000Z'),
			to: new Date('2026-06-01T00:00:00.000Z'),
			label: 'Mai 2026',
			budgetMonth: '2026-05'
		});
		expect((await loadAi()).aiAdviceKey).not.toBe(first);

		const rent = {
			id: 'rent',
			date: '2026-06-02',
			label: 'LOYER',
			amountCents: -80_000,
			type: 'expense' as const,
			category: 'Logement',
			source: 'manual' as const
		};
		budgetDashboard.readDashboardDataForRange.mockResolvedValueOnce({
			transactions: [rent],
			allocations: [
				{
					transactionId: 'rent',
					date: '2026-06-02',
					category: 'Logement',
					amountCents: -80_000,
					nature: 'expense',
					kind: 'expense'
				}
			],
			budgets: []
		} as never);
		expect((await loadAi()).aiAdviceKey).not.toBe(first);

		db.prisma.user.findUniqueOrThrow.mockResolvedValueOnce({
			aiInsightsEnabled: true,
			aiIncludeLabels: true
		});
		expect((await loadAi()).aiAdviceKey).not.toBe(first);
	});

	// Rev 1 F7: preparing the advice can throw (a refused key in the payload). That used to be caught
	// with the streamed promise; now it must not take the whole dashboard down.
	it('a prepareAdvice that throws leaves the dashboard up with no key', async () => {
		localLlm.isLocalLlmEnabled.mockReturnValue(true);
		gatewaySpy.failPrepare = true;
		try {
			const data = await loadAi();
			expect(data.aiAllowed).toBe(true);
			expect(data.aiAdviceKey).toBeNull();
		} finally {
			gatewaySpy.failPrepare = false;
		}
	});

	it('attend loadUpcomingBillsWidget (jamais un flux) et le scope à l’utilisateur', async () => {
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
