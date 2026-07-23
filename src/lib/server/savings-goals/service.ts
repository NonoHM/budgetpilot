import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	computeSavingsGoalProgress,
	isSavingsGoalLinkableAccountType,
	resolveSavingsGoalCurrentAmountCents,
	type SavingsGoalStatus
} from '$lib/domain/savingsGoal';
import { parseNetWorthBalanceCents, type NetWorthAccountType } from '$lib/domain/netWorth';
import { prisma } from '$lib/server/db';
import { normalizeId } from '$lib/server/transactions/where';

const MAX_NAME_LENGTH = 120;
const MAX_TARGET_AMOUNT_CENTS = 1_000_000_000;

export interface SaveSavingsGoalInput {
	name: string;
	targetAmount: string;
	/** 'manual' or 'linked'. Anything else is rejected. */
	trackingMode: string;
	netWorthAccountId?: string;
	/** Only used when trackingMode is 'manual'. Empty/absent = 0. */
	currentAmount?: string;
	/** Optional deadline (YYYY-MM-DD). Empty/absent = no deadline. */
	targetDate?: string;
}

export interface SavingsGoalRecord {
	id: string;
	name: string;
	targetAmountCents: number;
	currentAmountCents: number;
	startingBalanceCents: number;
	targetDate: string | null;
	progressPercent: number;
	status: SavingsGoalStatus;
	linkedAccount: { id: string; name: string } | null;
	/** True once the linked account was removed/soft-deleted after the goal was linked — the
	 *  displayed amount is then frozen at its last known value (currentAmountCents). */
	linkStale: boolean;
	reachedAt: string | null;
	reachedBannerDismissedAt: string | null;
	createdAt: string;
}

type SavingsGoalWithAccount = Awaited<ReturnType<typeof findActiveGoals>>[number];

async function findActiveGoals(userId: string) {
	return prisma.savingsGoal.findMany({
		where: { userId, deletedAt: null },
		orderBy: { createdAt: 'asc' },
		include: {
			netWorthAccount: {
				select: { id: true, name: true, balanceCents: true, deletedAt: true }
			}
		}
	});
}

/**
 * Active goals with progress computed live (from the linked account's balance, or the goal's
 * own currentAmountCents), and reachedAt set lazily the first time this detects the target is
 * met — mirrors the "write on change" pattern already used by NetWorthSnapshot. reachedAt is
 * never rewritten once set, and the status badge itself always stays independently live.
 */
export async function readSavingsGoals(userId: string): Promise<SavingsGoalRecord[]> {
	const goals = await findActiveGoals(userId);
	const now = new Date();

	const records = await Promise.all(
		goals.map(async (goal) => {
			const linkStale = goal.netWorthAccountId !== null && goal.netWorthAccount?.deletedAt != null;
			const linkedBalanceCents =
				goal.netWorthAccount && goal.netWorthAccount.deletedAt == null
					? goal.netWorthAccount.balanceCents
					: null;
			const currentAmountCents = resolveSavingsGoalCurrentAmountCents(goal, linkedBalanceCents);

			const progress = computeSavingsGoalProgress({
				targetAmountCents: goal.targetAmountCents,
				currentAmountCents,
				startingBalanceCents: goal.startingBalanceCents,
				targetDate: goal.targetDate,
				createdAt: goal.createdAt,
				now
			});

			let reachedAt = goal.reachedAt;
			const updateData: { reachedAt?: Date; currentAmountCents?: number } = {};

			if (progress.status === 'reached' && reachedAt === null) {
				reachedAt = now;
				updateData.reachedAt = now;
			}

			// Keeps currentAmountCents in sync with the live linked balance on every read, so that
			// if the link later goes stale (account soft-deleted/unlinked), the "frozen at its last
			// known value" fallback (see linkStale below) actually reflects the last known value —
			// not whatever was captured at goal creation/last edit.
			if (linkedBalanceCents !== null && linkedBalanceCents !== goal.currentAmountCents) {
				updateData.currentAmountCents = linkedBalanceCents;
			}

			if (Object.keys(updateData).length > 0) {
				await prisma.savingsGoal.update({ where: { id: goal.id }, data: updateData });
			}

			return toRecord(goal, progress, currentAmountCents, linkStale, reachedAt);
		})
	);

	return records;
}

export interface SavingsGoalHistoryPoint {
	capturedAt: string;
	balanceCents: number;
}

/** Snapshot history for the linked account, empty for a manually tracked goal (no snapshots exist). */
export async function readSavingsGoalHistory(
	userId: string,
	goalId: string
): Promise<SavingsGoalHistoryPoint[]> {
	const id = normalizeId(goalId);
	if (!id) throw error(404, m.savings_goal_error_not_found());

	const goal = await prisma.savingsGoal.findFirst({
		where: { id, userId, deletedAt: null },
		select: { netWorthAccountId: true }
	});
	if (!goal) throw error(404, m.savings_goal_error_not_found());
	if (!goal.netWorthAccountId) return [];

	const snapshots = await prisma.netWorthSnapshot.findMany({
		where: { userId, accountId: goal.netWorthAccountId },
		orderBy: { capturedAt: 'asc' },
		select: { capturedAt: true, balanceCents: true }
	});

	return snapshots.map((snapshot) => ({
		capturedAt: snapshot.capturedAt.toISOString(),
		balanceCents: snapshot.balanceCents
	}));
}

export async function createSavingsGoal(
	userId: string,
	input: SaveSavingsGoalInput
): Promise<{ id: string }> {
	const parsed = await validateInput(userId, input);

	const created = await prisma.savingsGoal.create({
		data: {
			userId,
			name: parsed.name,
			targetAmountCents: parsed.targetAmountCents,
			netWorthAccountId: parsed.netWorthAccountId,
			currentAmountCents: parsed.currentAmountCents,
			startingBalanceCents: parsed.currentAmountCents,
			targetDate: parsed.targetDate
		},
		select: { id: true }
	});

	return { id: created.id };
}

