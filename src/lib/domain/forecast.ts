import type { Transaction, TransactionNature } from './transaction';
import { getTransactionKind } from './transaction';
import { getSimilarAmountGroups, normalizeRecurringLabel } from './recurrence';

export type FlowDirection = 'income' | 'expense';
export type FlowCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
export type FlowConfidenceTier = 'low' | 'medium' | 'high';
export type FlowOccurrenceStatus = 'confirmed' | 'tentative';

export interface RecurringFlow {
	/** Internal grouping identity (direction + normalized merchant + category) — not for display. */
	key: string;
	/** Raw (non-anonymized) label of the most recent occurrence — anonymization is the server/UI's job. */
	label: string;
	category: string;
	/**
	 * Analytical nature of the most recent occurrence — DISPLAY ONLY, and deliberately so.
	 *
	 * Nothing in detection, projection or the totals reads it: grouping is direction + normalized
	 * label + category, `countsInRemainingTotal` gates on direction + tier, and a transfer to a
	 * livret A really does leave the checking account, so the cash-flow forecast must keep counting
	 * it or its balance line is wrong. Filtering the bills total but not the forecast would recreate
	 * the cross-surface disagreement #97 closed. The nature is therefore surfaced as a badge and
	 * changes no number (see `computeTotals`' transfer test).
	 *
	 * Taken from the most recent occurrence, the same rule `label` and `category` already use, so a
	 * stream whose category was re-mapped mid-history reports what it is today.
	 *
	 * Known limitation, accepted: `nature` resolves through the user's own `CategoryNatureMapping`
	 * rows and falls back to `spending`/`income` by kind for an unmapped category, so a user who
	 * renamed or deleted the seeded `Épargne` category gets NO badge on that stream. The badge is
	 * only ever as good as the mapping behind it. Not fixed here — fixing it means giving nature a
	 * source independent of the category, which is a data-model decision.
	 *
	 * Optional because `ForecastInputTransaction.nature` is: a caller feeding the detector rows it
	 * built itself (fixtures, `e2e/bills-seed.ts`) legitimately has none.
	 */
	nature?: TransactionNature;
	direction: FlowDirection;
	cadence: FlowCadence;
	/** Plaid-style tiering: >=3 occurrences is confirmed, exactly 2 is tentative. */
	status: FlowOccurrenceStatus;
	confidence: FlowConfidenceTier;
	occurrenceCount: number;
	/** Magnitude (unsigned) — the caller applies the sign via `direction`. */
	averageAmountCents: number;
	/** Smallest observed occurrence amount (unsigned) — the low bound of the displayed range. */
	minAmountCents: number;
	/** Largest observed occurrence amount (unsigned) — the high bound of the displayed range. */
	maxAmountCents: number;
	medianIntervalDays: number;
	intervalCoefficientOfVariation: number;
	amountCoefficientOfVariation: number;
	/** Circular concentration (mean resultant length, 0..1) of the day-of-month across occurrences. */
	dayOfMonthConcentration: number;
	lastDate: string;
	/** Most frequent day-of-month across occurrences — anchor for calendar-correct next-date projection (monthly/quarterly/yearly only). */
	anchorDayOfMonth: number;
	/** Ids of the transactions this flow was built from — lets a caller exclude them from a
	 *  non-recurring residual pool without re-deriving the grouping (single source of truth). */
	occurrenceIds: string[];
}

interface CadenceWindow {
	cadence: FlowCadence;
	days: number;
	toleranceDays: number;
}

// Canonical period + tolerance per cadence. Windows are deliberately non-overlapping (a gap
// between two consecutive windows is an ambiguous zone — a median interval landing there is
// rejected rather than guessed at) — see the "one-off coincidentally grouped by amount" test case.
const CADENCE_WINDOWS: readonly CadenceWindow[] = [
	{ cadence: 'weekly', days: 7, toleranceDays: 2 },
	{ cadence: 'biweekly', days: 14, toleranceDays: 3 },
	{ cadence: 'monthly', days: 30, toleranceDays: 5 },
	{ cadence: 'quarterly', days: 91, toleranceDays: 10 },
	{ cadence: 'yearly', days: 365, toleranceDays: 15 }
];

