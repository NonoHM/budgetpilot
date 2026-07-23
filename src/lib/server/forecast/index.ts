import {
	buildDenseDailyNetSeries,
	buildRealizedLedgerDays,
	computeResidualDailyCents,
	detectRecurringFlows,
	isReliableConfirmedFlow,
	projectCashFlow,
	type CashFlowLedgerDay,
	type FlowCadence,
	type FlowConfidenceTier,
	type FlowDirection,
	type FlowOccurrenceStatus,
	type RecurringFlow
} from '$lib/domain/forecast';
import { getCurrentMonth, readDashboardDataForRange } from '$lib/server/budget/dashboard';
import { readNetWorthAccounts } from '$lib/server/net-worth/service';
import { anonymizeLabel } from '$lib/server/reports/monthly';

/**
 * How far back recurring flows are detected from. 12 months is the floor for confirming a
 * quarterly cadence (4 occurrences) and the ceiling for what an annual cadence can ever reach
 * within this window (at most 2 occurrences — always 'tentative', see domain/forecast.spec.ts).
 */
export const FORECAST_LOOKBACK_MONTHS = 12;

/** /reports' forecast horizon — a fixed ~3 months, independent of the report's own period
 *  selector (same "independent of the period selector" rule as the dashboard's insights). */
export const FORECAST_REPORTS_HORIZON_DAYS = 90;

/** Rounded month count derived from FORECAST_REPORTS_HORIZON_DAYS, for display only —
 *  keeps the UI label in sync if the horizon ever changes. */
export const FORECAST_REPORTS_HORIZON_MONTHS = Math.round(FORECAST_REPORTS_HORIZON_DAYS / 30);

export interface CashFlowLedger {
	/** Realized days (oldest first) up to and including "today", followed by the projected days. */
	days: CashFlowLedgerDay[];
	/** Index within `days` of "today" — the explicit realized/projected boundary. Computed here
	 *  once rather than re-derived from dates by every caller/component (see the design-audit fix
	 *  this closes: a component-side guess at "today" is exactly the kind of drift this avoids). */
	todayIndex: number;
}

export interface CashFlowForecast {
	/** Every detected flow (confirmed AND tentative) — the tentative ones are shown as "à confirmer", never fed into the ledger. */
	flows: RecurringFlow[];
	ledger: CashFlowLedger;
	/** False when no checking NetWorthAccount exists — the ledger then starts at a relative 0 (net projected flow), never a fabricated balance. */
	hasBalanceAnchor: boolean;
}

export async function loadCashFlowForecast(
	userId: string,
	horizonDays: number
): Promise<CashFlowForecast> {
	const today = new Date();
	const todayIso = today.toISOString().slice(0, 10);
	const lookbackStart = new Date(
		Date.UTC(
			today.getUTCFullYear(),
			today.getUTCMonth() - FORECAST_LOOKBACK_MONTHS,
			today.getUTCDate()
		)
	);

	const [{ transactions }, startingBalance] = await Promise.all([
		readDashboardDataForRange(userId, {
			from: lookbackStart,
			to: today,
			budgetMonth: getCurrentMonth()
		}),
		resolveStartingBalance(userId)
	]);

	const flows = detectRecurringFlows(transactions);
	// Only reliable confirmed flows (>=3 occurrences AND confidence high/medium) ever feed the
	// projection math — a shaky confirmed flow shouldn't move the projected balance any more than
	// it should appear in a table claiming to list what was "included in the calculation".
	const confirmedFlows = flows.filter(isReliableConfirmedFlow);

	// Only the transactions of flows that ACTUALLY feed the projection leave the residual pool. A
	// tentative or low-confidence flow is never projected as discrete occurrences, so its activity
	// must stay in the residual daily term — removing it as well would make that money vanish from
	// the forecast entirely (closing-audit finding: systematically optimistic for expenses).
	const recurringTransactionIds = new Set(confirmedFlows.flatMap((flow) => flow.occurrenceIds));
	const residualTransactions = transactions.filter(
		(transaction) => !recurringTransactionIds.has(transaction.id)
	);
	const dailySeries = buildDenseDailyNetSeries(
		residualTransactions,
		lookbackStart.toISOString().slice(0, 10),
		todayIso
	);
	const residualDailyCents = computeResidualDailyCents(dailySeries);

	const projected = projectCashFlow({
		confirmedFlows,
		residualDailyCents,
		startingBalanceCents: startingBalance.balanceCents,
		fromDate: todayIso,
		horizonDays
	});

	// Realized segment mirrors the projected horizon's length (same number of days looking back as
	// forward) — a simple, symmetric choice absent a distinct spec value. Uses every actual
	// transaction (recurring included), not the residual-only subset the projection's daily-average
	// math uses — the realized balance must reflect everything that really happened.
	// ASSUMED LIMITATION (closing audit, deliberate — do not "fix" without a product decision):
	// ALL of the user's transactions are subtracted from a checking-only anchor, so for a
	// multi-account user whose import buckets are linked to savings/investment NetWorthAccounts the
	// reconstructed history can diverge from the real checking history. Accepted as consistent with
	// /net-worth's declarative philosophy (minority case); Account.netWorthAccountId is deliberately
	// NOT used to filter transactions here.
	const realizedDays = buildRealizedLedgerDays(
		transactions,
		startingBalance.balanceCents,
		todayIso,
		horizonDays
	);
	// realizedDays' last day and projected.days[0] are the same "today" anchor (same date, same
	// balance, projectCashFlow's own day 0) — drop the duplicate before concatenating.
	const days = [...realizedDays.slice(0, -1), ...projected.days];
	const todayIndex = realizedDays.length - 1;

	return { flows, ledger: { days, todayIndex }, hasBalanceAnchor: startingBalance.hasAnchor };
}

