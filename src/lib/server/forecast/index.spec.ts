import { describe, expect, it, vi } from 'vitest';
import {
	detectionEndExclusive,
	type RecurringFlow,
	type ProjectedOccurrence
} from '$lib/domain/forecast';
import {
	FORECAST_REPORTS_HORIZON_DAYS,
	FORECAST_REPORTS_HORIZON_MONTHS,
	toDisplayCashFlowForecast,
	type CashFlowForecast,
	type CashFlowLedger
} from './index';

describe('FORECAST_REPORTS_HORIZON_MONTHS', () => {
	it('is derived from FORECAST_REPORTS_HORIZON_DAYS, never hardcoded independently', () => {
		expect(FORECAST_REPORTS_HORIZON_MONTHS).toBe(Math.round(FORECAST_REPORTS_HORIZON_DAYS / 30));
	});
});

function flow(overrides: Partial<RecurringFlow> = {}): RecurringFlow {
	return {
		key: 'expense:virement salaire acme:Revenus',
		label: 'VIREMENT SALAIRE ACME 123456',
		category: 'Revenus',
		direction: 'income',
		cadence: 'monthly',
		status: 'confirmed',
		confidence: 'high',
		occurrenceCount: 3,
		averageAmountCents: 200_000,
		minAmountCents: 200_000,
		maxAmountCents: 200_000,
		medianIntervalDays: 30,
		intervalCoefficientOfVariation: 0,
		amountCoefficientOfVariation: 0,
		dayOfMonthConcentration: 1,
		lastDate: '2025-03-28',
		anchorDayOfMonth: 28,
		occurrenceIds: ['tx-1', 'tx-2', 'tx-3'],
		...overrides
	};
}

function occurrence(overrides: Partial<ProjectedOccurrence> = {}): ProjectedOccurrence {
	return {
		date: '2025-04-28',
		amountCents: 200_000,
		flowKey: 'expense:virement salaire acme:Revenus',
		flowLabel: 'VIREMENT SALAIRE ACME 123456',
		flowCategory: 'Revenus',
		cadence: 'monthly',
		...overrides
	};
}

function ledger(days: CashFlowLedger['days'], todayIndex = 0): CashFlowLedger {
	return { days, todayIndex };
}

describe('toDisplayCashFlowForecast', () => {
	it('anonymise le libellé de chaque flux détecté (jamais le libellé brut)', () => {
		expect.assertions(3);

		const forecast: CashFlowForecast = {
			flows: [flow()],
			ledger: ledger([{ date: '2025-04-01', balanceCents: 0, events: [] }]),
			hasBalanceAnchor: true
		};

		const view = toDisplayCashFlowForecast(forecast);

		expect(view.flows[0].label).toBe('Salaire Acme - Revenus');
		expect(view.flows[0].label).not.toContain('123456');
		expect(view.flows[0].label).not.toContain('VIREMENT SALAIRE ACME 123456');
	});

	it('anonymise le libellé de chaque événement du grand livre (jamais le libellé brut)', () => {
		expect.assertions(3);

		const forecast: CashFlowForecast = {
			flows: [],
			ledger: ledger([
				{ date: '2025-04-01', balanceCents: 0, events: [] },
				{ date: '2025-04-28', balanceCents: 200_000, events: [occurrence()] }
			]),
			hasBalanceAnchor: true
		};

		const view = toDisplayCashFlowForecast(forecast);

		expect(view.days[1].events[0].label).toBe('Salaire Acme - Revenus');
		expect(view.days[1].events[0].label).not.toContain('123456');
		expect(view.days[1].events[0].label).not.toContain('VIREMENT SALAIRE ACME 123456');
	});

	it('préserve les montants, dates, cadences et le statut de l’ancre de solde tels quels', () => {
		expect.assertions(4);

		const forecast: CashFlowForecast = {
			flows: [flow({ status: 'tentative', confidence: 'low' })],
			ledger: ledger([
				{ date: '2025-04-01', balanceCents: 42_000, events: [occurrence({ amountCents: -5_000 })] }
			]),
			hasBalanceAnchor: false
		};

		const view = toDisplayCashFlowForecast(forecast);

		expect(view.hasBalanceAnchor).toBe(false);
		expect(view.flows[0].status).toBe('tentative');
		expect(view.days[0].balanceCents).toBe(42_000);
		expect(view.days[0].events[0].amountCents).toBe(-5_000);
	});

	it('transmet todayIndex tel quel — la frontière réalisé/projeté ne doit jamais être redevinée côté vue', () => {
		expect.assertions(1);

		const forecast: CashFlowForecast = {
			flows: [],
			ledger: ledger(
				[
					{ date: '2025-03-30', balanceCents: 10_000, events: [] },
					{ date: '2025-03-31', balanceCents: 10_500, events: [] },
					{ date: '2025-04-01', balanceCents: 10_500, events: [] }
				],
				2
			),
			hasBalanceAnchor: true
		};

		expect(toDisplayCashFlowForecast(forecast).todayIndex).toBe(2);
	});
});