/**
 * The slip, in days, the detector already tolerates around a cadence's canonical period — exposed
 * for callers that need to reason about "how late may this stream legitimately be" (see
 * `computeStaleAfterDays` below). Read off `CADENCE_WINDOWS` rather than restated at the call
 * site, so the detector's tolerance and any consumer's can never drift apart.
 */
export function getCadenceToleranceDays(cadence: FlowCadence): number {
	const window = CADENCE_WINDOWS.find((entry) => entry.cadence === cadence);
	// The fallback is unreachable — CADENCE_WINDOWS covers every FlowCadence member — and exists
	// only because `Array.find` is not total in the type system.
	return window?.toleranceDays ?? 0;
}

/**
 * How long after its last observed occurrence a stream is still worth projecting:
 *
 *     medianIntervalDays + cadenceToleranceDays + ceil(medianIntervalDays * intervalCV)
 *
 * One full cycle, plus the cadence's own slip tolerance (the detector's own, read via
 * `getCadenceToleranceDays` rather than restated here), plus roughly one standard deviation of
 * THIS stream's observed intervals — so an irregular stream is given proportionally more rope
 * than a metronomic one.
 *
 * The two margins are SUMMED, not maxed, and that is deliberate: the two failure directions are
 * asymmetric. A cancelled stream lingering one extra cycle is mildly annoying; a genuinely late
 * real bill vanishing from the schedule is a loss of function — the user stops being told about a
 * payment they still owe. The bias is toward keeping streams. Do NOT "optimise" this into a
 * `Math.max` of the two terms.
 *
 * Worked examples: monthly with CV 0.1 -> 38 days (a bill 8 days late still reads "En retard",
 * which is exactly the signal that must not be lost); weekly with CV 0.1 -> 10; yearly with
 * CV 0.05 -> 399.
 *
 * A property of the recurrence engine, not of the bills view alone — shared by the upcoming-bills
 * schedule (`buildBillOccurrences`, which drops a stale stream from projection only) and the
 * cash-flow forecast (`loadCashFlowForecast`, which excludes it from both projection and the
 * residual pool — see that module's own comment for why the two differ).
 */
export function computeStaleAfterDays(
	flow: Pick<RecurringFlow, 'cadence' | 'medianIntervalDays' | 'intervalCoefficientOfVariation'>
): number {
	return (
		flow.medianIntervalDays +
		getCadenceToleranceDays(flow.cadence) +
		Math.ceil(flow.medianIntervalDays * flow.intervalCoefficientOfVariation)
	);
}

/**
 * True when a stream has been silent for longer than one tolerated cycle — a subscription
 * cancelled in March, say, still inside the detector's 12-month lookback and therefore still
 * detected, but which will never produce another payment.
 *
 * Such a stream is dropped from PROJECTION only: on the upcoming-bills surfaces, silently, same
 * treatment as a stream the user excluded — no status, no badge, no message, the user simply
 * stops seeing it. Its realized transactions inside the displayed period are facts and stay. The
 * cash-flow forecast goes further and also drops its transactions from the residual pool (see
 * `server/forecast/index.ts`), since a stopped stream's past payments should not keep inflating a
 * daily average the user no longer spends.
 *
 * This is not a second lateness path: an uncertain-tier stream that is also stale merely stops
 * being projected, which leaves `computeOccurrenceStatus` (upcomingBills.ts)'s tier gate
 * untouched.
 */
export function isStreamStale(
	flow: Pick<
		RecurringFlow,
		'cadence' | 'medianIntervalDays' | 'intervalCoefficientOfVariation' | 'lastDate'
	>,
	todayIso: string
): boolean {
	return wholeDaysBetween(flow.lastDate, todayIso) > computeStaleAfterDays(flow);
}

