import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { importHeaderCells, parseCsvTransactionRows } from './csv';
import { readImportFile } from './file';
import { mappingFromPostedIndices } from './mapping/designation';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from './persist';
import { hasPendingDedupeKeyVersions, runDedupeKeyRecompute } from './dedupeRecomputeBackfill';
import type { DateOrder } from './dateOrder';

/**
 * # THE SAME FILE UNDER TWO READINGS, against a real engine on all three. #639's precondition.
 *
 * ## Why this had to be measured BEFORE the answer could be threaded, and not after
 *
 * `row.date` is the SECOND field of `contentFieldsOf`, joined into the hash stored under
 * `@@unique([userId, dedupeKeyHash])`. So the reading a user answers is not one column's value: it
 * is the identity of every row the file writes. Until the answer reached the parse, both paths read
 * a file the same way and the key was stable for that reason alone, which is not a property of the
 * key. Threading the answer is what creates the case, so the case was walked first.
 *
 * ## What was measured, identically on sqlite, PostgreSQL 17 and MariaDB 11.8
 *
 * ```
 * A  day-first then month-first   12 rows, 12 distinct hashes, 0 duplicates, boot clean
 * B  month-first then day-first   12 rows, 12 distinct hashes, 0 duplicates, boot clean
 * C  readings that overlap         2 rows,  2 distinct hashes, 2 duplicates on the second import
 * D  a cell reading the same way   1 row,   1 distinct hash,   1 duplicate on the second import
 * ```
 *
 * **Two disjoint sets is the correct answer, not a collision.** Rows dated 2026-02-01 and
 * 2026-01-02 are different transactions, and a key that merged them would swallow one. C and D are
 * the cases that matter more, and they are the ones a reader would not predict: where the two
 * readings AGREE on a date, the second import produces the identical key and is correctly counted
 * as a duplicate rather than written twice. So the answer cannot double a user's money either way.
 *
 * ## The boot check, and why it is broken on purpose here
 *
 * `runDedupeKeyRecompute` walks only rows whose key is on an older version, so over a table this
 * test just wrote it walks NOTHING and reports zero. That zero is the same zero a recompute that
 * never ran would report. So every stored key is DEMOTED to the legacy shape first, which is exactly
 * the state a pre-v3 install is in, and the recompute is then forced to rebuild every key over a
 * table holding both readings. If two readings of one file could be re-keyed into one hash, the
 * unique constraint refuses there and the instance does not start, which is what fatal by design
 * means. It converges: every row rewritten on the first pass, zero on the second.
 *
 * ## WHAT THIS GATE DOES NOT INSPECT, break-checked rather than assumed
 *
 * Two breaks were applied to `dedupeRecompute.ts`. Removing `row.date` from `contentFieldsOf`, so
 * the two readings key alike, reddens two of the five tests. Removing the OCCURRENCE ORDINAL leaves
 * all five green, and that is a true statement about this file rather than a hole in the key: no
 * fixture here puts two rows in one content group, so the ordinal is never exercised. It is covered
 * where it is the subject, in `dedupeKeyInjectivity.spec.ts` and `occurrenceGap.db-smoke.ts`.
 * Recorded because a gate that reddens for one break reads as a gate that reddens, and the second
 * break is the only thing that says which one.
 *
 * ## MariaDB is why the DISTINCT count is asserted rather than a string comparison
 *
 * MySQL and MariaDB are accent and case insensitive by default on string comparison, and the key
 * folds the transaction's own label. The compared value is `computeDedupeKeyHash`'s 64 ASCII
 * characters for that reason, and a count of distinct hashes is a claim no collation can soften.
 */

/** Every reading differs from the other. Day-first gives February; month-first gives six months. */
const DISJOINT = [
	'zone_1,zone_2,zone_3',
	'01/02/2026,Abonnement Fibre Doriane,-39.90',
	'03/02/2026,Primeur Sainte Anne,-17.45',
	'05/02/2026,Remboursement Teleconsultation,49.00',
	'06/02/2026,Peage Autoroute Cevennes,-12.60',
	'09/02/2026,Opticien Vallonge,-89.00',
	'11/02/2026,Cordonnerie du Beffroi,-21.50'
].join('\n');

/**
 * The two readings produce the SAME SET of dates, which is the only shape that can collide: each
 * row's reading is the other row's mirror, so the second import's keys are the first import's.
 */
