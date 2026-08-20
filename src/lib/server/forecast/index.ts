import {
	buildDenseDailyNetSeries,
	buildRealizedLedgerDays,
	computeResidualDailyCents,
	detectionEndExclusive,
	detectRecurringFlows,
	feedsCashFlowProjection,
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
	/** The "today" this forecast was computed against — carried alongside the flows so
	 *  `toDisplayCashFlowForecast` can re-derive `isStreamStale` per flow without a second
	 *  `new Date()` read (a second clock read is exactly the kind of drift this codebase avoids
	 *  elsewhere, see `detectionEndExclusive`'s own reasoning). */
	todayIso: string;
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
			// Exclusive upper bound pinned to `detectionEndExclusive`, not `today` (a Date carrying
			// the request's own time-of-day): every detector call site uses the same value, and a
			// transaction dated today is now counted regardless of what time today's request runs at.
			to: detectionEndExclusive(todayIso),
			budgetMonth: getCurrentMonth()
		}),
		resolveStartingBalance(userId)
	]);

	const flows = detectRecurringFlows(transactions);
	// Only reliable confirmed flows (>=3 occurrences AND confidence high/medium) ever feed the
	// projection math — a shaky confirmed flow shouldn't move the projected balance any more than
	// it should appear in a table claiming to list what was "included in the calculation". A
	// reliable flow that has gone quiet for longer than one tolerated cycle (`isStreamStale`, the
	// same B1 guard the upcoming-bills surfaces apply) is excluded here too: it is detected and
	// reliable, but it will never produce another payment, so projecting it would keep a cancelled
	// stream on the balance line after the bills surfaces have already stopped showing it.
	// `confirmedFlows` and the view's `feedsProjection` flag below both go through the single
	// `feedsCashFlowProjection` predicate, so the two can never independently drift apart.
	const reliableFlows = flows.filter(isReliableConfirmedFlow);
	const confirmedFlows = flows.filter((flow) => feedsCashFlowProjection(flow, todayIso));

	// Three cases for a flow's transactions, not two:
	//  - Reliable AND not stale: feeds the projection (`confirmedFlows` above) — its transactions
	//    leave the residual pool, or the projected event would double-count the same money.
	//  - Tentative or low-confidence (never reliable): never projected as discrete occurrences, so
	//    its activity must stay in the residual daily term — removing it too would make that money
	//    vanish from the forecast entirely (closing-audit finding: systematically optimistic for
	//    expenses).
	//  - Reliable AND stale: neither. Its whole defining property is that the activity has STOPPED,
	//    so leaving its past payments in the residual daily average would keep the forecast
	//    spending money the user no longer spends — the cancelled stream would still "include"
	//    itself through the back door, exactly what the stale-guard above must eliminate. Excluded
	//    from the residual pool via `reliableFlows` (not `confirmedFlows`, which already dropped the
	//    stale ones) so this exclusion happens regardless of staleness.
	//    Note that `computeResidualDailyCents` is a MEDIAN over ~52 weekly sums, not a mean: this
	//    exclusion is always correct for the POOL (the stale flow's transactions never reach it),
	//    but a stale stream whose payments occupied fewer than half the lookback's weeks may not
	//    have moved the resulting figure either way, guard or no guard — the exclusion still matters
	//    whenever it does move it, and for the residual pool's own correctness regardless.
	const recurringTransactionIds = new Set(reliableFlows.flatMap((flow) => flow.occurrenceIds));
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

	return {
		flows,
		ledger: { days, todayIndex },
		hasBalanceAnchor: startingBalance.hasAnchor,
		todayIso
	};
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
	/** Stable per-flow identity for the client — the flow's most recent occurrence id, the same
	 *  anchor `RecurringStreamAction.anchorTransactionIds` and `resolveLastOccurrence` already use.
	 *
	 *  NOT `RecurringFlow.key`, and that distinction is the whole reason this field exists: `key` is
	 *  direction + normalized merchant + category, and `getSimilarAmountGroups` splits ONE such group
	 *  into one flow per amount band, so several flows legitimately share a key — along with `label`,
	 *  `category` and `direction`, which they all inherit from the same group. A route keying an
	 *  `#each` on any combination of those renders a duplicate key, which Svelte 5 throws on at
	 *  runtime IN PRODUCTION BUILDS and which tears down the hydrated tree: /reports went blank.
	 *  `occurrenceIds` are disjoint across flows by construction (the split partitions the group), so
	 *  this is unique without needing a positional index. */
	id: string;
	category: string;
	direction: FlowDirection;
	cadence: FlowCadence;
	status: FlowOccurrenceStatus;
	confidence: FlowConfidenceTier;
	label: string;
	averageAmountCents: number;
	lastDate: string;
	/** Whether THIS flow actually feeds the projection ledger's math right now — the server's own
	 *  `feedsCashFlowProjection` predicate, computed once here rather than re-implemented
	 *  client-side. A route's "included in the calculation" table must filter on this field, never
	 *  re-run `isReliableConfirmedFlow` alone: a reliable flow that has gone stale is excluded from
	 *  the ledger but would still pass that narrower check, which is exactly the divergence this
	 *  field exists to close (a client can't recompute staleness itself — this view intentionally
	 *  does not carry `medianIntervalDays`/`intervalCoefficientOfVariation`). */
	feedsProjection: boolean;
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

