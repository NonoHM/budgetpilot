import type {
	FlowDirection,
	FlowDisplayTier,
	ForecastInputTransaction,
	RecurringFlow
} from './forecast';
import { getFlowDisplayTier, projectFlowOccurrences } from './forecast';
import { getSimilarAmountGroups, normalizeRecurringLabel } from './recurrence';
import { getTransactionKind } from './transaction';

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
	/** Uncertain tier only: the estimated date is in the past. Drives the "date estimée dépassée"
	 *  copy — a plain date comparison, deliberately NOT a lateness computation (see
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

function toEpochMs(iso: string): number {
	return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

/** Whole days elapsed from `dateIso` to `todayIso`; positive when `dateIso` is in the past. */
function wholeDaysBetween(dateIso: string, todayIso: string): number {
	return Math.floor((toEpochMs(todayIso) - toEpochMs(dateIso)) / MS_PER_DAY);
}

/**
 * Stream identity for a persisted action. Anchor transaction ids come first and are authoritative:
 * they survive a label the detector later re-reads from a more recent occurrence. The normalized
 * label + direction pair is the fallback for a stream whose historical transactions have since
 * rolled out of the lookback window.
 */
export function actionMatchesFlow(
	action: Pick<StreamActionInput, 'direction' | 'normalizedLabel' | 'anchorTransactionIds'>,
	flow: Pick<RecurringFlow, 'direction' | 'label' | 'occurrenceIds'>
): boolean {
	if (action.anchorTransactionIds.some((id) => flow.occurrenceIds.includes(id))) return true;
	if (action.direction !== flow.direction) return false;
	return action.normalizedLabel === normalizeRecurringLabel(flow.label);
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
 * action to still apply. Half the cadence absorbs the projection drift that appears as new
 * transactions shift the anchor, while staying strictly under one interval so a weekly stream's
 * action can never bleed onto the next occurrence. Clamped to [1, 15] so a yearly stream does not
 * get a six-month window.
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

function findApplicableAction(
	actions: readonly StreamActionInput[],
	kind: StreamActionKind,
	flow: RecurringFlow,
	dateIso: string
): StreamActionInput | undefined {
	const windowDays = occurrenceActionWindowDays(flow);
	return actions.find(
		(action) =>
			action.kind === kind &&
			action.dueDate !== null &&
			Math.abs(wholeDaysBetween(action.dueDate, dateIso)) <= windowDays &&
			actionMatchesFlow(action, flow)
	);
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
				estimatePassed: tier === 'uncertain' && transaction.date < input.todayIso,
				amountCents: transaction.amountCents,
				settledKind: 'auto',
				settledTransactionId: transaction.id,
				appliedActionId: null,
				countsInRemainingTotal: false
			});
		}

		// Projected: everything still to come inside the period.
		for (const projected of projectFlowOccurrences(flow, input.fromIso, horizonDays)) {
			if (projected.date >= input.toIsoExclusive) continue;

			const estimatePassed = tier === 'uncertain' && projected.date < input.todayIso;
			const paid = findApplicableAction(input.actions, 'paid', flow, projected.date);

			if (paid) {
				occurrences.push({
					flow,
					tier,
					dateIso: projected.date,
					status: 'settled',
					daysLate: null,
					estimatePassed,
					amountCents: signedAverageCents,
					settledKind: 'manual',
					settledTransactionId: null,
					appliedActionId: paid.id,
					countsInRemainingTotal: false
				});
				continue;
			}

			const ignored = findApplicableAction(input.actions, 'ignore', flow, projected.date);

			if (ignored) {
				occurrences.push({
					flow,
					tier,
					dateIso: projected.date,
					status: 'ignored',
					daysLate: null,
					estimatePassed,
					amountCents: signedAverageCents,
					settledKind: null,
					settledTransactionId: null,
					appliedActionId: ignored.id,
					countsInRemainingTotal: false
				});
				continue;
			}

			const { status, daysLate } = computeOccurrenceStatus(tier, projected.date, input.todayIso);

			occurrences.push({
				flow,
				tier,
				dateIso: projected.date,
				status,
				daysLate,
				estimatePassed,
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

export interface ObservationCandidate {
	label: string;
	occurrenceCount: number;
}

const OBSERVATION_CANDIDATE_LIMIT = 3;
const OBSERVATION_CANDIDATE_OCCURRENCES = 2;

/**
 * Streams the detector is still one occurrence short of accepting: exactly two same-label,
 * same-direction, same-category, similar-amount transactions that no detected flow claims. Rebuilds
 * the detector's own grouping (same normalization, same amount clustering) so the two views cannot
 * disagree about what counts as the same stream. Surfaced as "en observation" rather than silently
 * dropped, so the user sees the app noticed the pattern.
 */
export function listObservationCandidates(
	transactions: readonly ForecastInputTransaction[],
	flows: readonly RecurringFlow[]
): ObservationCandidate[] {
	const claimedIds = new Set(flows.flatMap((flow) => flow.occurrenceIds));
	const groups = new Map<string, ForecastInputTransaction[]>();

	for (const transaction of transactions) {
		const normalizedLabel = normalizeRecurringLabel(transaction.label);
		if (!normalizedLabel) continue;

		const direction: FlowDirection =
			getTransactionKind(transaction) === 'income' ? 'income' : 'expense';
		const key = `${direction}:${normalizedLabel}:${transaction.category}`;
		groups.set(key, [...(groups.get(key) ?? []), transaction]);
	}

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

/**
 * Avatar initials for a stream label. A single short word is kept whole ("EDF"), a single long one
 * is cut to two characters ("Netflix" -> "NE"), and a multi-word label takes the first letter of
 * its first two words ("Assurance auto" -> "AA"). Deterministic by design — the same label always
 * renders the same badge.
 */
export function getLabelInitials(label: string): string {
	const words = label.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return '';
	if (words.length === 1) {
		const word = words[0];
		return (word.length <= 3 ? word.slice(0, 3) : word.slice(0, 2)).toUpperCase();
	}
	return words
		.slice(0, 2)
		.map((word) => word.slice(0, 1).toUpperCase())
		.join('');
}
