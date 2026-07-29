import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	buildNetWorthTimeline,
	isLinkableNetWorthAccountType,
	isNetWorthAccountType,
	parseNetWorthBalanceCents,
	type NetWorthAccountType,
	type NetWorthTimelinePoint
} from '$lib/domain/netWorth';
import { prisma } from '$lib/server/db';
import { normalizeId } from '$lib/server/transactions/where';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { ensureManualAccount, findManualAccount } from '$lib/server/budget/dashboard';

const MAX_NAME_LENGTH = 120;

export interface SaveNetWorthAccountInput {
	name: string;
	type: string;
	balance: string;
	/** Optional "as of" date (YYYY-MM-DD) for backdating a snapshot. Empty/absent = now. */
	asOfDate?: string;
}

export interface NetWorthAccountRecord {
	id: string;
	name: string;
	type: NetWorthAccountType;
	balanceCents: number;
	createdAt: string;
	updatedAt: string;
	/** True when at least one technical Account (manual entry or CSV import bucket) links here. */
	connected: boolean;
}

/** Active (non soft-deleted) accounts only — the current list/donut/total. */
export async function readNetWorthAccounts(userId: string): Promise<NetWorthAccountRecord[]> {
	const accounts = await prisma.netWorthAccount.findMany({
		where: { userId, deletedAt: null },
		orderBy: { createdAt: 'asc' },
		include: { _count: { select: { accounts: true } } }
	});

	return accounts.map(toRecord);
}

/**
 * Every snapshot for this user, including snapshots of soft-deleted accounts: the timeline
 * must keep showing historically-correct past points even after an account is "removed"
 * from the current list (see buildNetWorthTimeline's doc comment).
 */
export async function readNetWorthSeries(userId: string): Promise<NetWorthTimelinePoint[]> {
	const snapshots = await prisma.netWorthSnapshot.findMany({
		where: { userId },
		select: { accountId: true, type: true, balanceCents: true, capturedAt: true }
	});

	return buildNetWorthTimeline(
		snapshots.map((snapshot) => ({ ...snapshot, type: snapshot.type as NetWorthAccountType }))
	);
}

export async function createNetWorthAccount(
	userId: string,
	input: SaveNetWorthAccountInput
): Promise<{ id: string }> {
	const { name, type, balanceCents, capturedAt } = validateInput(input);

	return prisma.$transaction(async (tx) => {
		await assertNameAvailable(tx, userId, name, null);

		const created = await tx.netWorthAccount.create({
			data: { userId, name, nameKey: computeNameKey(name), type, balanceCents }
		});
		await tx.netWorthSnapshot.create({
			data: { userId, accountId: created.id, type, balanceCents, capturedAt }
		});

		return { id: created.id };
	});
}

export async function updateNetWorthAccount(
	userId: string,
	accountId: string,
	input: SaveNetWorthAccountInput
): Promise<void> {
	if (!normalizeId(accountId)) throw error(404, m.net_worth_error_not_found());

	const { name, type, balanceCents, capturedAt } = validateInput(input);

	await prisma.$transaction(async (tx) => {
		// Read-then-write inside the SAME transaction (SQLite serializes writers), closing the
		// TOCTOU gap of a prior version that read `existing` before starting the transaction:
		// a concurrent update could otherwise slip in between the read and the write below.
		const existing = await tx.netWorthAccount.findFirst({
			where: { id: accountId, userId, deletedAt: null }
		});
		if (!existing) throw error(404, m.net_worth_error_not_found());

		await assertNameAvailable(tx, userId, name, accountId);

		await tx.netWorthAccount.updateMany({
			where: { id: accountId, userId },
			data: { name, nameKey: computeNameKey(name), type, balanceCents }
		});

		// A snapshot is written on any change that affects the signed value shown on the
		// curve — not just the balance: changing type alone (e.g. savings -> debt) flips the
		// sign of the SAME balance, and must appear as its own point going forward, not be
		// silently absorbed into the next unrelated balance edit.
		if (balanceCents !== existing.balanceCents || type !== existing.type) {
			await tx.netWorthSnapshot.create({
				data: { userId, accountId, type, balanceCents, capturedAt }
			});
		}

		// A type change to a non-linkable type (real_estate/other) invalidates the "transactional
		// types only" restriction from the linking UI: unlink every technical Account pointing here
		// (manual bucket AND CSV import buckets alike), not just the manual one — otherwise a
		// CSV-linked bucket would keep showing a house/other as its net worth account.
		if (type !== existing.type && !isLinkableNetWorthAccountType(type)) {
			await tx.account.updateMany({
				where: { userId, netWorthAccountId: accountId },
				data: { netWorthAccountId: null }
			});
		}
	});
}

/**
 * Soft delete: preserves past snapshots so the timeline keeps its historical shape. Also
 * unlinks every technical Account pointing here (manual + CSV import buckets) rather than
 * leaving a dangling link — a later account recreated with the same name must not inherit
 * a stale connection, and the transaction detail view must fall back to the raw account
 * name/source instead of continuing to show a deleted net worth account's name.
 */
