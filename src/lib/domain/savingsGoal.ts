import * as m from '$lib/paraglide/messages';
import { formatCents } from './budget';
import { isLinkableNetWorthAccountType, type NetWorthAccountType } from './netWorth';

export type SavingsGoalStatus = 'in_progress' | 'behind' | 'reached';

/**
 * Single source of truth for which NetWorthAccount types a savings goal may link to — shared
 * between the server-side validation (server/savings-goals/service.ts) and the client-side
 * Combobox filter (routes/net-worth/+page.server.ts), so the UI never offers an option the
 * server would reject anyway. isLinkableNetWorthAccountType() also allows 'debt' (relevant for
 * linking a technical Account bucket to track its transactions), but a savings goal is an
 * accumulation target: comparing a raw (unsigned) debt balance against a target would have
 * inverted, nonsensical semantics — a debt balance naturally decreasing over time would read as
 * "regressing" toward the goal instead of progressing.
 */
export function isSavingsGoalLinkableAccountType(type: NetWorthAccountType): boolean {
	return isLinkableNetWorthAccountType(type) && type !== 'debt';
}

const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;

/**
 * Resolves the amount to compare against the target: the linked account's live balance when
 * present, otherwise the goal's own declarative `currentAmountCents`. The caller is responsible
 * for passing `null` when the link is stale (account soft-deleted or removed) — this function
 * doesn't know about NetWorthAccount, it just implements the fallback.
 */
export function resolveSavingsGoalCurrentAmountCents(
	goal: { currentAmountCents: number },
	linkedAccountBalanceCents: number | null
): number {
	return linkedAccountBalanceCents ?? goal.currentAmountCents;
}

function monthsBetween(from: Date, to: Date): number {
	return (to.getTime() - from.getTime()) / MS_PER_MONTH;
}

export interface SavingsGoalProgressInput {
	targetAmountCents: number;
	currentAmountCents: number;
	startingBalanceCents: number;
	targetDate: Date | null;
	createdAt: Date;
	now?: Date;
}

export interface SavingsGoalProgress {
	currentAmountCents: number;
	progressPercent: number;
	status: SavingsGoalStatus;
}

/**
 * A goal younger than one full month never shows "behind", regardless of the pace comparison
 * below (or of a past-but-recent targetDate — see the grace-period check at the end of
 * computeSavingsGoalProgress). Reason: with under a month of history, "real pace since creation"
 * is inherently noisy/meaningless (e.g. a goal created seconds ago has real pace ~0 by
 * construction — current equals starting at creation — which would immediately read as "behind"
 * against almost any positive required pace, the instant the goal exists). Rather than produce a
 * technically-correct-but-alarming verdict on a goal nobody has had a chance to contribute to
 * yet, the badge stays neutral ("in progress") until there's at least one month of real signal.
 */
const GRACE_PERIOD_MONTHS = 1;

/**
 * Status "behind" only applies when a targetDate exists and the goal isn't reached yet: it
 * compares the real saving pace since creation ((current - starting) / months elapsed) against
 * the pace required to still hit the target on time ((target - current) / months remaining). A
 * goal past its deadline and not yet reached is always "behind" (no months remaining left to
 * spread the required amount over) — subject to the grace period above like any other "behind"
 * verdict.
 */
export function computeSavingsGoalProgress(input: SavingsGoalProgressInput): SavingsGoalProgress {
	const { targetAmountCents, currentAmountCents, startingBalanceCents, targetDate, createdAt } =
		input;
	const now = input.now ?? new Date();

	const progressPercent =
		targetAmountCents > 0
			? Math.max(0, Math.min(100, Math.round((currentAmountCents / targetAmountCents) * 100)))
			: 0;

	if (currentAmountCents >= targetAmountCents) {
		return { currentAmountCents, progressPercent, status: 'reached' };
	}

	if (!targetDate) {
		return { currentAmountCents, progressPercent, status: 'in_progress' };
	}

	const monthsElapsed = monthsBetween(createdAt, now);
	const withinGracePeriod = monthsElapsed < GRACE_PERIOD_MONTHS;

	const monthsRemaining = monthsBetween(now, targetDate);
	if (monthsRemaining <= 0) {
		return {
			currentAmountCents,
			progressPercent,
			status: withinGracePeriod ? 'in_progress' : 'behind'
		};
	}

	const requiredMonthlyPace = (targetAmountCents - currentAmountCents) / monthsRemaining;
	const realMonthlyPace =
		monthsElapsed > 0 ? (currentAmountCents - startingBalanceCents) / monthsElapsed : 0;

	const status: SavingsGoalStatus =
		!withinGracePeriod && realMonthlyPace < requiredMonthlyPace ? 'behind' : 'in_progress';
	return { currentAmountCents, progressPercent, status };
}

/**
 * (target - current) / months remaining until targetDate. Returns null when there's no
 * targetDate, or the deadline has already passed (no projection of a new date in V1).
 */
export function computeSuggestedMonthlyPaceCents(
	targetAmountCents: number,
	currentAmountCents: number,
	targetDate: Date | null,
	now: Date = new Date()
): number | null {
	if (!targetDate) return null;
	const monthsRemaining = monthsBetween(now, targetDate);
	if (monthsRemaining <= 0) return null;

	return Math.max(0, (targetAmountCents - currentAmountCents) / monthsRemaining);
}

export type GoalDeltaTone = 'positive' | 'warning' | 'neutral';

export interface GoalDelta {
	tone: GoalDeltaTone;
	text: string;
}

/**
 * Color semantics deliberately inverted vs formatBudgetDelta(): reaching the goal is emerald
 * (good), falling behind pace is amber, and the neutral "in progress" state carries no color at
 * all — a savings goal isn't a limit to stay under, it's a target to fill.
 */
export function formatGoalDelta(status: SavingsGoalStatus, remainingCents: number): GoalDelta {
	if (status === 'reached') {
		return { tone: 'positive', text: m.savings_goal_status_reached() };
	}
	if (status === 'behind') {
		return { tone: 'warning', text: m.savings_goal_delta_behind() };
	}
	return {
		tone: 'neutral',
		text: m.savings_goal_delta_remaining({ amount: formatCents(remainingCents) })
	};
}