const OVERLAPPING = [
	'zone_1,zone_2,zone_3',
	'05/06/2026,Primeur Sainte Anne,-17.45',
	'06/05/2026,Primeur Sainte Anne,-17.45'
].join('\n');

/** Day equals month, so one cell reads identically both ways. */
const SAME_BOTH_WAYS = ['zone_1,zone_2,zone_3', '02/02/2026,Cordonnerie du Beffroi,-21.50'].join(
	'\n'
);

async function rowsOf(text: string) {
	const file = new File([new TextEncoder().encode(text)], 'statement.csv', { type: 'text/csv' });
	return (await readImportFile(file, { maxBytes: 256_000 })).rows;
}

async function freshUser(tag: string) {
	const user = await prisma.user.create({
		data: {
			email: `date-order-dedupe-${tag}-${Date.now()}@example.test`,
			passwordHash: 'x',
			role: 'USER'
		}
	});
	const bucket = await resolveImportBucketAccount({
		userId: user.id,
		name: `date order dedupe ${tag}`,
		source: 'csv'
	});
	return { userId: user.id, accountId: bucket.accountId };
}

/** One import, through the same resolution the designation action performs. */
async function importOnce(
	who: { userId: string; accountId: string },
	rows: Awaited<ReturnType<typeof rowsOf>>,
	dateOrder: DateOrder
) {
	const headers = importHeaderCells(rows);
	const resolved = mappingFromPostedIndices({
		headers,
		posted: { date: '0', label: '1', amount: '2', category: '' },
		hasHeaderRow: true
	});
	if (!resolved.ok) throw new Error(`mapping refused: ${JSON.stringify(resolved.reason)}`);
	const result = parseCsvTransactionRows(rows, {
		maxBytes: 256_000,
		profile: 'mapped',
		columnMapping: resolved.mapping,
		hasHeaderRow: true,
		sourceName: 'statement.csv',
		dateOrder
	});
	const batchId = await createImportBatch({
		userId: who.userId,
		accountId: who.accountId,
		source: 'csv',
		fileName: 'statement.csv',
		profile: 'mapped',
		rowCount: result.summary.totalRows,
		invalidRows: result.summary.invalidRows,
		period: result.summary.period,
		dateOrder: result.summary.dateOrder ?? null
	});
	const written = await persistImportedTransactions({
		userId: who.userId,
		accountId: who.accountId,
		importBatchId: batchId,
		source: 'csv',
		transactions: result.transactions,
		parseDuplicateRows: result.summary.duplicateRows
	});
	return {
		parsed: result.transactions.length,
		appliedOrder: result.summary.dateOrder,
		imported: written.importedRows,
		duplicates: written.duplicateRows
	};
}

async function tableOf(userId: string) {
	const stored = await prisma.transaction.findMany({
		where: { userId },
		select: { date: true, dedupeKeyHash: true }
	});
	return {
		rows: stored.length,
		distinctHashes: new Set(stored.map((row) => row.dedupeKeyHash).filter(Boolean)).size,
		nullHashes: stored.filter((row) => row.dedupeKeyHash === null).length
	};
}

/**
 * The boot recompute, forced to actually run. See the header: an unforced pass reports a zero that
 * says nothing, so every key is demoted to the legacy shape first and the pass is made to rebuild
 * all of them over a table holding both readings.
 */
async function forcedBootRecompute(userId: string, accountId: string) {
	const stored = await prisma.transaction.findMany({
		where: { userId },
		select: { id: true, dedupeKey: true }
	});
	let demoted = 0;
	for (const row of stored) {
		if (!row.dedupeKey?.startsWith('v3|')) continue;
		await prisma.transaction.update({
			where: { id: row.id },
			data: { dedupeKey: row.dedupeKey.slice(3) }
		});
		demoted += 1;
	}
	// THE PLANTED POSITIVE. Without this line the two figures below are the figures of a pass that
	// had nothing to do, and a broken instrument reports them identically.
	const pending = await hasPendingDedupeKeyVersions(prisma);
	const first = await runDedupeKeyRecompute({ prisma, accountId });
	const second = await runDedupeKeyRecompute({ prisma, accountId });
	return { demoted, pending, first, second };
}

let disjoint: Awaited<ReturnType<typeof rowsOf>>;
let overlapping: Awaited<ReturnType<typeof rowsOf>>;
let sameBothWays: Awaited<ReturnType<typeof rowsOf>>;