export async function deleteNetWorthAccount(userId: string, accountId: string): Promise<void> {
	if (!normalizeId(accountId)) throw error(404, m.net_worth_error_not_found());

	await prisma.$transaction(async (tx) => {
		const result = await tx.netWorthAccount.updateMany({
			where: { id: accountId, userId, deletedAt: null },
			data: { deletedAt: new Date() }
		});
		if (result.count === 0) throw error(404, m.net_worth_error_not_found());

		await tx.account.updateMany({
			where: { userId, netWorthAccountId: accountId },
			data: { netWorthAccountId: null }
		});
	});
}

export interface LinkableNetWorthAccountOption {
	id: string;
	name: string;
}

/**
 * Active, linkable-type NetWorthAccounts — the single source for every "destination account"
 * Combobox that lets a bucket link to a NetWorthAccount (the CSV import selector on /import
 * and the bank-sync explicit-link UI on /imports/bank-connections). Never re-derive this
 * filter/map at a call site.
 */
export async function readLinkableNetWorthAccounts(
	userId: string
): Promise<LinkableNetWorthAccountOption[]> {
	const accounts = await readNetWorthAccounts(userId);
	return accounts
		.filter((account) => isLinkableNetWorthAccountType(account.type))
		.map((account) => ({ id: account.id, name: account.name }));
}

/** Net worth account currently linked to the implicit manual-entry bucket, if any. */
export async function getManualAccountNetWorthLink(userId: string): Promise<string | null> {
	const account = await findManualAccount(userId);
	return account?.netWorthAccountId ?? null;
}

/**
 * Links (or clears, when `netWorthAccountId` is null) the manual-entry bucket to a net worth
 * account. Creates the bucket on demand (ensureManualAccount) so this works even before the
 * user has ever entered a manual transaction. Scoped by id AND userId, defense in depth on top
 * of ensureManualAccount already being userId-scoped. When linking, also revalidates the target
 * itself (owned, not soft-deleted) rather than trusting the caller's prior check — this function
 * is the last line of defense before the write, and a future/forgotten caller must not be able
 * to bypass that guarantee.
 */
export async function setManualAccountNetWorthLink(
	userId: string,
	netWorthAccountId: string | null
): Promise<void> {
	if (netWorthAccountId !== null) {
		const target = await prisma.netWorthAccount.findFirst({
			where: { id: netWorthAccountId, userId, deletedAt: null },
			select: { id: true }
		});
		if (!target) throw error(404, m.net_worth_error_not_found());
	}

	const account = await ensureManualAccount(userId);
	await prisma.account.updateMany({
		where: { id: account.id, userId },
		data: { netWorthAccountId }
	});
}

/**
 * Explicitly links (or unlinks, when `netWorthAccountId` is null) a bank-sync technical
 * Account bucket to a NetWorthAccount — the bank-sync analogue of
 * setManualAccountNetWorthLink, but targets one specific bucket (by id) rather than the
 * implicit manual one, and is restricted to bank-sync buckets (`Account.bankConnectionId`
 * set): CSV/manual buckets keep going through resolveImportBucketAccount's create-time link,
 * this function is never their path.
 *
 * Enforces the "no two synchronized buckets on one NetWorthAccount" rule (D4): a future
 * balance-snapshot writer (bank-sync sync step) would otherwise have two authoritative bank
 * balances fighting over the same NetWorthAccount. A CSV/manual bucket already linked to the
 * target is NOT a conflict — it never writes a balance snapshot automatically, only a
 * SYNCHRONIZED bucket (bankConnectionId set) does.
 *
 * The D4 conflict check (read) and the link (write) run inside the SAME transaction — same
 * TOCTOU fix as updateNetWorthAccount above: without it, two concurrent requests linking
 * different bank buckets to the same target could both pass the conflict read before either
 * writes, defeating D4.
 */
export async function linkBankAccountToNetWorth(
	userId: string,
	accountId: string,
	netWorthAccountId: string | null
): Promise<void> {
	const normalizedAccountId = normalizeId(accountId);
	if (!normalizedAccountId) throw error(404, m.net_worth_error_not_found());

	await prisma.$transaction(async (tx) => {
		const bucket = await tx.account.findFirst({
			where: { id: normalizedAccountId, userId, bankConnectionId: { not: null } },
			select: { id: true }
		});
		if (!bucket) throw error(404, m.net_worth_error_not_found());

		if (netWorthAccountId !== null) {
			const target = await tx.netWorthAccount.findFirst({
				where: { id: netWorthAccountId, userId, deletedAt: null },
				select: { id: true, type: true }
			});
			if (!target || !isLinkableNetWorthAccountType(target.type as NetWorthAccountType)) {
				throw error(404, m.net_worth_error_not_found());
			}

			const conflictingSyncedBucket = await tx.account.findFirst({
				where: {
					userId,
					netWorthAccountId,
					bankConnectionId: { not: null },
					id: { not: bucket.id }
				},
				select: { id: true }
			});
			if (conflictingSyncedBucket) throw error(409, m.net_worth_error_already_synced());
		}

		await tx.account.updateMany({
			where: { id: bucket.id, userId },
			data: { netWorthAccountId }
		});
	});
}

