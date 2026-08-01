import type {
	FlowDirection,
	FlowDisplayTier,
	ForecastInputTransaction,
	RecurringFlow
} from './forecast';
import {
	getFlowDisplayTier,
	groupTransactionsForRecurrence,
	isStreamStale,
	projectFlowOccurrences,
	wholeDaysBetween
} from './forecast';
import { getSimilarAmountGroups, normalizeStoredRecurringLabel } from './recurrence';

/**
 * Upcoming-bills schedule: turns the detected recurring flows into dated occurrences carrying a
 * status, applies the user's persisted per-stream actions on top, and sums the period totals.
 * Pure domain module — no server, Prisma or `$app` imports.
 */

export type StreamActionKind = 'ignore' | 'paid' | 'exclude';
export type OccurrenceStatus = 'upcoming' | 'overdue' | 'settled' | 'ignored';

export interface StreamActionInput {
	id: string;
	kind: StreamActionKind;
	direction: FlowDirection;
	normalizedLabel: string;
	anchorTransactionIds: readonly string[];
	/** ISO yyyy-mm-dd of the occurrence the action targets; null for 'exclude' (whole stream). */
	dueDate: string | null;
}

export interface BillOccurrence {
	flow: RecurringFlow;
	tier: FlowDisplayTier;
	dateIso: string;
	status: OccurrenceStatus;
	/** Non-null ONLY when status === 'overdue'. */
	daysLate: number | null;
	/** True ONLY for an OPEN (upcoming) uncertain-tier occurrence whose estimated date is already
	 *  past — always false once the row is settled or ignored, where the date is either a real
	 *  transaction date or a user decision rather than an estimate. Drives the "date estimée
	 *  dépassée" copy: a plain date comparison, deliberately NOT a lateness computation (see
	 *  computeOccurrenceStatus). */
	estimatePassed: boolean;
	/** Signed; the actual transaction amount when auto-settled, the flow's average otherwise. */
	amountCents: number;
	settledKind: 'auto' | 'manual' | null;
	settledTransactionId: string | null;
	/** The ignore/paid action row backing this status, when one applied. */
	appliedActionId: string | null;
	countsInRemainingTotal: boolean;
}

const MS_PER_DAY = 86_400_000;

/**
 * The DOM-safe form of a row's `rowKey`, for `id="bill-row-…"` / `id="bill-restore-…"`.
 *
 * A `rowKey` is `direction:normalizedLabel:date:index` and is NOT usable as an id as it stands:
 * `normalizeRecurringLabel` collapses every non-letter run to a SPACE, so "Salaire ACME" yields
 * `income:salaire acme:2026-08-03:4`. HTML forbids ASCII whitespace in an `id`, and — the part
 * that actually breaks something — `aria-labelledby`, `aria-controls` and `aria-describedby` are
 * space-separated ID LISTS, so such an id silently references nothing. The colons are legal in an
 * id but are not valid in an unescaped CSS selector.
 *
 * Uniqueness survives the collapse. Two different rows can normalize to the same prefix (`a b:…`
 * and `a:b:…` both become `a-b-…`), but every rowKey ends in its own index within the period's
 * occurrence list, so the suffixes differ and the ids cannot collide.
 *
 * Exported rather than inlined at the render site so the code that MOVES FOCUS to these ids uses
 * the identical transformation: a second, slightly different regex somewhere else is a focus call
 * that lands on nothing and reports no error.
 */
export function toBillRowDomKey(rowKey: string): string {
	return rowKey.replace(/[^A-Za-z0-9_-]+/g, '-');
}

