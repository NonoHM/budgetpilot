import { prisma } from '$lib/server/db';
import { computeDedupeKeyHash } from '$lib/server/import/dedupeKey';
import type { CollidingBatchView } from '$lib/domain/importCollision';
import type { ImportedTransaction } from './types';

/**
 * The one thing deduplication cannot see: the same statement, read through different columns.
 *
 * ## Why a second mechanism exists at all
 *
 * The deduplication key is `date | folded label | magnitude | type | occurrence | accountScope`
 * (`utils/safety.ts`, which states the rule and the reason). The label is one of the columns the
 * user DESIGNATES, so re-designating it changes every fingerprint in the file and the whole
 * statement imports again as new money.
 *
 * That is not a defect in the key, and the fix is deliberately not in the key. `utils/safety.ts`
 * argues that a key which changes when the user fixes a mistake is not a key; dropping the label
 * from the fingerprint would make genuinely distinct rows collide, and `occurrence.ts` records why
 * that is the worse direction: a silently dropped transaction is invisible, a duplicate is on the
 * screen. So the key stays as it is, and the collision is detected on a different axis. Not row by
 * row, but BATCH against BATCH: two runs that describe the same money are recognisable even when
 * not one of their fingerprints matches.
 *
 * ## The rule, and why it has three terms
 *
 * A run collides with an existing batch when ALL of:
 *
 * - **T1, the periods overlap.** Not "are equal": re-designating the DATE column shifts a batch's
 *   period, and an equality test would miss exactly the case this exists for. Relaxing to overlap
 *   is safe because T2 does the discriminating.
 * - **T2, the money is identical to the cent.** Same number of transactions, same summed debits,
 *   same summed credits. Both sums rather than the net, because a file whose income and expense
 *   columns were swapped nets to the same figure and is not the same statement.
 * - **T3, deduplication will not absorb it.** Not one incoming fingerprint already exists.
 *
 * T3 is the term that decides whether this warning is worth reading. Without it the rule fires on
 * the most common legitimate action there is, re-importing the same file to check nothing was
 * missed, on a run where the existing mechanism already works perfectly and reports every row as a
 * duplicate. A warning shown on a harmless action is a warning nobody reads by the third month, and
 * then it is not there for the one time it matters.
 *
 * With T3 in, every firing means the same thing: this run is about to write transactions that
 * duplicate money already stored, and nothing else will stop it. That is what earns a block.
 *
 * ## What it does not catch, and the trade is stated rather than hidden
 *
 * A re-designation that changes WHICH ROWS ARE VALID, moving the amount role onto a column with
 * blank cells for instance, changes the transaction count. T2 then fails, no warning is shown, and
 * the user still doubles. No cheap term closes that without widening T2 into something that fires
 * on ordinary monthly imports, which is the failure T3 exists to avoid. Recorded in the issue this
 * shipped with rather than only here, so whoever meets it can find it.
 */

/** A run about to be written, described in the terms the rule compares. */
export interface IncomingBatchShape {
	/** ISO dates (YYYY-MM-DD) or null, exactly as `createImportBatch` receives them. */
	period: { from: string | null; to: string | null };
	transactionCount: number;
	debitCents: number;
	creditCents: number;
	/** Raw deduplication keys. Hashed here, never compared raw (`dedupeKey.ts`). */
	dedupeKeys: string[];
}

/**
 * An existing batch that an incoming run, or another batch, appears to repeat.
 *
 * The shape itself lives in `domain/importCollision.ts`, because the pages that draw it cannot
 * import from `$lib/server`. Aliased here so a reader of the rule sees the type it returns.
 */
export type CollidingBatch = CollidingBatchView;

/**
 * Reduces a parsed batch to the shape the rule compares.
 *
 * Sign conventions match `persist.ts`: magnitudes, with the direction carried by `type`. A row of
 * neither direction contributes to the count and to no sum, which is what makes the two figures
 * comparable against `readBatchTotals` below rather than only against each other.
 */
export function describeIncomingBatch(
	transactions: ImportedTransaction[],
	period: { from: string | null; to: string | null }
): IncomingBatchShape {
	let debitCents = 0;
	let creditCents = 0;
	const dedupeKeys: string[] = [];
	for (const transaction of transactions) {
		if (transaction.metadata.type === 'expense') debitCents += Math.abs(transaction.amountCents);
		if (transaction.metadata.type === 'income') creditCents += Math.abs(transaction.amountCents);
		if (transaction.metadata.deduplicationKey) {
			dedupeKeys.push(transaction.metadata.deduplicationKey);
		}
	}
	return { period, transactionCount: transactions.length, debitCents, creditCents, dedupeKeys };
}