/**
 * Distinguishes the two reasons `flows.every(f => !f.feedsProjection)` can hold, so a route can
 * render the right empty-state copy instead of one sentence that only describes one of them:
 *  - 'none-detected': no flow ever reached reliable-confirmed (the pre-existing "not enough
 *    recurring flows yet" copy still applies).
 *  - 'all-stale': at least one flow IS reliable-confirmed, but every one of them has gone stale
 *    (`isStreamStale`) — the count condition is satisfied, staleness is the actual reason, and
 *    the pre-existing copy's remedy ("wait for more occurrences") cannot help.
 * `null` when a live reliable-confirmed flow exists (`feedsProjection` true on at least one
 * flow) — the empty state isn't rendered at all in that case, so callers only need to switch on
 * this value inside their `emptyState !== null` branch.
 * Computed here, from the exact same inputs `feedsProjection` uses per flow, so the two can never
 * drift apart the way the single collapsed boolean did.
 */
export type CashFlowForecastEmptyState = 'none-detected' | 'all-stale';

export interface CashFlowForecastView {
	hasBalanceAnchor: boolean;
	days: CashFlowLedgerDayView[];
	/** Index within `days` of "today" — see CashFlowLedger.todayIndex. */
	todayIndex: number;
	flows: CashFlowForecastFlowView[];
	/** See `CashFlowForecastEmptyState`. `null` when at least one flow currently feeds the
	 *  projection (`flows.some(f => f.feedsProjection)` is true). */
	emptyState: CashFlowForecastEmptyState | null;
}

export function toDisplayCashFlowForecast(forecast: CashFlowForecast): CashFlowForecastView {
	const flows = forecast.flows.map((flow) => ({
		id: flow.occurrenceIds[flow.occurrenceIds.length - 1],
		category: flow.category,
		direction: flow.direction,
		cadence: flow.cadence,
		status: flow.status,
		confidence: flow.confidence,
		label: anonymizeLabel(flow.label, flow.category),
		averageAmountCents: flow.averageAmountCents,
		lastDate: flow.lastDate,
		feedsProjection: feedsCashFlowProjection(flow, forecast.todayIso)
	}));

	const hasLiveConfirmedFlow = flows.some((flow) => flow.feedsProjection);
	const emptyState: CashFlowForecastEmptyState | null = hasLiveConfirmedFlow
		? null
		: forecast.flows.some(isReliableConfirmedFlow)
			? 'all-stale'
			: 'none-detected';

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
		flows,
		emptyState
	};
}