function toEpochMs(iso: string): number {
	return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

/**
 * Stream identity for a persisted action. Anchor transaction ids come first and are authoritative:
 * they survive a label the detector later re-reads from a more recent occurrence. The normalized
 * label + direction pair is the fallback for a stream whose historical transactions have since
 * rolled out of the lookback window.
 *
 * The fallback goes through `normalizeStoredRecurringLabel`, NOT `normalizeRecurringLabel`: the
 * write path truncates the label to `STORED_LABEL_MAX_CHARS` before normalizing it, so comparing
 * against the normalization of the FULL label diverges for any label past the cap — and bank
 * connectors do write provider labels through unmodified into a `@db.Text` column. The visible
 * symptom of getting this wrong is a stream the user excluded silently reappearing once its
 * anchors age out.
 */
export function actionMatchesFlow(
	action: Pick<StreamActionInput, 'direction' | 'normalizedLabel' | 'anchorTransactionIds'>,
	flow: Pick<RecurringFlow, 'direction' | 'label' | 'occurrenceIds'>
): boolean {
	if (action.anchorTransactionIds.some((id) => flow.occurrenceIds.includes(id))) return true;
	if (action.direction !== flow.direction) return false;
	return action.normalizedLabel === normalizeStoredRecurringLabel(flow.label);
}

/** Drops every flow the user has excluded from the upcoming-bills view entirely. */
export function applyStreamExclusions(
	flows: readonly RecurringFlow[],
	actions: readonly StreamActionInput[]
): RecurringFlow[] {
	const exclusions = actions.filter((action) => action.kind === 'exclude');
	if (exclusions.length === 0) return [...flows];
	return flows.filter((flow) => !exclusions.some((action) => actionMatchesFlow(action, flow)));
}

/**
 * Tolerance, in days, between a stored action's `dueDate` and a projected occurrence date for the
 * action to still be considered for that occurrence. Half the cadence absorbs the projection drift
 * that appears as new transactions shift the anchor; clamped to [1, 15] so a yearly stream does not
 * get a six-month window.
 *
 * The window ALONE does not guarantee an action reaches only one occurrence — at half a cadence, a
 * `dueDate` sitting exactly midway between two occurrences is inside both windows. That guarantee
 * comes from `assignActionsToOccurrences`, which resolves each action to a single date.
 */
export function occurrenceActionWindowDays(
	flow: Pick<RecurringFlow, 'medianIntervalDays'>
): number {
	return Math.min(Math.max(Math.floor(flow.medianIntervalDays / 2), 1), 15);
}

/**
 * Status of a projected occurrence with no user action on it.
 *
 * The confidence-tier gate is the FIRST statement on purpose (locked decision): an uncertain
 * stream must never compute as late even internally, because its date is an estimate and calling
 * an estimate "late" is a claim the data does not support. This is not a render-time filter over a
 * lateness that was computed anyway — no date arithmetic runs before the return.
 */
export function computeOccurrenceStatus(
	tier: FlowDisplayTier,
	dateIso: string,
	todayIso: string
): { status: 'upcoming' | 'overdue'; daysLate: number | null } {
	if (tier === 'uncertain') return { status: 'upcoming', daysLate: null };

	const daysLate = wholeDaysBetween(dateIso, todayIso);
	return daysLate > 0 ? { status: 'overdue', daysLate } : { status: 'upcoming', daysLate: null };
}

export interface BuildBillOccurrencesInput {
	/** Pre-exclusion — the function applies `applyStreamExclusions` itself. */
	flows: readonly RecurringFlow[];
	transactions: readonly ForecastInputTransaction[];
	actions: readonly StreamActionInput[];
	/** Period start, inclusive. */
	fromIso: string;
	/** Period end, exclusive. */
	toIsoExclusive: string;
	todayIso: string;
}

/**
 * Resolves each `kind` action of this flow to AT MOST ONE of the flow's projected dates: the
 * closest one inside the window, earliest on a tie. Resolving per action (rather than asking each
 * occurrence whether some action is near enough) is what makes "one action, one occurrence" true —
 * a `dueDate` exactly midway between two occurrences is inside both windows, so a per-occurrence
 * test would settle two months of a bill from a single tap. `dates` is in ascending order, so the
 * strict `<` on distance keeps the earlier occurrence when two are equidistant.
 *
 * When two actions of the same kind resolve to the same date, the first in input order wins and the
 * later one is dropped — the caller orders actions deterministically (most recent last), so a
 * duplicate row can never make the output flicker.
 */
function assignActionsToOccurrences(
	actions: readonly StreamActionInput[],
	kind: StreamActionKind,
	flow: RecurringFlow,
	dates: readonly string[]
): Map<string, StreamActionInput> {
	const windowDays = occurrenceActionWindowDays(flow);
	const assigned = new Map<string, StreamActionInput>();

	for (const action of actions) {
		if (action.kind !== kind || action.dueDate === null) continue;
		if (!actionMatchesFlow(action, flow)) continue;

		let bestDate: string | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const date of dates) {
			const distance = Math.abs(wholeDaysBetween(action.dueDate, date));
			if (distance <= windowDays && distance < bestDistance) {
				bestDate = date;
				bestDistance = distance;
			}
		}

		if (bestDate !== null && !assigned.has(bestDate)) assigned.set(bestDate, action);
	}

	return assigned;
}