function classifyCadence(medianIntervalDays: number): FlowCadence | null {
	const match = CADENCE_WINDOWS.find(
		(window) => Math.abs(medianIntervalDays - window.days) <= window.toleranceDays
	);
	return match?.cadence ?? null;
}

function toEpochDay(iso: string): number {
	return Math.floor(new Date(`${iso}T00:00:00.000Z`).getTime() / 86_400_000);
}

/** Whole days elapsed from `dateIso` to `todayIso`; positive when `dateIso` is in the past. */
export function wholeDaysBetween(dateIso: string, todayIso: string): number {
	return toEpochDay(todayIso) - toEpochDay(dateIso);
}

/**
 * Exclusive upper bound for every recurrence-detector input: the start of the day AFTER
 * `todayIso`, UTC. Transactions dated today are in; anything dated later is out.
 *
 * Inference from observed history must not include what has not happened yet. Nothing rejects a
 * future-dated transaction on import (a pending bank debit, a mistyped CSV year), and one such
 * row moves `occurrenceCount`, the interval set and `lastDate` — so a surface that fetches
 * further ahead than another reports a different confidence tier for the same stream. All three
 * detector call sites use THIS value so that cannot happen.
 *
 * Same reasoning as the net-worth future-date guard: the row stays fully visible everywhere it
 * is a fact, it just stops feeding pattern inference until its date arrives.
 */
export function detectionEndExclusive(todayIso: string): Date {
	return new Date(toEpochDay(todayIso) * 86_400_000 + 86_400_000);
}

/**
 * Exported so every caller with a list of numbers to summarize goes through the one
 * implementation, rather than each re-deriving the same sort-and-middle logic. See
 * `resolveIdempotenceWindowDays` in `server/upcoming-bills/service.ts` for the call that used to
 * duplicate this byte-for-byte.
 */
export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Population coefficient of variation. Undefined (returned as 0, i.e. "perfectly regular") when
// fewer than 2 samples exist — a single interval/amount has no spread to measure; the group's
// occurrence count already downgrades such groups to 'tentative' elsewhere.
function coefficientOfVariation(values: readonly number[]): number {
	if (values.length < 2) return 0;
	const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
	if (avg === 0) return 0;
	const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
	return Math.sqrt(variance) / avg;
}

// Circular statistics (mean resultant length) over a fixed 31-day cycle: day-of-month naturally
// wraps (day 30 and day 1 of the next month are 1 day apart, not 29) — a linear stddev would
// misjudge concentration for any group whose payment day sits near a month boundary.
function dayOfMonthConcentration(dates: readonly string[]): number {
	const angles = dates.map((date) => (2 * Math.PI * (Number(date.slice(8, 10)) - 1)) / 31);
	const sumCos = angles.reduce((sum, angle) => sum + Math.cos(angle), 0);
	const sumSin = angles.reduce((sum, angle) => sum + Math.sin(angle), 0);
	return Math.sqrt(sumCos ** 2 + sumSin ** 2) / dates.length;
}

// Most frequent day-of-month; ties broken toward the smaller day for determinism.
function modeDayOfMonth(dates: readonly string[]): number {
	const counts = new Map<number, number>();
	for (const date of dates) {
		const day = Number(date.slice(8, 10));
		counts.set(day, (counts.get(day) ?? 0) + 1);
	}
	let bestDay = Number(dates[dates.length - 1].slice(8, 10));
	let bestCount = 0;
	for (const [day, count] of counts) {
		if (count > bestCount || (count === bestCount && day < bestDay)) {
			bestCount = count;
			bestDay = day;
		}
	}
	return bestDay;
}

