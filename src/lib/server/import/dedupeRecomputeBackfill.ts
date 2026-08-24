import type { PrismaClient } from '../database/types.ts';
// Relative, `.ts`-suffixed imports, like `dedupeBackfill.ts` next door: this module is also
// imported by plain Node (no Vite, no `$lib` alias) so a recompute can be run and inspected
// outside the app.
import { LONG_TRANSACTION_OPTIONS } from '../dbTransaction.ts';
import { computeNullableDedupeKeyHash } from './dedupeKey.ts';
import { DEDUPE_KEY_PREFIX } from './dedupeKeyVersion.ts';
import { assignDedupeKeys, type KeyableRow } from './dedupeRecompute.ts';

/**
 * Carries every stored deduplication key to the version this build writes.
 *
 * ## Why this is app code and not a migration
 *
 * `prisma migrate deploy` wraps NOTHING in a transaction on any engine, which is why every backfill
 * in this repository is boot-time app code. That choice means the two properties a migration would
 * have given for free are now ours to provide, and each is asserted in the spec rather than
 * described here.
 *
 * **Resumable.** The unit of work is a whole `(account, day)` group and never part of one. A pass
 * reads the next batch of pending `(accountId, date)` pairs, reads EVERY row of the days those
 * pairs name including rows already carrying the marker, numbers each group densely and writes the
 * changed rows in one `$transaction`. So a process that dies between batches leaves the batches
 * already written on the current version and the rest pending, and the pending predicate finds
 * exactly the rest. A process that dies inside a batch rolls that batch back in full. There is no
 * state in between, which is the property `ADD COLUMN` could not have given us: it is idempotent on
 * no engine.
 *
 * **Idempotent.** The key a row receives is a pure function of its group's fields and its rank
 * within the group, the rank is taken in `id` order which is stable, and the group is read whole
 * every time. So a second pass computes the identical string for every row and the writer compares
 * before writing: `rewritten` is 0, which is a stronger claim than "no error".
 *
 * ## The day RANGE rather than the timestamp, which is the line that keeps the app booting
 *
 * The key carries the stored `DateTime` TRUNCATED to `YYYY-MM-DD`, so a group whose rows differ in
 * the time component is one group and two timestamps. Selecting on the exact timestamp would split
 * it across two batches, number each half from zero and produce two identical keys, which
 * `@@unique([userId, dedupeKeyHash])` refuses and a fatal boot check turns into an instance that
 * does not start.
 *
 * That is reachable rather than theoretical: `persist.ts` writes midnight, but the RESTORE does
 * not. `backup/schema.ts` defines its date grammar as `Date.parse` merely succeeding, so it accepts
 * a full instant, and `backup/import.ts` writes it unchanged. The design note's "every stored date
 * is `T00:00:00.000Z`, because persist.ts writes it" is a measurement on ONE write path presented
 * as a property of the column, and there are three.
 *
 * ## What it reports, and what it must never report
 *
 * Counts only, per batch, so an operator watching `docker compose up -d` can tell a slow upgrade
 * from a hung one. Never a key, a label or an id: a deduplication key contains the transaction's
 * own label, which is a merchant name and therefore personal financial data. ASVS 5.0.0 16.2.5.
 */

/**
 * How many `(account, day)` pairs one pass claims.
 *
 * A named constant rather than "as many as fit", because it is also the unit the per-batch progress
 * line reports against, and a progress line whose unit nobody can picture is not progress.
 */
export const DEDUPE_RECOMPUTE_PAIR_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DedupeKeyRecomputeOptions {
	prisma: PrismaClient;
	/**
	 * Narrow the walk to one bucket. The third call site, known in advance rather than discovered:
	 * #372 re-buckets rows, which changes `accountId`, which is a key field.
	 */
	accountId?: string;
	/** Test seam for the resume case; production uses the constant above. */
	pairBatchSize?: number;
	/** Test seam: stop after N batches, which is the shape of a process that died. */
	maxBatches?: number;
	onProgress?: (message: string) => void;
}

export interface DedupeKeyRecomputeResult {
	/** Rows given a new key. */
	rewritten: number;
	/** Rows whose key was REMOVED because they carry no direction and cannot be keyed. */
	unkeyed: number;
}

type PendingScope = { accountId?: string };

/** The same predicate the query expresses, for the rows a pass already holds in memory. */
function isPendingKey(dedupeKey: string | null): boolean {
	return dedupeKey !== null && !dedupeKey.startsWith(DEDUPE_KEY_PREFIX);
}

function pendingWhere(scope: PendingScope) {
	return {
		...(scope.accountId ? { accountId: scope.accountId } : {}),
		dedupeKey: { not: null },
		NOT: { dedupeKey: { startsWith: DEDUPE_KEY_PREFIX } }
	};
}

/** Gate for the boot path: is any keyed row still on an older version? */
export async function hasPendingDedupeKeyVersions(prisma: PrismaClient): Promise<boolean> {
	const pending = await prisma.transaction.findFirst({
		where: pendingWhere({}),
		select: { id: true }
	});
	return pending !== null;
}

/** The row shape the walk reads, mapped to what the key builder needs. */
type WalkRow = {
	id: string;
	accountId: string;
	date: Date;
	label: string;
	amountCents: number | bigint;
	type: string | null;
	currency: string;
	exponent: number;
	source: string;
	dedupeKey: string | null;
	metadataJson: string | null;
	account: { providerAccountId: string | null };
};

/**
 * The provider's per-account entry reference, read defensively out of a stored row.
 *
 * `metadataJson` is a free-form column that a restore can fill from an untrusted file, so a throw
 * here would take the whole boot down over a cell nothing else reads. Anything unexpected yields
 * null and the row falls back to the content branch, which is what a row with no provider reference
 * gets anyway. ASVS 5.0.0 1.5.2.
 */