/**
 * Builds the period's occurrence list: the flow transactions that already landed inside the period
 * (realized, auto-settled) plus the projected future ones, with any matching user action applied.
 *
 * Realized and projected rows cannot collide: `projectFlowOccurrences` iterates from
 * `flow.lastDate` with step >= 1, so it only ever emits dates STRICTLY AFTER the flow's most
 * recent transaction, while realized rows are by definition at or before it. There is therefore no
 * de-duplication step here on purpose — one would be dead code hiding that property.
 */
export function buildBillOccurrences(input: BuildBillOccurrencesInput): BillOccurrence[] {
	const flows = applyStreamExclusions(input.flows, input.actions);
	const horizonDays = Math.max(
		0,
		Math.floor((toEpochMs(input.toIsoExclusive) - toEpochMs(input.fromIso)) / MS_PER_DAY)
	);
	const transactionsById = new Map(
		input.transactions.map((transaction) => [transaction.id, transaction])
	);
	const occurrences: BillOccurrence[] = [];

	for (const flow of flows) {
		const tier = getFlowDisplayTier(flow);
		const signedAverageCents =
			flow.direction === 'expense' ? -flow.averageAmountCents : flow.averageAmountCents;

		// Realized: a transaction this flow was built from, landing inside the period.
		for (const id of flow.occurrenceIds) {
			const transaction = transactionsById.get(id);
			if (!transaction) continue;
			// ISO yyyy-mm-dd sorts lexicographically in date order, so string compare is a valid
			// range check here and everywhere else in this module.
			if (transaction.date < input.fromIso || transaction.date >= input.toIsoExclusive) continue;

			occurrences.push({
				flow,
				tier,
				dateIso: transaction.date,
				status: 'settled',
				daysLate: null,
				// A realized row's date is a real transaction date, never an estimate.
				estimatePassed: false,
				amountCents: transaction.amountCents,
				settledKind: 'auto',
				settledTransactionId: transaction.id,
				appliedActionId: null,
				countsInRemainingTotal: false
			});
		}

		// Projected: everything still to come inside the period — unless the stream has gone quiet
		// for longer than one tolerated cycle, in which case it projects nothing at all (see
		// `isStreamStale`). The guard lives HERE and not inside `projectFlowOccurrences` because that
		// function is shared with the cash-flow forecast, and it steps from `flow.lastDate` regardless
		// of caller — `fromDate` only filters which of those stepped dates get emitted, it does not
		// stop the stepping. A stale stream's dates are therefore still generated, just all before
		// `fromDate` most of the time; nothing here or in `projectFlowOccurrences` used to stop that.
		// The cash-flow forecast now applies the SAME `isStreamStale` guard itself, at the flow-list
		// level in `server/forecast/index.ts` (`loadCashFlowForecast`), rather than inside the shared
		// stepping function — so both surfaces refuse to project a stale stream, without either one
		// silently affecting the other's caller.
		if (isStreamStale(flow, input.todayIso)) continue;

		const projectedDates = projectFlowOccurrences(flow, input.fromIso, horizonDays)
			.map((projected) => projected.date)
			.filter((date) => date < input.toIsoExclusive);
		const paidByDate = assignActionsToOccurrences(input.actions, 'paid', flow, projectedDates);
		const ignoredByDate = assignActionsToOccurrences(input.actions, 'ignore', flow, projectedDates);

		for (const date of projectedDates) {
			const paid = paidByDate.get(date);

			if (paid) {
				occurrences.push({
					flow,
					tier,
					dateIso: date,
					status: 'settled',
					daysLate: null,
					// Settled by the user; the estimate is no longer what the row is about.
					estimatePassed: false,
					amountCents: signedAverageCents,
					settledKind: 'manual',
					settledTransactionId: null,
					appliedActionId: paid.id,
					countsInRemainingTotal: false
				});
				continue;
			}

			const ignored = ignoredByDate.get(date);

			if (ignored) {
				occurrences.push({
					flow,
					tier,
					dateIso: date,
					status: 'ignored',
					daysLate: null,
					// Dismissed by the user; same reasoning as the manual-paid branch above.
					estimatePassed: false,
					amountCents: signedAverageCents,
					settledKind: null,
					settledTransactionId: null,
					appliedActionId: ignored.id,
					countsInRemainingTotal: false
				});
				continue;
			}

			const { status, daysLate } = computeOccurrenceStatus(tier, date, input.todayIso);

			occurrences.push({
				flow,
				tier,
				dateIso: date,
				status,
				daysLate,
				estimatePassed: tier === 'uncertain' && date < input.todayIso,
				amountCents: signedAverageCents,
				settledKind: null,
				settledTransactionId: null,
				appliedActionId: null,
				// An uncertain stream is shown but never counted: the total is presented as an amount
				// the user can act on, and an estimate the app itself flags as unreliable would make
				// that number unreliable too.
				countsInRemainingTotal: flow.direction === 'expense' && tier !== 'uncertain'
			});
		}
	}

	return occurrences.sort(
		(left, right) =>
			left.dateIso.localeCompare(right.dateIso) || left.flow.label.localeCompare(right.flow.label)
	);
}