// Combines the 4 regularity signals from the spec into one 0..1 score, then maps it to a
// readable tier (never a raw probability). Weights favor interval regularity (the strongest
// recurrence signal) over the others; day-of-month concentration is weighted lowest since it's
// only strongly meaningful for monthly-like cadences (weekly payments legitimately spread across
// every day of the month).
function computeConfidence(
	occurrenceCount: number,
	intervalCV: number,
	amountCV: number,
	dayOfMonthConcentrationScore: number
): FlowConfidenceTier {
	const intervalScore =
		intervalCV <= 0.1 ? 1 : intervalCV <= 0.25 ? 0.6 : intervalCV <= 0.5 ? 0.3 : 0;
	const amountScore = amountCV <= 0.05 ? 1 : amountCV <= 0.15 ? 0.6 : amountCV <= 0.3 ? 0.3 : 0;
	const countScore = occurrenceCount >= 4 ? 1 : occurrenceCount === 3 ? 0.8 : 0.4;

	const score =
		0.35 * intervalScore +
		0.25 * amountScore +
		0.25 * countScore +
		0.15 * dayOfMonthConcentrationScore;

	if (score >= 0.75) return 'high';
	if (score >= 0.45) return 'medium';
	return 'low';
}

// `nature` is carried for DISPLAY only — see `RecurringFlow.nature`. It is deliberately not read
// by `groupTransactionsForRecurrence` below: making it part of the grouping key would re-split
// existing streams and therefore move `occurrenceIds`, which is the anchor set persisted
// EXCLUDE/PAID actions match on.
export type ForecastInputTransaction = Pick<
	Transaction,
	'id' | 'date' | 'label' | 'amountCents' | 'category' | 'type' | 'nature'
>;

/**
 * Groups transactions by direction + normalized merchant label + category — step 1 of the detector
 * below, exported because the upcoming-bills "en observation" list has to rebuild exactly the same
 * buckets. Sharing the code (rather than copying the four lines) is what makes it impossible for
 * the two views to disagree about what counts as one stream. Keys are `direction:label:category`;
 * transactions whose label normalizes to nothing are dropped.
 */
export function groupTransactionsForRecurrence(
	transactions: readonly ForecastInputTransaction[]
): Map<string, ForecastInputTransaction[]> {
	const groups = new Map<string, ForecastInputTransaction[]>();

	for (const transaction of transactions) {
		const normalizedLabel = normalizeRecurringLabel(transaction.label);
		if (!normalizedLabel) continue;

		const direction: FlowDirection =
			getTransactionKind(transaction) === 'income' ? 'income' : 'expense';
		const key = `${direction}:${normalizedLabel}:${transaction.category}`;
		groups.set(key, [...(groups.get(key) ?? []), transaction]);
	}

	return groups;
}

/**
 * Detects recurring income and expense flows from raw transactions — pure, deterministic,
 * no ML/AI (per the app's "deterministic insights" posture). Pipeline:
 *  1. Group by direction + normalized merchant label + category (reuses domain/recurrence.ts,
 *     the same grouping already used by getRecurringPayments — not duplicated).
 *  2. Split each group by similar amount (tolerance-based, also reused).
 *  3. For each candidate group (>=2 occurrences), classify temporal regularity: median interval,
 *     interval/amount coefficients of variation, day-of-month concentration, cadence.
 *  4. Reject groups whose median interval doesn't land in any canonical cadence window (rules
 *     out a same-merchant/same-amount coincidence between two unrelated one-off transactions).
 * Confirmed (>=3 occurrences) vs tentative (exactly 2) mirrors the industry-standard (Plaid)
 * confidence convention.
 */