function readEntryReference(metadataJson: string | null): string | null {
	if (!metadataJson) return null;
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const reference = (parsed as Record<string, unknown>).reference;
		return typeof reference === 'string' && reference.trim() ? reference : null;
	} catch {
		return null;
	}
}

function toKeyableRow(row: WalkRow): KeyableRow {
	return {
		id: row.id,
		source: row.source,
		accountId: row.accountId,
		// The stored instant truncated, which is exactly what the key carries.
		date: row.date.toISOString().slice(0, 10),
		label: row.label,
		amountCents: Number(row.amountCents),
		type: row.type === 'income' || row.type === 'expense' ? row.type : null,
		currency: row.currency,
		exponent: row.exponent,
		providerAccountId: row.account.providerAccountId,
		entryReference: readEntryReference(row.metadataJson),
		// A row that was never keyed is a manual transaction and must stay unkeyed.
		keyed: row.dedupeKey !== null
	};
}

/** The UTC day a stored instant falls in, which is the unit a content group cannot span. */
function startOfUtcDay(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export async function runDedupeKeyRecompute(
	options: DedupeKeyRecomputeOptions
): Promise<DedupeKeyRecomputeResult> {
	const { prisma, accountId, onProgress } = options;
	const pairBatchSize = options.pairBatchSize ?? DEDUPE_RECOMPUTE_PAIR_BATCH;
	const scope: PendingScope = accountId ? { accountId } : {};
	let rewritten = 0;
	let unkeyed = 0;
	let batches = 0;

	for (;;) {
		if (options.maxBatches !== undefined && batches >= options.maxBatches) break;

		// No cursor, deliberately, and for the reason `dedupeBackfill.ts` already states: a row
		// leaves the pending set the moment this loop writes it, so re-asking for the first N
		// pending pairs is correct precisely because the set shrinks by exactly what each pass
		// writes.
		const pairs = await prisma.transaction.groupBy({
			by: ['accountId', 'date'],
			where: pendingWhere(scope),
			orderBy: [{ accountId: 'asc' }, { date: 'asc' }],
			take: pairBatchSize
		});
		if (pairs.length === 0) break;
		batches += 1;

		const accountIds = [...new Set(pairs.map((pair) => pair.accountId))];
		const days = [...new Set(pairs.map((pair) => startOfUtcDay(pair.date).getTime()))];

		// A DAY RANGE, not the timestamp. See the header: paging on the exact instant splits a key
		// group whose rows differ in the time of day, and two halves numbered from zero collide.
		//
		// The account/day product OVER-FETCHES, deliberately and safely: it returns a superset of
		// the pairs asked for, and every extra group it returns is COMPLETE, so numbering it is
		// correct and the extra work is wasted rather than wrong. A tuple `IN` is not portable
		// across the three engines this application supports.
		const rows = (await prisma.transaction.findMany({
			where: {
				accountId: { in: accountIds },
				OR: days.map((day) => ({ date: { gte: new Date(day), lt: new Date(day + DAY_MS) } }))
			},
			select: {
				id: true,
				accountId: true,
				date: true,
				label: true,
				amountCents: true,
				type: true,
				currency: true,
				exponent: true,
				source: true,
				dedupeKey: true,
				metadataJson: true,
				account: { select: { providerAccountId: true } }
			},
			// Stable, so a second pass over the same rows computes the same ordinals.
			orderBy: [{ accountId: 'asc' }, { date: 'asc' }, { id: 'asc' }]
		})) as WalkRow[];

		// Rows already carrying the marker are READ, not skipped: a group's ordinals span all of
		// its members, so numbering a partial group would produce a collision inside it.
		const keys = assignDedupeKeys(rows.map(toKeyableRow));

		// ONLY PENDING ROWS ARE WRITTEN. A row already carrying the marker is this application's
		// own output and a backfill must not second-guess it; it is read so the group's ordinals
		// span all of its members, and then left alone. The numbering stays consistent because it
		// is computed over the whole group, so a pending row beside a current one receives the
		// ordinal the current one did not take.
		const changed = rows.filter(
			(row) => isPendingKey(row.dedupeKey) && (keys.get(row.id) ?? null) !== row.dedupeKey
		);

		await prisma.$transaction(async (tx) => {
			for (const row of changed) {
				const key = keys.get(row.id) ?? null;
				await tx.transaction.update({
					where: { id: row.id },
					data: { dedupeKey: key, dedupeKeyHash: computeNullableDedupeKeyHash(key) }
				});
				if (key === null) unkeyed += 1;
				else rewritten += 1;
			}
		}, LONG_TRANSACTION_OPTIONS);

		// The loop terminates only because every pass shrinks the pending set, so a pass that left
		// its own rows pending would re-ask for the same page forever. This runs at boot, where
		// that is an instance that never starts rather than a slow command.
		//
		// Asserted on the EFFECT rather than on the intent: counting the updates this pass issued
		// would count what it asked for, and a write that did not apply asks exactly the same. So
		// the question is whether the batch's own rows are still pending, and after a successful
		// batch the answer is zero by construction.
		const stillPending = await prisma.transaction.count({
			where: { ...pendingWhere(scope), id: { in: rows.map((row) => row.id) } }
		});
		if (stillPending > 0) {
			throw new Error(
				`[dedupe-keys] recompute stalled: ${stillPending} row(s) still on an older key version could not be rewritten`
			);
		}

		const pendingLeft = await prisma.transaction.count({ where: pendingWhere(scope) });
		// COUNTS ONLY. A deduplication key contains the transaction's own label.
		onProgress?.(`${rewritten + unkeyed} done, ${pendingLeft} pending`);

		if (pendingLeft === 0) break;
	}

	return { rewritten, unkeyed };
}