/**
 * Period headline figures. Both are UNSIGNED sums and income is never netted against expenses:
 * "reste à payer" and "revenus attendus" answer two different questions, and a single net number
 * would hide a large bill behind a salary. Amounts come from the flow's average (not min/max) so a
 * variable stream contributes its typical value rather than a best or worst case.
 */
export function computeTotals(occurrences: readonly BillOccurrence[]): {
	remainingExpenseCents: number;
	expectedIncomeCents: number;
} {
	let remainingExpenseCents = 0;
	let expectedIncomeCents = 0;

	for (const occurrence of occurrences) {
		if (occurrence.countsInRemainingTotal) {
			remainingExpenseCents += occurrence.flow.averageAmountCents;
		}
		if (
			occurrence.flow.direction === 'income' &&
			occurrence.tier !== 'uncertain' &&
			(occurrence.status === 'upcoming' || occurrence.status === 'overdue')
		) {
			expectedIncomeCents += occurrence.flow.averageAmountCents;
		}
	}

	return { remainingExpenseCents, expectedIncomeCents };
}

/**
 * The two bounds of a variable amount, ready for `bills_amount_range` ("{min} à {max}").
 *
 * The currency symbol appears ONCE, as the design's plate does ("−74 à −96 €"): both bounds
 * carrying it read as two separate amounts. Which bound keeps it is the locale's own decision —
 * suffix locales (fr) put it on the max, prefix locales (en) on the min — read off `formatToParts`
 * rather than hardcoded, so a locale change cannot strand the symbol mid-range.
 *
 * The SIGN stays on both bounds. It is the only thing distinguishing a variable income from a
 * variable expense in text, and colour is not allowed to carry that alone.
 *
 * Magnitudes are unsigned (see `forecast.ts`) and rounded to the euro: a `,00 €` on an observed
 * bound would assert a precision that does not exist.
 */