export async function updateSavingsGoal(
	userId: string,
	goalId: string,
	input: SaveSavingsGoalInput
): Promise<void> {
	const id = normalizeId(goalId);
	if (!id) throw error(404, m.savings_goal_error_not_found());

	const existing = await prisma.savingsGoal.findFirst({ where: { id, userId, deletedAt: null } });
	if (!existing) throw error(404, m.savings_goal_error_not_found());

	const parsed = await validateInput(userId, input);

	await prisma.savingsGoal.updateMany({
		where: { id, userId },
		data: {
			name: parsed.name,
			targetAmountCents: parsed.targetAmountCents,
			netWorthAccountId: parsed.netWorthAccountId,
			currentAmountCents: parsed.currentAmountCents,
			targetDate: parsed.targetDate
			// startingBalanceCents is intentionally never touched by an edit: it's a fixed
			// informational anchor set once at creation, used only to estimate the real saving
			// pace since the goal was created.
		}
	});
}

/** Soft delete, consistent with deleteNetWorthAccount. */
export async function deleteSavingsGoal(userId: string, goalId: string): Promise<void> {
	const id = normalizeId(goalId);
	if (!id) throw error(404, m.savings_goal_error_not_found());

	const result = await prisma.savingsGoal.updateMany({
		where: { id, userId, deletedAt: null },
		data: { deletedAt: new Date() }
	});
	if (result.count === 0) throw error(404, m.savings_goal_error_not_found());
}

/**
 * Marks the one-time "goal reached" banner as dismissed. Once set, it never reappears — even
 * after a later re-crossing of the target (reachedAt itself is never reset either).
 */
export async function dismissReachedBanner(userId: string, goalId: string): Promise<void> {
	const id = normalizeId(goalId);
	if (!id) throw error(404, m.savings_goal_error_not_found());

	const result = await prisma.savingsGoal.updateMany({
		where: { id, userId, deletedAt: null, reachedAt: { not: null } },
		data: { reachedBannerDismissedAt: new Date() }
	});
	if (result.count === 0) throw error(404, m.savings_goal_error_not_found());
}

async function validateInput(
	userId: string,
	input: SaveSavingsGoalInput
): Promise<{
	name: string;
	targetAmountCents: number;
	netWorthAccountId: string | null;
	currentAmountCents: number;
	targetDate: Date | null;
}> {
	const name = input.name.trim();
	if (!name || name.length > MAX_NAME_LENGTH) throw error(400, m.savings_goal_error_invalid_name());

	const targetAmountCents = parseNetWorthBalanceCents(input.targetAmount);
	if (
		targetAmountCents === null ||
		targetAmountCents <= 0 ||
		targetAmountCents > MAX_TARGET_AMOUNT_CENTS
	) {
		throw error(400, m.savings_goal_error_invalid_target());
	}

	const linked = input.trackingMode === 'linked';
	if (!linked && input.trackingMode !== 'manual') {
		throw error(400, m.savings_goal_error_invalid_account());
	}

	let netWorthAccountId: string | null = null;
	let currentAmountCents = 0;

	if (linked) {
		netWorthAccountId = normalizeId(input.netWorthAccountId ?? '');
		if (!netWorthAccountId) throw error(400, m.savings_goal_error_invalid_account());

		const account = await prisma.netWorthAccount.findFirst({
			where: { id: netWorthAccountId, userId, deletedAt: null },
			select: { type: true, balanceCents: true }
		});
		if (!account || !isSavingsGoalLinkableAccountType(account.type as NetWorthAccountType)) {
			throw error(400, m.savings_goal_error_invalid_account());
		}
		currentAmountCents = account.balanceCents;
	} else {
		const rawCurrent = (input.currentAmount ?? '').trim();
		if (rawCurrent) {
			const parsedCurrent = parseNetWorthBalanceCents(rawCurrent);
			if (parsedCurrent === null || parsedCurrent < 0) {
				throw error(400, m.savings_goal_error_invalid_current());
			}
			currentAmountCents = parsedCurrent;
		}
	}

	const targetDate = parseTargetDate(input.targetDate);
	if (targetDate === false) throw error(400, m.savings_goal_error_invalid_date());

	return { name, targetAmountCents, netWorthAccountId, currentAmountCents, targetDate };
}

/** Empty/absent = no deadline (null). Malformed date = false (rejected by the caller). */
function parseTargetDate(raw: string | undefined): Date | null | false {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;

	const parsed = new Date(`${trimmed}T12:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return false;

	return parsed;
}

function toRecord(
	goal: SavingsGoalWithAccount,
	progress: { progressPercent: number; status: SavingsGoalStatus },
	currentAmountCents: number,
	linkStale: boolean,
	reachedAt: Date | null
): SavingsGoalRecord {
	return {
		id: goal.id,
		name: goal.name,
		targetAmountCents: goal.targetAmountCents,
		currentAmountCents,
		startingBalanceCents: goal.startingBalanceCents,
		targetDate: goal.targetDate ? goal.targetDate.toISOString() : null,
		progressPercent: progress.progressPercent,
		status: progress.status,
		linkedAccount:
			goal.netWorthAccount && !linkStale
				? { id: goal.netWorthAccount.id, name: goal.netWorthAccount.name }
				: null,
		linkStale,
		reachedAt: reachedAt ? reachedAt.toISOString() : null,
		reachedBannerDismissedAt: goal.reachedBannerDismissedAt
			? goal.reachedBannerDismissedAt.toISOString()
			: null,
		createdAt: goal.createdAt.toISOString()
	};
}