/**
 * Write-on-change balance snapshot from a successful bank sync — the bank-sync analogue of
 * updateNetWorthAccount's "write a snapshot only if the persisted value actually changed"
 * rule (D5), but the balance comes directly from the provider, never derived/calculated from
 * the app's own transaction history (that idea was explored and explicitly dropped for
 * manual/CSV accounts — see CLAUDE.md's net-worth entries; this is a different source, not a
 * resurrection of it).
 *
 * Called by the sync service once per synced bucket whose netWorthAccountId is set, AFTER a
 * successful transaction sync. A missing/stale/soft-deleted target is a silent no-op, never
 * a thrown error: this runs inside a background sync and must never fail the sync it rides
 * along with (same posture as a balance-fetch error, handled one level up by the caller).
 * Sign handling: `balanceCents` is persisted exactly as the connector reports it — the LOAN
 * sign convention is unconfirmed pending sandbox validation (flagged, not an oversight).
 */
export async function recordSyncedBalance(
	userId: string,
	netWorthAccountId: string,
	balanceCents: number,
	capturedAt: Date
): Promise<void> {
	await prisma.$transaction(async (tx) => {
		const existing = await tx.netWorthAccount.findFirst({
			where: { id: netWorthAccountId, userId, deletedAt: null },
			select: { id: true, type: true, balanceCents: true }
		});
		if (!existing) return;
		if (existing.balanceCents === balanceCents) return;

		await tx.netWorthAccount.update({
			where: { id: existing.id },
			data: { balanceCents }
		});
		await tx.netWorthSnapshot.create({
			data: { userId, accountId: existing.id, type: existing.type, balanceCents, capturedAt }
		});
	});
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Uniqueness of (userId, name) enforced here against ACTIVE accounts only (see
 * schema.prisma).
 *
 * Compares on `nameKey`, not on `name`: a raw SQL equality on user text is answered by the
 * column's collation, so the same two names would be a conflict on one database engine and
 * not on another. The key is computed by the app, so the answer is the same everywhere.
 */
async function assertNameAvailable(
	tx: Tx,
	userId: string,
	name: string,
	excludeAccountId: string | null
): Promise<void> {
	const conflict = await tx.netWorthAccount.findFirst({
		where: {
			userId,
			nameKey: computeNameKey(name),
			deletedAt: null,
			...(excludeAccountId ? { id: { not: excludeAccountId } } : {})
		},
		select: { id: true }
	});
	if (conflict) throw error(400, m.net_worth_error_duplicate_name());
}

function validateInput(input: SaveNetWorthAccountInput): {
	name: string;
	type: NetWorthAccountType;
	balanceCents: number;
	capturedAt: Date;
} {
	const name = input.name.trim();
	if (!name || name.length > MAX_NAME_LENGTH) throw error(400, m.net_worth_error_invalid_name());
	if (!isNetWorthAccountType(input.type)) throw error(400, m.net_worth_error_invalid_type());

	const balanceCents = parseNetWorthBalanceCents(input.balance);
	if (balanceCents === null) throw error(400, m.net_worth_error_invalid_balance());

	const capturedAt = parseAsOfDate(input.asOfDate);
	if (capturedAt === null) throw error(400, m.net_worth_error_invalid_date());

	return { name, type: input.type, balanceCents, capturedAt: capturedAt ?? new Date() };
}

/**
 * Backdating support: an empty/absent value means "now" (undefined here, defaulted by the
 * caller). A malformed or future date is rejected (`null`) rather than silently clamped —
 * a future-dated snapshot would sort ahead of "now" on the curve and misrepresent it as
 * already-known history. Compared as plain YYYY-MM-DD strings (not parsed Dates) to sidestep
 * timezone edge cases entirely: "today" always compares consistently regardless of the
 * server's local offset.
 */
function parseAsOfDate(raw: string | undefined): Date | null | undefined {
	if (!raw) return undefined;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

	const todayIso = new Date().toISOString().slice(0, 10);
	if (raw > todayIso) return null;

	const parsed = new Date(`${raw}T12:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return null;

	return parsed;
}

function toRecord(account: {
	id: string;
	name: string;
	type: string;
	balanceCents: number;
	createdAt: Date;
	updatedAt: Date;
	_count?: { accounts: number };
}): NetWorthAccountRecord {
	return {
		id: account.id,
		name: account.name,
		type: account.type as NetWorthAccountType,
		balanceCents: account.balanceCents,
		createdAt: account.createdAt.toISOString(),
		updatedAt: account.updatedAt.toISOString(),
		connected: (account._count?.accounts ?? 0) > 0
	};
}