export function formatAmountRangeBounds(
	minMagnitudeCents: number,
	maxMagnitudeCents: number,
	sign: string,
	locale: string
): { min: string; max: string } {
	const formatter = new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'EUR',
		maximumFractionDigits: 0
	});
	const withSymbol = (magnitudeCents: number) => `${sign}${formatter.format(magnitudeCents / 100)}`;
	const withoutSymbol = (magnitudeCents: number) =>
		`${sign}${formatter
			.formatToParts(magnitudeCents / 100)
			// `literal` goes too: it is the separating space that only exists for the symbol.
			.filter((part) => part.type !== 'currency' && part.type !== 'literal')
			.map((part) => part.value)
			.join('')}`;

	const parts = formatter.formatToParts(1);
	const symbolLast = parts[parts.length - 1]?.type === 'currency';
	return symbolLast
		? { min: withoutSymbol(minMagnitudeCents), max: withSymbol(maxMagnitudeCents) }
		: { min: withSymbol(minMagnitudeCents), max: withoutSymbol(maxMagnitudeCents) };
}

export interface ObservationCandidate {
	label: string;
	occurrenceCount: number;
}

const OBSERVATION_CANDIDATE_LIMIT = 3;
const OBSERVATION_CANDIDATE_OCCURRENCES = 2;

/**
 * Pairs the detector looked at and REJECTED: exactly two same-label, same-direction, same-category,
 * similar-amount transactions that no detected flow claims.
 *
 * Note what this is not. A pair with a plausible cadence is already accepted by
 * `detectRecurringFlows` as a `tentative` flow, so its ids land in some flow's `occurrenceIds` and
 * the `claimedIds` filter removes it here — it is shown as an uncertain-tier bill, not as a
 * candidate. What survives is the pairs whose median interval matched no cadence window (two
 * transactions 45 days apart, say): too irregular to schedule, too suggestive to hide. They are
 * surfaced as "en observation" so the user can see the app noticed the pattern and is waiting for a
 * third occurrence to place it.
 *
 * Grouping goes through `groupTransactionsForRecurrence` and `getSimilarAmountGroups` — the
 * detector's own two steps, called rather than reimplemented, so the two views cannot disagree
 * about what counts as one stream.
 */
export function listObservationCandidates(
	transactions: readonly ForecastInputTransaction[],
	flows: readonly RecurringFlow[]
): ObservationCandidate[] {
	const claimedIds = new Set(flows.flatMap((flow) => flow.occurrenceIds));
	const groups = groupTransactionsForRecurrence(transactions);
	const candidates: { label: string; lastDate: string }[] = [];

	for (const groupTransactions of groups.values()) {
		for (const group of getSimilarAmountGroups(groupTransactions)) {
			if (group.length !== OBSERVATION_CANDIDATE_OCCURRENCES) continue;
			if (group.some((transaction) => claimedIds.has(transaction.id))) continue;

			const sorted = [...group].sort((left, right) => left.date.localeCompare(right.date));
			const mostRecent = sorted[sorted.length - 1];
			candidates.push({ label: mostRecent.label, lastDate: mostRecent.date });
		}
	}

	return (
		candidates
			// Most recent first; label breaks ties so the cap below is deterministic.
			.sort(
				(left, right) =>
					right.lastDate.localeCompare(left.lastDate) || left.label.localeCompare(right.label)
			)
			.slice(0, OBSERVATION_CANDIDATE_LIMIT)
			.map((candidate) => ({
				label: candidate.label,
				occurrenceCount: OBSERVATION_CANDIDATE_OCCURRENCES
			}))
	);
}