/**
 * The check both import routes run between the parse and the first write.
 *
 * Returns the batch this run appears to repeat, or null when there is nothing to say.
 *
 * `excludeBatchId` names one batch this run is REPLACING rather than repeating, and it is scoped to
 * a single id on purpose. A correction re-reads the same statement, so the batch it corrects
 * matches on all three terms by construction and would otherwise raise the one dialog that can only
 * be wrong. Suppressing the whole rule for the correction path instead would hide the case that
 * still matters there: a genuine earlier import of the same statement, which the correction is not
 * replacing and which will double the money exactly as before.
 */
export async function findCollidingBatch(
	userId: string,
	incoming: IncomingBatchShape,
	options: { excludeBatchId?: string } = {}
): Promise<CollidingBatch | null> {
	// A run with no dated row has no period to overlap and nothing to compare against. Neither
	// route can produce one today, since a row without a usable date is refused rather than
	// imported, so this is a guard rather than a case.
	if (!incoming.period.from || !incoming.period.to) return null;
	if (incoming.transactionCount === 0) return null;

	// T3 first, because it is the cheapest way to answer "no" and it settles every ordinary
	// re-import before any aggregation is done. One indexed lookup against the constraint that
	// already exists, `@@unique([userId, dedupeKeyHash])`.
	//
	// ANY match rather than a majority: a single recognised fingerprint means this file has already
	// been through here in a form the existing mechanism can see, and the summary will report it
	// row by row without help from this one.
	const alreadyKnown = await prisma.transaction.count({
		where: { userId, dedupeKeyHash: { in: incoming.dedupeKeys.map(computeDedupeKeyHash) } }
	});
	if (alreadyKnown > 0) return null;

	// T1. A batch with no recorded period is excluded rather than assumed to overlap: it cannot be
	// SHOWN to describe the same days, and this mechanism only speaks when it is certain.
	const candidates = await prisma.importBatch.findMany({
		where: {
			userId,
			// Spread rather than written as `id: { not: options.excludeBatchId }`, because that form
			// sends `{ not: undefined }` on every ordinary import: a clause nobody asked for, whose
			// behaviour is the query planner's business rather than this rule's.
			...(options.excludeBatchId ? { id: { not: options.excludeBatchId } } : {}),
			periodStart: { not: null, lte: toUtcDate(incoming.period.to) },
			periodEnd: { not: null, gte: toUtcDate(incoming.period.from) }
		},
		orderBy: { createdAt: 'desc' },
		select: { id: true, fileName: true, createdAt: true, periodStart: true, periodEnd: true }
	});
	if (candidates.length === 0) return null;

	// T2, over the transactions actually WRITTEN rather than over the batch's own counters.
	// `rowCount` counts rows read including the invalid ones, and the same statement read through a
	// different mapping can reject a different number of them, so comparing counters would miss the
	// collision on precisely the run that produces it.
	const totals = await readBatchTotals(
		userId,
		candidates.map((batch) => batch.id)
	);

	for (const candidate of candidates) {
		const total = totals.get(candidate.id);
		if (!total) continue;
		if (total.transactionCount !== incoming.transactionCount) continue;
		if (total.debitCents !== incoming.debitCents) continue;
		if (total.creditCents !== incoming.creditCents) continue;
		return describeBatch(candidate, total);
	}
	return null;
}

/** Two batches already stored that appear to be the same statement. */
export interface CollidingPair {
	first: CollidingBatch;
	second: CollidingBatch;
}

/**
 * The same comparison run backwards, over what is already stored.
 *
 * Detection is possible retroactively even though repair is not. The keys of an old batch cannot be
 * recomputed, but its period, its row count and its totals are all still there. Without this a user
 * who doubled their finances before the check shipped has no way to find out, which is the state
 * the blind usability session ended in.
 *
 * **T3 is vacuous here and is therefore not applied.** `@@unique([userId, dedupeKeyHash])` means two
 * batches of one user can never share a fingerprint, so "their key sets are disjoint" is true of
 * every pair and separates nothing. T2 does that work instead, and does it exactly: a re-import
 * that deduplication DID absorb materialised zero rows, or a handful, so its count cannot equal the
 * original's. The legitimate re-import excludes itself by having imported nothing.
 *
 * Batches that materialised no transactions are skipped for the same reason, and they are skipped
 * by being ABSENT from the totals map rather than by a zero check: `groupBy` emits no row for a
 * batch with no transaction. Otherwise every pair of fully absorbed re-imports would match each
 * other at (0, 0, 0), which is the shape of the healthy case rather than of the defect.
 */
