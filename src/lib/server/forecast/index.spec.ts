import { describe, expect, it, vi } from 'vitest';
import type { RecurringFlow, ProjectedOccurrence } from '$lib/domain/forecast';
import {
	computeStaleAfterDays,
	isReliableConfirmedFlow,
	projectFlowOccurrences
} from '$lib/domain/forecast';
import { buildBillOccurrences } from '$lib/domain/upcomingBills';
import {
	FORECAST_REPORTS_HORIZON_DAYS,
	FORECAST_REPORTS_HORIZON_MONTHS,
	toDisplayCashFlowForecast,
	type CashFlowForecast,
	type CashFlowLedger
} from './index';

function addDaysIso(iso: string, days: number): string {
	return new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + days * 86_400_000)
		.toISOString()
		.slice(0, 10);
}

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
	//
	// Fix round 1: the previous version of this test only asserted the `to` ARGUMENT against
	// `detectionEndExclusive('2025-04-10')` — the production helper compared to itself, which
	// cannot fail on a wrong helper — and never exercised an actual transaction. This version
	// makes the mocked `readDashboardDataForRange` apply the SAME `lt` semantics the real Prisma
	// query does (filter by `< to`), so the assertion below is a genuine behavioural check: it
	// fails if `to` regresses to `today` (09:00), because the mock's own gate would then exclude
	// the 21:00 transaction.
	it("reaches a same-day transaction stored later than the request's own clock time (fetch bound is detectionEndExclusive, not `now`)", async () => {
		expect.assertions(3);
		// The fake "now" is 09:00 UTC; the transaction below is dated the same calendar day but
		// stored at 21:00 UTC — later than "now", so `to: today` (a Date with today's time-of-day)
		// would have excluded it while `to: detectionEndExclusive(todayIso)` (2025-04-11T00:00:00Z)
		// does not.
		vi.setSystemTime(new Date('2025-04-10T09:00:00.000Z'));
		const lateSameDayInstant = new Date('2025-04-10T21:00:00.000Z');

		dashboardModule.readDashboardDataForRange.mockImplementation(
			async (_userId: string, range: { to: Date }) => {
				// Mirrors the real Prisma `date: { lt: range.to }` filter the mocked-away
				// `readDashboardDataForRange` would otherwise apply, using the transaction's full
				// timestamp — not just its calendar date — exactly the precision this bug turns on.
				const reached = lateSameDayInstant < range.to;
				return {
					transactions: reached
						? [
								{
									id: 'tx-late-same-day',
									date: '2025-04-10',
									label: 'ACHAT TARDIF',
									amountCents: -500,
									category: 'Shopping',
									type: 'expense' as const
								}
							]
						: []
				};
			}
		);
		netWorthModule.readNetWorthAccounts.mockResolvedValue([
			{ type: 'checking', balanceCents: 100_000 }
		]);

		const { loadCashFlowForecast } = await import('./index');
		const forecast = await loadCashFlowForecast('user-1', 5);

		// `to` itself, pinned to the LITERAL boundary — not `detectionEndExclusive('2025-04-10')`
		// again, which would compare the production value to itself and could never catch a broken
		// helper (round-1 review finding, MINOR #3).
		const calls = dashboardModule.readDashboardDataForRange.mock.calls;
		const call = calls[calls.length - 1][1] as { to: Date };
		expect(call.to.toISOString()).toBe('2025-04-11T00:00:00.000Z');

		// The transaction landed "today", so its effect is only visible on the day BEFORE today in
		// the realized ledger's backward walk (buildRealizedLedgerDays anchors the LAST day exactly
		// on the known ending balance, by construction — see that function's own doc comment — so
		// `todayDay.balanceCents` is always 100_000 regardless of any transaction and asserting it
		// would prove nothing). Under the old `to: today` (09:00) bound, the mock above would have
		// excluded this row entirely and this balance would read 100_000, not 100_500.
		const todayIndex = forecast.ledger.todayIndex;
		expect(forecast.ledger.days[todayIndex].date).toBe('2025-04-10');
		expect(forecast.ledger.days[todayIndex - 1].balanceCents).toBe(100_000 - -500);

		vi.useRealTimers();
	});
});