export function detectRecurringFlows(
	transactions: readonly ForecastInputTransaction[]
): RecurringFlow[] {
	const groups = groupTransactionsForRecurrence(transactions);
	const flows: RecurringFlow[] = [];

	for (const [key, groupTransactions] of groups) {
		const direction = key.startsWith('income:') ? 'income' : 'expense';

		for (const group of getSimilarAmountGroups(groupTransactions)) {
			if (group.length < 2) continue;

			const sorted = [...group].sort((left, right) => left.date.localeCompare(right.date));
			const dates = sorted.map((transaction) => transaction.date);
			const epochDays = dates.map(toEpochDay);
			const intervals = epochDays.slice(1).map((day, index) => day - epochDays[index]);
			const medianIntervalDays = median(intervals);

			const cadence = classifyCadence(medianIntervalDays);
			if (!cadence) continue;

			const amounts = sorted.map((transaction) => Math.abs(transaction.amountCents));
			const intervalCV = coefficientOfVariation(intervals);
			const amountCV = coefficientOfVariation(amounts);
			const concentration = dayOfMonthConcentration(dates);
			const magnitudes = group.map((t) => Math.abs(t.amountCents));

			flows.push({
				key,
				label: sorted[sorted.length - 1].label,
				category: sorted[sorted.length - 1].category,
				nature: sorted[sorted.length - 1].nature,
				direction,
				cadence,
				status: group.length >= 3 ? 'confirmed' : 'tentative',
				confidence: computeConfidence(group.length, intervalCV, amountCV, concentration),
				occurrenceCount: group.length,
				averageAmountCents: Math.round(
					amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length
				),
				minAmountCents: Math.min(...magnitudes),
				maxAmountCents: Math.max(...magnitudes),
				medianIntervalDays,
				intervalCoefficientOfVariation: intervalCV,
				amountCoefficientOfVariation: amountCV,
				dayOfMonthConcentration: concentration,
				lastDate: dates[dates.length - 1],
				anchorDayOfMonth: modeDayOfMonth(dates),
				occurrenceIds: sorted.map((transaction) => transaction.id)
			});
		}
	}

	return flows;
}

// ─── Projection / ledger ────────────────────────────────────────────────────
// No time-series ML/AI here either (TimesFM/Chronos-style models were explicitly ruled out by
// the research: they need 50-100+ historical points, unsuited to a sparse 1-3 month event
// signal, and incompatible with local-first/no-GPU). Instead: each confirmed recurring flow is
// projected to its next expected date(s)/amount, and the running balance is a plain day-by-day
// cumulative sum — fully deterministic and explainable.

const MAX_PROJECTION_STEPS = 400; // defensive cap against a pathological horizon

export interface ProjectedOccurrence {
	date: string;
	/** Signed — the flow's direction is already applied. */
	amountCents: number;
	flowKey: string;
	flowLabel: string;
	flowCategory: string;
	cadence: FlowCadence;
}