beforeAll(async () => {
	disjoint = await rowsOf(DISJOINT);
	overlapping = await rowsOf(OVERLAPPING);
	sameBothWays = await rowsOf(SAME_BOTH_WAYS);
});

describe('the deduplication key under two readings of one file', () => {
	/**
	 * THE INSTRUMENT IS ALIVE, in absolute figures and before any claim about hashes. The first run
	 * of this measurement reported `parsed=0` in every scenario with a well-formed table beside it,
	 * because the mapping was hand-built in the wrong shape: `imported=0 duplicates=0` reads exactly
	 * like « the two readings never interact ». Only an expected COUNT can separate those.
	 */
	it('parses six rows under each reading, and applies the reading it was given', async () => {
		expect.assertions(4);
		const who = await freshUser('alive');
		const one = await importOnce(who, disjoint, 'day-first');
		const two = await importOnce(who, disjoint, 'month-first');
		expect(one.parsed).toBe(6);
		expect(two.parsed).toBe(6);
		expect(one.appliedOrder).toBe('day-first');
		expect(two.appliedOrder).toBe('month-first');
	});

	/**
	 * Separates « the two readings produce two key sets » from « the second import deduplicated
	 * against the first ». Twelve distinct hashes over twelve rows is the claim, and the duplicate
	 * count is asserted beside it because a zero there and a zero in the row count are different
	 * facts that a single figure would merge.
	 */
	it('keys a file read two ways as two sets of transactions, and writes both', async () => {
		expect.assertions(4);
		const who = await freshUser('disjoint');
		await importOnce(who, disjoint, 'day-first');
		const second = await importOnce(who, disjoint, 'month-first');

		const table = await tableOf(who.userId);
		expect(table.rows).toBe(12);
		expect(table.distinctHashes).toBe(12);
		expect(table.nullHashes).toBe(0);
		expect(second.duplicates).toBe(0);
	});

	/**
	 * THE CASE A READER WOULD NOT PREDICT, and the one that matters more than the twelve above.
	 * Where the two readings agree on the SET of dates, the second import's keys are the first
	 * import's, so nothing is written and the rows are counted as duplicates.
	 *
	 * Separates « the reading is part of the key » from « the reading makes every import distinct ».
	 * If it made every import distinct, answering the question differently would double a user's
	 * money on a file the application had already stored.
	 */
	it('recognises the second import as a duplicate when the readings agree', async () => {
		expect.assertions(3);
		const who = await freshUser('overlap');
		const first = await importOnce(who, overlapping, 'day-first');
		const second = await importOnce(who, overlapping, 'month-first');

		expect(first.imported).toBe(2);
		expect(second.imported).toBe(0);
		expect(second.duplicates).toBe(2);
	});

	/** The same property on one cell that reads identically both ways, which is the simplest form. */
	it('recognises a cell that reads the same way under both readings', async () => {
		expect.assertions(3);
		const who = await freshUser('same');
		await importOnce(who, sameBothWays, 'day-first');
		const second = await importOnce(who, sameBothWays, 'month-first');

		const table = await tableOf(who.userId);
		expect(table.rows).toBe(1);
		expect(second.imported).toBe(0);
		expect(second.duplicates).toBe(1);
	});

	/**
	 * THE BOOT CHECK, over a table holding both readings, forced to run. A failure here is an
	 * instance that does not start, which is why it is asserted against a real engine rather than
	 * reasoned about: the recompute rebuilds every key from the stored row, and two rows rebuilding
	 * into one hash is refused by `@@unique([userId, dedupeKeyHash])`.
	 *
	 * Three claims, and the first is what makes the other two mean anything: the pass had work to
	 * do. Then it converged, and a second pass rewrote nothing, which is idempotence observed from
	 * outside rather than asserted about the code.
	 */
	it('rebuilds every key over both readings, converges, and writes nothing on a second pass', async () => {
		expect.assertions(5);
		const who = await freshUser('boot');
		await importOnce(who, disjoint, 'day-first');
		await importOnce(who, disjoint, 'month-first');

		const boot = await forcedBootRecompute(who.userId, who.accountId);
		expect(boot.demoted).toBe(12);
		expect(boot.pending).toBe(true);
		expect(boot.first.rewritten).toBe(12);
		expect(boot.second.rewritten).toBe(0);

		// And the table is still twelve distinct rows afterwards, which is the claim the unique
		// constraint would have refused rather than reported.
		const table = await tableOf(who.userId);
		expect(table.distinctHashes).toBe(12);
	});
});