/**
 * Anchors the ledger on the sum of the user's checking NetWorthAccounts (the only type that
 * plausibly represents "the money the forecast is about" — savings/investment/debt accounts
 * aren't day-to-day cash). Falls back to a relative 0 starting point (not a fabricated real
 * balance) when none exists — the app has no other opening-balance anchor to derive one from
 * (see the net-worth "derive balance from transactions" idea, explicitly dropped — CLAUDE.md).
 */
async function resolveStartingBalance(
	userId: string
): Promise<{ balanceCents: number; hasAnchor: boolean }> {
	const accounts = await readNetWorthAccounts(userId);
	const checkingAccounts = accounts.filter((account) => account.type === 'checking');
	if (checkingAccounts.length === 0) return { balanceCents: 0, hasAnchor: false };

	return {
		balanceCents: checkingAccounts.reduce((sum, account) => sum + account.balanceCents, 0),
		hasAnchor: true
	};
}

// ─── Display view (anonymized) ──────────────────────────────────────────────
// Single place where a raw label ever gets anonymized before reaching a route's `load` return
// (and therefore the client) — mirrors getRecurringPayments' own anonymization boundary. Both
// the dashboard and /reports must go through this, never read CashFlowForecast.flows/ledger
// directly for display.

export interface CashFlowForecastFlowView {
	category: string;
	direction: FlowDirection;
	cadence: FlowCadence;
	status: FlowOccurrenceStatus;
	confidence: FlowConfidenceTier;
	label: string;
	averageAmountCents: number;
	lastDate: string;
}

export interface CashFlowLedgerEventView {
	amountCents: number;
	label: string;
	cadence: FlowCadence;
}

export interface CashFlowLedgerDayView {
	date: string;
	balanceCents: number;
	events: CashFlowLedgerEventView[];
}

export interface CashFlowForecastView {
	hasBalanceAnchor: boolean;
	days: CashFlowLedgerDayView[];
	/** Index within `days` of "today" — see CashFlowLedger.todayIndex. */
	todayIndex: number;
	flows: CashFlowForecastFlowView[];
}

export function toDisplayCashFlowForecast(forecast: CashFlowForecast): CashFlowForecastView {
	return {
		hasBalanceAnchor: forecast.hasBalanceAnchor,
		todayIndex: forecast.ledger.todayIndex,
		days: forecast.ledger.days.map((day) => ({
			date: day.date,
			balanceCents: day.balanceCents,
			events: day.events.map((event) => ({
				amountCents: event.amountCents,
				label: anonymizeLabel(event.flowLabel, event.flowCategory),
				cadence: event.cadence
			}))
		})),
		flows: forecast.flows.map((flow) => ({
			category: flow.category,
			direction: flow.direction,
			cadence: flow.cadence,
			status: flow.status,
			confidence: flow.confidence,
			label: anonymizeLabel(flow.label, flow.category),
			averageAmountCents: flow.averageAmountCents,
			lastDate: flow.lastDate
		}))
	};
}