const dashboardModule = vi.hoisted(() => ({
	getCurrentMonth: vi.fn(() => '2025-04'),
	readDashboardDataForRange: vi.fn()
}));
const netWorthModule = vi.hoisted(() => ({ readNetWorthAccounts: vi.fn() }));
// Wraps the real detectRecurringFlows by default (existing tests keep exercising the actual
// classification logic unchanged) — only overridden per-test via mockReturnValueOnce, to get full
// deterministic control over a flow's status/confidence without having to hand-tune interval/amount
// coefficients of variation just to land on a given confidence tier.
const domainForecastModule = vi.hoisted(() => ({ detectRecurringFlows: vi.fn() }));

vi.mock('$lib/server/budget/dashboard', () => dashboardModule);
vi.mock('$lib/server/net-worth/service', () => netWorthModule);
vi.mock('$lib/domain/forecast', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/domain/forecast')>();
	domainForecastModule.detectRecurringFlows.mockImplementation(actual.detectRecurringFlows);
	return { ...actual, detectRecurringFlows: domainForecastModule.detectRecurringFlows };
});

describe('loadCashFlowForecast', () => {
	it('concatène le segment réalisé et le segment projeté sans dupliquer le jour "aujourd\'hui", et pointe todayIndex dessus', async () => {
		expect.assertions(3);
		vi.setSystemTime(new Date('2025-04-10T12:00:00.000Z'));

		dashboardModule.readDashboardDataForRange.mockResolvedValue({ transactions: [] });
		netWorthModule.readNetWorthAccounts.mockResolvedValue([
			{ type: 'checking', balanceCents: 100_000 }
		]);

		const { loadCashFlowForecast } = await import('./index');
		const forecast = await loadCashFlowForecast('user-1', 5);

		const today = forecast.ledger.days[forecast.ledger.todayIndex];
		expect(today.date).toBe('2025-04-10');
		expect(today.balanceCents).toBe(100_000);
		// Un seul jour "aujourd'hui" dans la série concaténée, jamais deux jours consécutifs à la
		// même date (ce qui trahirait un point dupliqué entre réalisé et projeté).
		expect(forecast.ledger.days.filter((day) => day.date === '2025-04-10')).toHaveLength(1);

		vi.useRealTimers();
	});

	it('exclut les flux confirmés de confiance faible du calcul de projection (jamais fed dans le solde)', async () => {
		expect.assertions(1);
		vi.setSystemTime(new Date('2025-04-10T12:00:00.000Z'));

		const lowConfidenceIncome = {
			label: 'VIREMENT INCERTAIN',
			type: 'income' as const,
			category: 'Revenus'
		};
		// 3 occurrences aux intervalles [14, 46] jours : médiane 30 -> fenêtre monthly (le flux EST
		// détecté et 'confirmed'), mais CV d'intervalle 0,53 (score 0) et montants 100/100/200
		// centimes — dans la tolérance plancher de regroupement (100c) mais CV de montant 0,35
		// (score 0) -> score global <= 0,35 -> confiance 'low', quel que soit le jour du mois.
		// (La fixture précédente — intervalles 42/46j hors de toute fenêtre de cadence — ne
		// produisait AUCUN flux : le test passait par vacuité sans exercer le filtre, constat de
		// l'audit de clôture.) Prochaine échéance si le flux était projeté à tort :
		// 2025-04-15 (ancre jour 15), dans l'horizon de 30 jours -> le solde final bougerait.
		dashboardModule.readDashboardDataForRange.mockResolvedValue({
			transactions: [
				{ ...lowConfidenceIncome, id: 'tx-low-1', date: '2025-01-15', amountCents: 100 },
				{ ...lowConfidenceIncome, id: 'tx-low-2', date: '2025-01-29', amountCents: 100 },
				{ ...lowConfidenceIncome, id: 'tx-low-3', date: '2025-03-16', amountCents: 200 }
			]
		});
		netWorthModule.readNetWorthAccounts.mockResolvedValue([{ type: 'checking', balanceCents: 0 }]);

		const { loadCashFlowForecast } = await import('./index');
		const forecast = await loadCashFlowForecast('user-1', 30);

		const lastDay = forecast.ledger.days[forecast.ledger.days.length - 1];
		// Si le flux à faible confiance était projeté, son échéance du 2025-04-15 (+133 en moyenne)
		// déplacerait le solde final. Ses transactions restent en revanche dans le pool résiduel
		// (correctif d'audit : un flux non projeté ne doit pas disparaître du calcul) — ici 3
		// semaines à +100/+200 sur ~52 semaines de lookback, médiane hebdomadaire 0 -> résiduel 0,
		// donc le solde final doit rester exactement à l'ancre.
		expect(lastDay.balanceCents).toBe(0);

		vi.useRealTimers();
	});

	it("fait contribuer au résiduel les transactions d'un flux détecté mais non projeté (tentative ou confirmed/low) — correctif d'audit", async () => {
		expect.assertions(2);
		vi.setSystemTime(new Date('2025-04-10T12:00:00.000Z'));

		// 12 mois de lookback -> fenêtre dense du 2024-04-10 (inclus) au 2025-04-10 (exclu), 365 jours.
		// Une "activité résiduelle dense" (dépense régulière plusieurs jours par semaine) : offsets
		// 0/2/4 de chaque cycle de 7 jours, -200c chacun -> exactement 3 transactions par bloc complet
		// de 7 jours, alignées sur les blocs de computeResidualDailyCents (qui découpe depuis l'indice
		// 0 == le premier jour de la fenêtre) -> somme hebdomadaire CONSTANTE de -600c sur les 52
		// semaines complètes (364 jours ; le 365e jour, surnuméraire, tombe dans la semaine partielle
		// ignorée par computeResidualDailyCents).
		const lookbackStartEpochDays = Date.UTC(2024, 3, 10) / 86_400_000;
		const denseResidualTransactions: {
			id: string;
			date: string;
			amountCents: number;
			label: string;
			category: string;
			type: 'income' | 'expense';
		}[] = [];
		for (let offset = 0; offset < 365; offset++) {
			if (offset % 7 === 0 || offset % 7 === 2 || offset % 7 === 4) {
				denseResidualTransactions.push({
					id: `tx-unrel-${offset}`,
					date: new Date((lookbackStartEpochDays + offset) * 86_400_000).toISOString().slice(0, 10),
					amountCents: -200,
					label: 'DEPENSE COURANTE INCERTAINE',
					category: 'Alimentation',
					type: 'expense'
				});
			}
		}

		// This entire batch IS the detected flow — 'confirmed' (>=3 occurrences) but 'low' confidence,
		// so isReliableConfirmedFlow rejects it: it is never projected as discrete occurrences, but
		// under the fix its transactions must stay in the residual pool (the pre-fix code removed
		// every detected flow's occurrenceIds unconditionally, which would have zeroed this activity
		// out of the calculation entirely).
		const unreliableFlow = flow({
			status: 'confirmed',
			confidence: 'low',
			cadence: 'weekly',
			occurrenceCount: denseResidualTransactions.length,
			occurrenceIds: denseResidualTransactions.map((transaction) => transaction.id)
		});
		domainForecastModule.detectRecurringFlows.mockReturnValueOnce([unreliableFlow]);

		dashboardModule.readDashboardDataForRange.mockResolvedValue({
			transactions: denseResidualTransactions
		});
		netWorthModule.readNetWorthAccounts.mockResolvedValue([
			{ type: 'checking', balanceCents: 100_000 }
		]);

		const { loadCashFlowForecast } = await import('./index');
		const forecast = await loadCashFlowForecast('user-1', 14);

		// Hand computation: weekly sum = 3 * -200 = -600 (identical every full week) -> median = -600
		// -> residualDailyCents = Math.round(-600 / 7) = Math.round(-85.714...) = -86.
		const expectedResidualDailyCents = -86;
		const todayDay = forecast.ledger.days[forecast.ledger.todayIndex];
		const lastDay = forecast.ledger.days[forecast.ledger.days.length - 1];

		// The anchor day itself must stay exactly the declarative NetWorthAccount total — the audit's
		// /net-worth consistency guarantee — regardless of any residual/flow math.
		expect(todayDay.balanceCents).toBe(100_000);
		// horizonDays=14, no projected event (the flow is excluded from confirmedFlows) -> the final
		// balance is purely anchor + horizonDays * residual.
		expect(lastDay.balanceCents).toBe(100_000 + 14 * expectedResidualDailyCents);

		vi.useRealTimers();
	});

	it('exclut toujours du résiduel les transactions d’un flux confirmé fiable (comportement inchangé par le correctif)', async () => {
		expect.assertions(1);
		vi.setSystemTime(new Date('2025-04-10T12:00:00.000Z'));

		// 3 grosses transactions, seule activité de la fenêtre : si elles restaient dans le résiduel
		// (régression), le résiduel serait massivement négatif et le solde final s'en écarterait.
		const bigTransactions = [
			{
				id: 'tx-big-1',
				date: '2024-06-01',
				amountCents: -100_000,
				label: 'GROS PRELEVEMENT',
				category: 'Logement',
				type: 'expense' as const
			},
			{
				id: 'tx-big-2',
				date: '2024-07-01',
				amountCents: -100_000,
				label: 'GROS PRELEVEMENT',
				category: 'Logement',
				type: 'expense' as const
			},
			{
				id: 'tx-big-3',
				date: '2024-08-01',
				amountCents: -100_000,
				label: 'GROS PRELEVEMENT',
				category: 'Logement',
				type: 'expense' as const
			}
		];

		// 'confirmed' + 'high' -> isReliableConfirmedFlow accepts it -> its occurrenceIds leave the
		// residual pool exactly like before the fix. anchorDayOfMonth=1/lastDate=2025-02-01 with a
		// short 5-day horizon from 2025-04-10 means its next projected occurrence (2025-05-01) falls
		// outside the horizon — no ledger event, isolating the residual-exclusion effect being tested.
		const reliableFlow = flow({
			status: 'confirmed',
			confidence: 'high',
			cadence: 'monthly',
			direction: 'expense',
			occurrenceCount: 3,
			averageAmountCents: 100_000,
			lastDate: '2025-02-01',
			anchorDayOfMonth: 1,
			occurrenceIds: ['tx-big-1', 'tx-big-2', 'tx-big-3']
		});
		domainForecastModule.detectRecurringFlows.mockReturnValueOnce([reliableFlow]);

		dashboardModule.readDashboardDataForRange.mockResolvedValue({ transactions: bigTransactions });
		netWorthModule.readNetWorthAccounts.mockResolvedValue([
			{ type: 'checking', balanceCents: 50_000 }
		]);

		const { loadCashFlowForecast } = await import('./index');
		const forecast = await loadCashFlowForecast('user-1', 5);

		const lastDay = forecast.ledger.days[forecast.ledger.days.length - 1];
		// residualTransactions is empty (all 3 excluded) -> residual = 0, and no event lands within the
		// horizon -> the final balance must equal the anchor exactly.
		expect(lastDay.balanceCents).toBe(50_000);

		vi.useRealTimers();
	});

	// Detection-window upper bound (task 1). `to` used to be `today` — `new Date()`, WITH the
	// time-of-day the request happened to run at — not `detectionEndExclusive(todayIso)`, midnight
	// UTC of the day after. A transaction dated today but stored with a later clock time than the
	// request (an evening purchase, a request that ran at 00:05) was silently excluded from the
	// detector's input while the realized ledger (ISO-date based) already counted it.
	it("fetches up to detectionEndExclusive(todayIso), not `now`: a same-day transaction later than the request's own clock time is not dropped", async () => {
		expect.assertions(1);
		// The fake "now" is 09:00 UTC; the transaction below is dated the same calendar day but
		// stored at 21:00 UTC — later than "now", so `to: today` (a Date with today's time-of-day)
		// would have excluded it while `to: detectionEndExclusive(todayIso)` does not.
		vi.setSystemTime(new Date('2025-04-10T09:00:00.000Z'));

		dashboardModule.readDashboardDataForRange.mockResolvedValue({ transactions: [] });
		netWorthModule.readNetWorthAccounts.mockResolvedValue([]);

		const { loadCashFlowForecast } = await import('./index');
		await loadCashFlowForecast('user-1', 5);

		// `.at(-1)`, not `[0]`: this file's mocks are never cleared between tests, so `mock.calls`
		// accumulates every prior test's call — only the LAST one is this test's own.
		const calls = dashboardModule.readDashboardDataForRange.mock.calls;
		const call = calls[calls.length - 1][1] as { to: Date };
		expect(call.to.toISOString()).toBe(detectionEndExclusive('2025-04-10').toISOString());

		vi.useRealTimers();
	});
});