// Task 2 of the detection-window-upper-bound chantier: `isStreamStale` (B1's staleness guard for
// the upcoming-bills surfaces) now also applies to the cash-flow forecast, so a cancelled
// subscription cannot still move the projected balance line after the bills surfaces have already
// stopped showing it. Uses the REAL `detectRecurringFlows` (the default `domainForecastModule`
// wiring above), not a hand-built RecurringFlow, so a test can assert the flow was genuinely
// DETECTED as reliable-confirmed and not merely constructed to look that way.
describe('loadCashFlowForecast — stale stream guard (B1 applied to the forecast)', () => {
	const TODAY_ISO = '2025-04-10';

	// Perfectly regular (CV 0) monthly stream -> staleAfterDays = 30 + 5 + 0 = 35. Derived from the
	// production formula, not hardcoded, per the brief.
	const STALE_AFTER_DAYS = computeStaleAfterDays({
		cadence: 'monthly',
		medianIntervalDays: 30,
		intervalCoefficientOfVariation: 0
	});

	function monthlyExpenseTransactions(lastDateIso: string) {
		return [-150, -120, -90, -60, -30, 0].map((offset, index) => ({
			id: `tx-netflix-${index}`,
			date: addDaysIso(lastDateIso, offset),
			label: 'NETFLIX',
			amountCents: -1_399,
			category: 'Abonnements',
			type: 'expense' as const
		}));
	}

	it('drops a cancelled stream from the projected ledger and moves the end-of-horizon balance up by the expense no longer projected', async () => {
		expect.assertions(6);
		vi.setSystemTime(new Date(`${TODAY_ISO}T12:00:00.000Z`));

		// Well past the tolerated cycle: silent for STALE_AFTER_DAYS + 2 days.
		const staleLastDate = addDaysIso(TODAY_ISO, -(STALE_AFTER_DAYS + 2));
		const transactions = monthlyExpenseTransactions(staleLastDate);

		dashboardModule.readDashboardDataForRange.mockResolvedValue({ transactions });
		netWorthModule.readNetWorthAccounts.mockResolvedValue([
			{ type: 'checking', balanceCents: 100_000 }
		]);

		const { loadCashFlowForecast } = await import('./index');
		const forecast = await loadCashFlowForecast('user-1', 60);

		// The flow really is detected, and really does qualify as reliable-confirmed — otherwise a
		// "no events" assertion below would also pass if the fixture silently produced no flow, or a
		// tentative/low-confidence one, at all.
		const detected = forecast.flows.find((candidate) => candidate.label === 'NETFLIX');
		expect(detected).toBeDefined();
		expect(detected && isReliableConfirmedFlow(detected)).toBe(true);

		// Sanity: the RAW stepping function (unaffected by this task) would still have produced an
		// occurrence inside the horizon, proving the guard — not an absence of anything to project —
		// is what removes the event below.
		expect(detected ? projectFlowOccurrences(detected, TODAY_ISO, 60).length : 0).toBeGreaterThan(
			0
		);

		const netflixEvents = forecast.ledger.days.flatMap((day) =>
			day.events.filter((event) => event.flowLabel === 'NETFLIX')
		);
		expect(netflixEvents).toHaveLength(0);

		// No projection and no residual (the flow's own transactions are excluded from the residual
		// pool too, see the dedicated residual test below) -> the balance stays exactly at the anchor.
		const lastDay = forecast.ledger.days[forecast.ledger.days.length - 1];
		expect(lastDay.balanceCents).toBe(100_000);
		// Direction check: had the stream still been projected (its pre-fix behaviour), the expense
		// would have been subtracted once from the final balance.
		expect(lastDay.balanceCents).not.toBe(100_000 - 1_399);

		vi.useRealTimers();
	});

	it('leaves a live stream (recently active) untouched — same projected event count as the raw stepping function', async () => {
		expect.assertions(3);
		vi.setSystemTime(new Date(`${TODAY_ISO}T12:00:00.000Z`));

		// Comfortably inside the tolerated cycle: silent for only 10 days.
		const liveLastDate = addDaysIso(TODAY_ISO, -10);
		const transactions = monthlyExpenseTransactions(liveLastDate);

		dashboardModule.readDashboardDataForRange.mockResolvedValue({ transactions });
		netWorthModule.readNetWorthAccounts.mockResolvedValue([
			{ type: 'checking', balanceCents: 100_000 }
		]);

		const { loadCashFlowForecast } = await import('./index');
		const forecast = await loadCashFlowForecast('user-1', 60);

		const detected = forecast.flows.find((candidate) => candidate.label === 'NETFLIX');
		expect(detected).toBeDefined();

		const expectedEventCount = detected
			? projectFlowOccurrences(detected, TODAY_ISO, 60).length
			: 0;
		expect(expectedEventCount).toBeGreaterThan(0);

		const netflixEvents = forecast.ledger.days.flatMap((day) =>
			day.events.filter((event) => event.flowLabel === 'NETFLIX')
		);
		expect(netflixEvents).toHaveLength(expectedEventCount);

		vi.useRealTimers();
	});

	it('agrees with the upcoming-bills surface: the same stale stream disappears from both', async () => {
		expect.assertions(3);
		vi.setSystemTime(new Date(`${TODAY_ISO}T12:00:00.000Z`));

		const staleLastDate = addDaysIso(TODAY_ISO, -(STALE_AFTER_DAYS + 2));
		const transactions = monthlyExpenseTransactions(staleLastDate);

		dashboardModule.readDashboardDataForRange.mockResolvedValue({ transactions });
		netWorthModule.readNetWorthAccounts.mockResolvedValue([
			{ type: 'checking', balanceCents: 100_000 }
		]);

		const { loadCashFlowForecast } = await import('./index');
		const forecast = await loadCashFlowForecast('user-1', 60);
		const detected = forecast.flows.find((candidate) => candidate.label === 'NETFLIX');
		expect(detected).toBeDefined();

		// The bills surface: already drops a stale stream from projection (pre-existing B1 guard).
		const billOccurrences = detected
			? buildBillOccurrences({
					flows: [detected],
					transactions,
					actions: [],
					fromIso: TODAY_ISO,
					toIsoExclusive: addDaysIso(TODAY_ISO, 60),
					todayIso: TODAY_ISO
				})
			: [];
		expect(billOccurrences).toEqual([]);

		// The forecast: this task's new guard.
		const netflixEvents = forecast.ledger.days.flatMap((day) =>
			day.events.filter((event) => event.flowLabel === 'NETFLIX')
		);
		expect(netflixEvents).toHaveLength(0);

		vi.useRealTimers();
	});

	it("excludes a stale stream's transactions from the residual pool too — the projected slope is identical to a user who never had the stream", async () => {
		expect.assertions(1);
		vi.setSystemTime(new Date(`${TODAY_ISO}T12:00:00.000Z`));

		// Dense weekly activity (3 transactions every 7-day block, -200c each) but stopping 65 days
		// before "today" — well past staleAfterDays for a weekly stream (7 + 2 + 0 = 9) — attributed
		// to a mocked 'confirmed'/'high' (reliable) flow. A SPARSE fixture (like the monthly one used
		// above) would not expose a residual leak: with only ~6 transactions spread across 12 months,
		// most weekly sums in computeResidualDailyCents' dense series are already zero, so the median
		// stays 0 whether or not the leak exists — that gap is exactly why this test uses a dense
		// fixture instead of reusing monthlyExpenseTransactions.
		const lookbackStartEpochDays = Date.UTC(2024, 3, 10) / 86_400_000;
		const denseStaleTransactions: {
			id: string;
			date: string;
			amountCents: number;
			label: string;
			category: string;
			type: 'income' | 'expense';
		}[] = [];
		for (let offset = 0; offset < 300; offset++) {
			if (offset % 7 === 0 || offset % 7 === 2 || offset % 7 === 4) {
				denseStaleTransactions.push({
					id: `tx-stale-dense-${offset}`,
					date: new Date((lookbackStartEpochDays + offset) * 86_400_000).toISOString().slice(0, 10),
					amountCents: -200,
					label: 'ABONNEMENT ANNULE',
					category: 'Abonnements',
					type: 'expense'
				});
			}
		}
		const staleReliableFlow: RecurringFlow = {
			key: 'expense:abonnement annule:Abonnements',
			label: 'ABONNEMENT ANNULE',
			category: 'Abonnements',
			direction: 'expense',
			cadence: 'weekly',
			status: 'confirmed',
			confidence: 'high',
			occurrenceCount: denseStaleTransactions.length,
			averageAmountCents: 200,
			minAmountCents: 200,
			maxAmountCents: 200,
			medianIntervalDays: 7,
			intervalCoefficientOfVariation: 0,
			amountCoefficientOfVariation: 0,
			dayOfMonthConcentration: 1,
			// 300 days after the lookback start, i.e. 65 days before TODAY_ISO (12-month lookback):
			// isStreamStale is true (65 > 9).
			lastDate: denseStaleTransactions[denseStaleTransactions.length - 1].date,
			anchorDayOfMonth: 1,
			occurrenceIds: denseStaleTransactions.map((transaction) => transaction.id)
		};

		domainForecastModule.detectRecurringFlows.mockReturnValueOnce([staleReliableFlow]);
		dashboardModule.readDashboardDataForRange.mockResolvedValue({
			transactions: denseStaleTransactions
		});
		netWorthModule.readNetWorthAccounts.mockResolvedValue([
			{ type: 'checking', balanceCents: 100_000 }
		]);
		const { loadCashFlowForecast } = await import('./index');
		const forecastWithStaleStream = await loadCashFlowForecast('user-1', 14);

		domainForecastModule.detectRecurringFlows.mockReturnValueOnce([]);
		dashboardModule.readDashboardDataForRange.mockResolvedValue({ transactions: [] });
		const forecastWithNoActivity = await loadCashFlowForecast('user-1', 14);

		const lastWithStream =
			forecastWithStaleStream.ledger.days[forecastWithStaleStream.ledger.days.length - 1];
		const lastWithNoActivity =
			forecastWithNoActivity.ledger.days[forecastWithNoActivity.ledger.days.length - 1];
		// If the stale flow's transactions leaked back into the residual pool, this would differ —
		// the residual daily average would be pulled negative by the flow's own past payments.
		expect(lastWithStream.balanceCents).toBe(lastWithNoActivity.balanceCents);

		vi.useRealTimers();
	});

	it("still feeds the residual pool from a tentative flow's transactions — the existing invariant this task must not break", async () => {
		expect.assertions(1);
		vi.setSystemTime(new Date(`${TODAY_ISO}T12:00:00.000Z`));

		// Dense weekly activity (3 transactions every 7-day block, -200c each) over the full 12-month
		// lookback, attributed to a mocked 'tentative' flow — isReliableConfirmedFlow rejects a
		// tentative flow regardless of staleness, so this must land in the residual pool exactly as
		// it did before this task.
		const lookbackStartEpochDays = Date.UTC(2024, 3, 10) / 86_400_000;
		const denseTentativeTransactions: {
			id: string;
			date: string;
			amountCents: number;
			label: string;
			category: string;
			type: 'income' | 'expense';
		}[] = [];
		for (let offset = 0; offset < 365; offset++) {
			if (offset % 7 === 0 || offset % 7 === 2 || offset % 7 === 4) {
				denseTentativeTransactions.push({
					id: `tx-tentative-${offset}`,
					date: new Date((lookbackStartEpochDays + offset) * 86_400_000).toISOString().slice(0, 10),
					amountCents: -200,
					label: 'DEPENSE COURANTE TENTATIVE',
					category: 'Alimentation',
					type: 'expense'
				});
			}
		}

		const tentativeFlow: RecurringFlow = {
			key: 'expense:depense courante tentative:Alimentation',
			label: 'DEPENSE COURANTE TENTATIVE',
			category: 'Alimentation',
			direction: 'expense',
			cadence: 'weekly',
			status: 'tentative',
			confidence: 'high',
			occurrenceCount: 2,
			averageAmountCents: 200,
			minAmountCents: 200,
			maxAmountCents: 200,
			medianIntervalDays: 7,
			intervalCoefficientOfVariation: 0,
			amountCoefficientOfVariation: 0,
			dayOfMonthConcentration: 1,
			lastDate: denseTentativeTransactions[denseTentativeTransactions.length - 1].date,
			anchorDayOfMonth: 1,
			occurrenceIds: denseTentativeTransactions.map((transaction) => transaction.id)
		};

		domainForecastModule.detectRecurringFlows.mockReturnValueOnce([tentativeFlow]);

		dashboardModule.readDashboardDataForRange.mockResolvedValue({
			transactions: denseTentativeTransactions
		});
		netWorthModule.readNetWorthAccounts.mockResolvedValue([
			{ type: 'checking', balanceCents: 100_000 }
		]);

		const { loadCashFlowForecast } = await import('./index');
		const forecast = await loadCashFlowForecast('user-1', 14);

		// Hand computation, identical to the pre-existing residual test's fixture shape: weekly sum
		// = 3 * -200 = -600 (constant) -> median = -600 -> residualDailyCents = round(-600/7) = -86.
		const expectedResidualDailyCents = -86;
		const lastDay = forecast.ledger.days[forecast.ledger.days.length - 1];
		expect(lastDay.balanceCents).toBe(100_000 + 14 * expectedResidualDailyCents);

		vi.useRealTimers();
	});
});