export async function findCollidingPairs(userId: string): Promise<CollidingPair[]> {
	const batches = await prisma.importBatch.findMany({
		where: { userId, periodStart: { not: null }, periodEnd: { not: null } },
		orderBy: { createdAt: 'asc' },
		select: { id: true, fileName: true, createdAt: true, periodStart: true, periodEnd: true }
	});
	if (batches.length < 2) return [];

	const totals = await readBatchTotals(
		userId,
		batches.map((batch) => batch.id)
	);

	// Bucketed on the money rather than compared pairwise. Two batches can only collide if they
	// agree on all three figures, so one pass builds the buckets and only a non-singleton bucket,
	// which is the rare case, costs a comparison.
	const buckets = new Map<string, CollidingBatch[]>();
	for (const batch of batches) {
		const total = totals.get(batch.id);
		// A batch that materialised nothing produces NO groupBy row, so it is absent from the map
		// rather than present with a zero. That absence is what excludes the legitimate re-import,
		// the one deduplication absorbed entirely, from ever pairing with the batch it repeated.
		if (!total) continue;
		const key = `${total.transactionCount}|${total.debitCents}|${total.creditCents}`;
		const described = describeBatch(batch, total);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(described);
		else buckets.set(key, [described]);
	}

	const pairs: CollidingPair[] = [];
	for (const bucket of buckets.values()) {
		if (bucket.length < 2) continue;
		for (let i = 0; i < bucket.length; i += 1) {
			for (let j = i + 1; j < bucket.length; j += 1) {
				if (!periodsOverlap(bucket[i], bucket[j])) continue;
				pairs.push({ first: bucket[i], second: bucket[j] });
			}
		}
	}
	return pairs;
}

interface BatchTotals {
	transactionCount: number;
	debitCents: number;
	creditCents: number;
}

interface BatchRow {
	id: string;
	fileName: string | null;
	createdAt: Date;
	periodStart: Date | null;
	periodEnd: Date | null;
}

function describeBatch(batch: BatchRow, total: BatchTotals): CollidingBatch {
	return {
		batchId: batch.id,
		fileName: batch.fileName,
		createdAt: batch.createdAt.toISOString(),
		periodStart: batch.periodStart?.toISOString().slice(0, 10) ?? null,
		periodEnd: batch.periodEnd?.toISOString().slice(0, 10) ?? null,
		...total
	};
}

/**
 * (count, debits, credits) per batch, aggregated in the database.
 *
 * `ImportBatch` stores no totals, and nothing here adds any. A stored total is a second source of
 * truth about money, which then has to be kept correct through every edit, split, recategorisation
 * and deletion; `Transaction.@@index([importBatchId])` is what makes reading it each time cheap
 * enough not to need one. The CLAUDE.md rule this follows: a verdict recomputed cannot disagree
 * with its data, one frozen in a column can.
 *
 * Amounts are stored as magnitudes with the direction in `type` (`persist.ts` writes `Math.abs`),
 * so the two sums are separated by grouping on `type` rather than by the sign.
 */
async function readBatchTotals(
	userId: string,
	batchIds: string[]
): Promise<Map<string, BatchTotals>> {
	const totals = new Map<string, BatchTotals>();
	if (batchIds.length === 0) return totals;

	const grouped = await prisma.transaction.groupBy({
		by: ['importBatchId', 'type'],
		where: { userId, importBatchId: { in: batchIds } },
		_count: { _all: true },
		_sum: { amountCents: true }
	});

	for (const row of grouped) {
		if (!row.importBatchId) continue;
		const total = totals.get(row.importBatchId) ?? {
			transactionCount: 0,
			debitCents: 0,
			creditCents: 0
		};
		total.transactionCount += row._count._all;
		const sum = row._sum.amountCents ?? 0;
		if (row.type === 'expense') total.debitCents += sum;
		if (row.type === 'income') total.creditCents += sum;
		totals.set(row.importBatchId, total);
	}
	return totals;
}

function periodsOverlap(
	a: Pick<CollidingBatch, 'periodStart' | 'periodEnd'>,
	b: Pick<CollidingBatch, 'periodStart' | 'periodEnd'>
): boolean {
	if (!a.periodStart || !a.periodEnd || !b.periodStart || !b.periodEnd) return false;
	// ISO dates compare correctly as strings, and both sides come from the same
	// `toISOString().slice(0, 10)`, so this is a comparison of one format against itself.
	return a.periodStart <= b.periodEnd && a.periodEnd >= b.periodStart;
}

function toUtcDate(isoDate: string): Date {
	return new Date(`${isoDate}T00:00:00.000Z`);
}