function epochToIso(epochDay: number): string {
	return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

// Adds calendar months (not a fixed day count) so a monthly/quarterly/yearly anchor on the
// 29th/30th/31st clamps to the target month's real last day (e.g. Jan 31 + 1 month -> Feb 28/29)
// instead of overflowing into the following month the way naive day-arithmetic would.
function addCalendarMonths(iso: string, monthsToAdd: number, anchorDay: number): string {
	const base = new Date(`${iso}T00:00:00.000Z`);
	const year = base.getUTCFullYear();
	const targetMonthIndex = base.getUTCMonth() + monthsToAdd;
	const daysInTargetMonth = new Date(Date.UTC(year, targetMonthIndex + 1, 0)).getUTCDate();
	const day = Math.min(anchorDay, daysInTargetMonth);
	return new Date(Date.UTC(year, targetMonthIndex, day)).toISOString().slice(0, 10);
}

/**
 * Projects a single recurring flow's future occurrences from `fromDate` (inclusive) up to
 * `fromDate + horizonDays`. Monthly/quarterly/yearly cadences step by calendar months from the
 * flow's anchor day (calendar-correct across month-length differences); weekly/biweekly step by
 * a fixed day count from the last known occurrence (there's no calendar unit smaller than a
 * month that needs clamping).
 */
export function projectFlowOccurrences(
	flow: RecurringFlow,
	fromDate: string,
	horizonDays: number
): ProjectedOccurrence[] {
	const fromEpoch = toEpochDay(fromDate);
	const horizonEndEpoch = fromEpoch + horizonDays;
	const signedAmountCents =
		flow.direction === 'expense' ? -flow.averageAmountCents : flow.averageAmountCents;
	const occurrences: ProjectedOccurrence[] = [];

	const isCalendarMonthBased =
		flow.cadence === 'monthly' || flow.cadence === 'quarterly' || flow.cadence === 'yearly';
	const monthStep = flow.cadence === 'monthly' ? 1 : flow.cadence === 'quarterly' ? 3 : 12;
	const dayStep = flow.cadence === 'weekly' ? 7 : 14;
	const lastEpoch = toEpochDay(flow.lastDate);

	for (let step = 1; step <= MAX_PROJECTION_STEPS; step++) {
		const date = isCalendarMonthBased
			? addCalendarMonths(flow.lastDate, monthStep * step, flow.anchorDayOfMonth)
			: epochToIso(lastEpoch + dayStep * step);
		const candidateEpoch = toEpochDay(date);
		if (candidateEpoch > horizonEndEpoch) break;
		if (candidateEpoch >= fromEpoch) {
			occurrences.push({
				date,
				amountCents: signedAmountCents,
				flowKey: flow.key,
				flowLabel: flow.label,
				flowCategory: flow.category,
				cadence: flow.cadence
			});
		}
	}

	return occurrences;
}

export interface CashFlowLedgerDay {
	date: string;
	balanceCents: number;
	events: ProjectedOccurrence[];
}

/**
 * Reconstructs the day-by-day REALIZED balance from `lookbackDays` before `todayIso` up to and
 * including `todayIso`, anchored so the last day matches `endingBalanceCents` exactly (the same
 * known-current-balance anchor `projectCashFlow` starts its own projection from — the two series
 * are meant to be concatenated at that shared day). Walks backward from the anchor rather than
 * forward from an assumed starting balance, since only the CURRENT balance is ever known for
 * certain (declarative NetWorthAccount balance, or 0 in relative/no-anchor mode) — a transaction
 * total can only be subtracted from a known point, never accumulated from an unknown one.
 */
export function buildRealizedLedgerDays(
	transactions: readonly Pick<Transaction, 'date' | 'amountCents'>[],
	endingBalanceCents: number,
	todayIso: string,
	lookbackDays: number
): CashFlowLedgerDay[] {
	const todayEpoch = toEpochDay(todayIso);
	const startEpoch = todayEpoch - Math.max(0, lookbackDays);

	const dailyNetByEpoch = new Map<number, number>();
	for (const transaction of transactions) {
		const epoch = toEpochDay(transaction.date);
		if (epoch > startEpoch && epoch <= todayEpoch) {
			dailyNetByEpoch.set(epoch, (dailyNetByEpoch.get(epoch) ?? 0) + transaction.amountCents);
		}
	}

	const totalNetCents = [...dailyNetByEpoch.values()].reduce((sum, value) => sum + value, 0);

	const days: CashFlowLedgerDay[] = [];
	let balance = endingBalanceCents - totalNetCents;
	for (let epoch = startEpoch; epoch <= todayEpoch; epoch++) {
		if (epoch > startEpoch) balance += dailyNetByEpoch.get(epoch) ?? 0;
		days.push({ date: epochToIso(epoch), balanceCents: balance, events: [] });
	}
	return days;
}

/**
 * A confirmed flow (>=3 occurrences) whose regularity signals are still too erratic ('low'
 * confidence) is excluded from anything presented as "included in the calculation" — both the
 * projection ledger's math and any UI table claiming to list what feeds it. Single predicate
 * shared by the server projection filter and every display-layer consumer, so the table can never
 * silently drift from what the balance projection actually used.
 */
export function isReliableConfirmedFlow(
	flow: Pick<RecurringFlow, 'status' | 'confidence'>
): boolean {
	return flow.status === 'confirmed' && flow.confidence !== 'low';
}

/**
 * The single predicate for "does this flow currently feed the cash-flow projection" —
 * `isReliableConfirmedFlow` (status/confidence) AND not `isStreamStale` (silent longer than one
 * tolerated cycle). Unlike `isReliableConfirmedFlow`, this needs `todayIso`, since staleness is
 * relative to "now".
 *
 * BOTH the server projection filter (`confirmedFlows` in `server/forecast/index.ts`) and the
 * view's per-flow `feedsProjection` flag (`toDisplayCashFlowForecast`) must go through this one
 * function — the two used to spell out the same two-term expression independently, which is
 * exactly the shape that let them silently diverge once before (see that module's history). A
 * third term added to one and not the other is caught by `server/forecast/index.spec.ts`'s
 * anti-drift test only if both call sites still route through here.
 */
export function feedsCashFlowProjection(
	flow: Pick<
		RecurringFlow,
		| 'status'
		| 'confidence'
		| 'cadence'
		| 'medianIntervalDays'
		| 'intervalCoefficientOfVariation'
		| 'lastDate'
	>,
	todayIso: string
): boolean {
	return isReliableConfirmedFlow(flow) && !isStreamStale(flow, todayIso);
}

export type FlowDisplayTier = 'confirmed' | 'likely' | 'uncertain';

/**
 * The design's three confidence badges (Confirmé / Probable / Incertain) collapsed from the
 * engine's two orthogonal fields. `tier !== 'uncertain'` is by construction equivalent to
 * `isReliableConfirmedFlow` — the upcoming-bills view and the cash-flow forecast must never
 * disagree about which streams are trustworthy.
 */
export function getFlowDisplayTier(
	flow: Pick<RecurringFlow, 'status' | 'confidence'>
): FlowDisplayTier {
	if (flow.status === 'tentative' || flow.confidence === 'low') return 'uncertain';
	return flow.confidence === 'high' ? 'confirmed' : 'likely';
}

export type FlowAmountVariability = 'fixed' | 'variable';

/** Under one euro of observed spread the amount is displayed as fixed. */
export function getFlowAmountVariability(
	flow: Pick<RecurringFlow, 'minAmountCents' | 'maxAmountCents'>
): FlowAmountVariability {
	return flow.maxAmountCents - flow.minAmountCents >= 100 ? 'variable' : 'fixed';
}

export interface CashFlowForecastInput {
	/** Only 'confirmed' flows should be passed in — tentative flows are too fragile to project. */
	confirmedFlows: readonly RecurringFlow[];
	/** Signed average daily net amount from non-recurring activity (see computeResidualDailyCents). */
	residualDailyCents: number;
	startingBalanceCents: number;
	fromDate: string;
	horizonDays: number;
}

/**
 * Builds the day-by-day projected balance ledger. Day 0 (`fromDate`) is the anchor as-is — its
 * BALANCE is never adjusted by a flow or the residual, since it represents the already-known
 * current balance, not a projection. A confirmed flow whose next occurrence happens to fall
 * exactly on `fromDate` (e.g. checking the dashboard on payday) is still surfaced in day 0's
 * `events` for display — only its amount is excluded from the balance delta, never the
 * occurrence itself (silently dropping it would misrepresent the flow as not detected at all).
 * From day 1 onward, each day accumulates the residual plus any recurring flow events landing
 * exactly on that date.
 */
export function projectCashFlow(input: CashFlowForecastInput): CashFlowForecastResult {
	const eventsByDate = new Map<string, ProjectedOccurrence[]>();
	for (const flow of input.confirmedFlows) {
		for (const occurrence of projectFlowOccurrences(flow, input.fromDate, input.horizonDays)) {
			const list = eventsByDate.get(occurrence.date) ?? [];
			list.push(occurrence);
			eventsByDate.set(occurrence.date, list);
		}
	}

	const fromEpoch = toEpochDay(input.fromDate);
	const days: CashFlowLedgerDay[] = [
		{
			date: input.fromDate,
			balanceCents: input.startingBalanceCents,
			events: eventsByDate.get(input.fromDate) ?? []
		}
	];
	let balance = input.startingBalanceCents;

	for (let offset = 1; offset <= input.horizonDays; offset++) {
		const date = epochToIso(fromEpoch + offset);
		const events = eventsByDate.get(date) ?? [];
		const eventsTotalCents = events.reduce((sum, event) => sum + event.amountCents, 0);
		balance += input.residualDailyCents + eventsTotalCents;
		days.push({ date, balanceCents: balance, events });
	}

	return { days, startingBalanceCents: input.startingBalanceCents };
}

export interface CashFlowForecastResult {
	days: CashFlowLedgerDay[];
	startingBalanceCents: number;
}

const DAYS_PER_WEEK = 7;

/**
 * Residual (non-recurring) daily net flow: the median of full 7-day sums over the DENSE per-day
 * series (the caller must already have zero-filled every day of the lookback window), scaled back
 * to one day. A plain median of the daily series collapses to 0 for any user with non-recurring
 * activity on fewer than half of all days — the common case (groceries every 3-4 days), which
 * silently dropped all non-recurring spending from the projection (closing-audit finding).
 * Weekly sums keep that activity visible, while the median ACROSS weeks stays robust to the rare
 * large one-off (a single big purchase inflates one week; the median over a ~52-week lookback
 * ignores it — same protection the old daily median provided). The trailing partial week is
 * dropped (a partial sum would bias the median low) — deliberately the TRAILING one: weeks are
 * cut from the start of the window, so the up-to-6 skipped days are always the most recent ones,
 * a rotating (never permanent) gap of at most 6/365 days of the lookback; a window shorter than
 * one full week falls
 * back to the daily median — only reachable with a sub-week lookback, never in production
 * (12-month lookback, see server/forecast's FORECAST_LOOKBACK_MONTHS).
 */
export function computeResidualDailyCents(dailyNetAmountsCents: readonly number[]): number {
	if (dailyNetAmountsCents.length === 0) return 0;

	const weeklySums: number[] = [];
	for (
		let start = 0;
		start + DAYS_PER_WEEK <= dailyNetAmountsCents.length;
		start += DAYS_PER_WEEK
	) {
		let sum = 0;
		for (let offset = 0; offset < DAYS_PER_WEEK; offset++) {
			sum += dailyNetAmountsCents[start + offset];
		}
		weeklySums.push(sum);
	}
	if (weeklySums.length === 0) return Math.round(median(dailyNetAmountsCents));

	return Math.round(median(weeklySums) / DAYS_PER_WEEK);
}

/**
 * Zero-fills every day in `[fromDateIso, toDateIsoExclusive)` with the net (signed) sum of the
 * given transactions landing on it — the dense series computeResidualDailyCents' median needs.
 * The caller is expected to have already excluded transactions belonging to a detected
 * recurring flow (see RecurringFlow.occurrenceIds), so what's left here is genuinely
 * non-recurring activity.
 */
export function buildDenseDailyNetSeries(
	transactions: readonly Pick<Transaction, 'date' | 'amountCents'>[],
	fromDateIso: string,
	toDateIsoExclusive: string
): number[] {
	const fromEpoch = toEpochDay(fromDateIso);
	const dayCount = Math.max(0, toEpochDay(toDateIsoExclusive) - fromEpoch);
	const series = new Array<number>(dayCount).fill(0);

	for (const transaction of transactions) {
		const offset = toEpochDay(transaction.date) - fromEpoch;
		if (offset >= 0 && offset < dayCount) series[offset] += transaction.amountCents;
	}

	return series;
}

/**
 * Days remaining in `now`'s calendar month AFTER `now` itself (e.g. the 28th of a 31-day month
 * -> 3) — meant to be used directly as `projectCashFlow`'s `horizonDays` (day 0 = `now`, so this
 * is exactly how many more days reach the last day of the month). UTC-based throughout, matching
 * every other date computation in this feature and the codebase's established convention
 * (server/date-range.ts, server/dashboard/insights.ts) — a local-time getter here would let this
 * horizon silently drift by a day from the rest of the forecast pipeline depending on the
 * server's timezone.
 */
export function getRemainingDaysInMonthUtc(now: Date): number {
	const daysInMonth = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
	).getUTCDate();
	return Math.max(0, daysInMonth - now.getUTCDate());
}
