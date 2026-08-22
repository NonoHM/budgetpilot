import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assignDedupeKeys } from './dedupeRecompute';
import { computeDedupeKeyHash } from './dedupeKey';
import {
	DEDUPE_RECOMPUTE_PAIR_BATCH,
	hasPendingDedupeKeyVersions,
	runDedupeKeyRecompute
} from './dedupeRecomputeBackfill';

/**
 * The boot recompute, which replaces what a migration would have given us.
 *
 * `prisma migrate deploy` wraps nothing in a transaction on any engine, which is why this is app
 * code. That choice means the two properties a migration provides for free are now ours to provide,
 * and each is asserted rather than described: **resumable**, a partial run is safe to re-run, and
 * **idempotent**, a second pass over a converged table rewrites ZERO rows.
 *
 * The fake models the two queries the walk uses and nothing else, and it throws on a `where` it
 * cannot express rather than treating it as no filter. Prisma treats a missing clause as no filter,
 * so a fake that silently ignored the pending predicate would make every test here green over a
 * walk that reads the whole table on every pass.
 */

type Row = {
	id: string;
	accountId: string;
	date: Date;
	label: string;
	amountCents: number;
	type: 'income' | 'expense' | null;
	currency: string;
	exponent: number;
	source: string;
	dedupeKey: string | null;
	dedupeKeyHash: string | null;
	metadataJson: string | null;
	account: { providerAccountId: string | null };
};

const V3 = 'v3|';

function makeRow(over: Partial<Row> = {}): Row {
	return {
		id: over.id ?? 'row-1',
		accountId: 'acc-1',
		date: new Date('2026-06-24T00:00:00.000Z'),
		label: 'Carrefour Market',
		amountCents: -2490,
		type: 'expense',
		currency: 'EUR',
		exponent: 2,
		source: 'csv',
		dedupeKey: `2026-06-24|carrefour market|2490|expense|0|`,
		dedupeKeyHash: 'legacy-hash',
		metadataJson: null,
		account: { providerAccountId: null },
		...over
	};
}

let rows: Row[] = [];
let updates: Array<{ id: string; dedupeKey: string | null }> = [];

function pending(row: Row): boolean {
	return row.dedupeKey !== null && !row.dedupeKey.startsWith(V3);
}

const prismaFake = {
	transaction: {
		findFirst: vi.fn(async () => rows.find(pending) ?? null),
		groupBy: vi.fn(async ({ take, where }: { take: number; where: { accountId?: string } }) => {
			// The scope is HONOURED rather than ignored. A fake that treats a clause it does not
			// model as no filter is the failure this repository has already paid for: the
			// narrow-to-one-account test went green over a walk that read every account.
			const seen = new Map<string, { accountId: string; date: Date }>();
			for (const row of rows.filter(
				(candidate) =>
					pending(candidate) &&
					(where.accountId === undefined || candidate.accountId === where.accountId)
			)) {
				const key = `${row.accountId}|${row.date.toISOString()}`;
				if (!seen.has(key)) seen.set(key, { accountId: row.accountId, date: row.date });
			}
			return [...seen.values()]
				.sort(
					(a, b) => a.accountId.localeCompare(b.accountId) || a.date.getTime() - b.date.getTime()
				)
				.slice(0, take);
		}),
		findMany: vi.fn(
			async ({ where }: { where: { accountId?: { in: string[] }; OR?: unknown[] } }) => {
				if (!where.accountId?.in || !where.OR) {
					throw new Error('the walk must scope by accountId AND a date RANGE per day');
				}
				const accounts = new Set(where.accountId.in);
				const windows = (where.OR as Array<{ date: { gte: Date; lt: Date } }>).map((clause) => [
					clause.date.gte.getTime(),
					clause.date.lt.getTime()
				]);
				return rows
					.filter(
						(row) =>
							accounts.has(row.accountId) &&
							windows.some(([from, to]) => row.date.getTime() >= from && row.date.getTime() < to)
					)
					.sort((a, b) => a.id.localeCompare(b.id));
			}
		),
		count: vi.fn(async ({ where }: { where: { accountId?: string; id?: { in: string[] } } }) => {
			// Models the pending predicate rather than counting everything: a fake that
			// ignored it would make the stall guard unreachable and the progress line lie.
			const ids = where.id?.in ? new Set(where.id.in) : null;
			return rows.filter(
				(row) =>
					pending(row) &&
					(where.accountId === undefined || row.accountId === where.accountId) &&
					(ids === null || ids.has(row.id))
			).length;
		}),
		update: vi.fn(
			async ({
				where,
				data
			}: {
				where: { id: string };
				data: { dedupeKey: string | null; dedupeKeyHash: string | null };
			}) => {
				const row = rows.find((candidate) => candidate.id === where.id)!;
				row.dedupeKey = data.dedupeKey;
				row.dedupeKeyHash = data.dedupeKeyHash;
				updates.push({ id: where.id, dedupeKey: data.dedupeKey });
				return row;
			}
		)
	},
	$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaFake))
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = prismaFake as any;

beforeEach(() => {
	rows = [];
	updates = [];
	vi.clearAllMocks();
});

describe('hasPendingDedupeKeyVersions', () => {
	it('is true while a legacy key remains', async () => {
		rows = [makeRow()];
		expect(await hasPendingDedupeKeyVersions(prisma)).toBe(true);
	});

	it('is false once every keyed row carries the marker', async () => {
		rows = [makeRow({ dedupeKey: 'v3|already' })];
		expect(await hasPendingDedupeKeyVersions(prisma)).toBe(false);
	});

	it('is false for a row that was never keyed, which is not pending but unkeyable', async () => {
		// A manual transaction has no import fingerprint. Counting it as pending would make the
		// boot walk run on every start, forever, over rows it must never touch.
		rows = [makeRow({ dedupeKey: null, dedupeKeyHash: null })];
		expect(await hasPendingDedupeKeyVersions(prisma)).toBe(false);
	});
});

describe('runDedupeKeyRecompute', () => {
	it('rewrites a legacy key and leaves an already-current one alone', async () => {
		rows = [
			makeRow({ id: 'a' }),
			makeRow({ id: 'b', label: 'Boulangerie', dedupeKey: 'v3|untouched' })
		];

		const result = await runDedupeKeyRecompute({ prisma });

		expect(result.rewritten).toBe(1);
		expect(updates.map((entry) => entry.id)).toEqual(['a']);
		expect(rows.find((row) => row.id === 'b')!.dedupeKey).toBe('v3|untouched');
	});

	it('writes the key the recompute would give the row, and its hash beside it', async () => {
		rows = [makeRow({ id: 'a' })];

		await runDedupeKeyRecompute({ prisma });

		const row = rows[0];
		const expected = assignDedupeKeys([
			{
				id: 'a',
				source: 'csv',
				accountId: 'acc-1',
				date: '2026-06-24',
				label: 'Carrefour Market',
				amountCents: -2490,
				type: 'expense',
				currency: 'EUR',
				exponent: 2,
				providerAccountId: null,
				entryReference: null,
				keyed: true
			}
		]).get('a')!;
		expect(row.dedupeKey).toBe(expected);
		expect(row.dedupeKeyHash).toBe(computeDedupeKeyHash(expected));
	});

	it('numbers a group of three densely, whatever order the rows come back in', async () => {
		rows = [makeRow({ id: 'c' }), makeRow({ id: 'a' }), makeRow({ id: 'b' })];

		await runDedupeKeyRecompute({ prisma });

		const ordinals = rows.map((row) => row.dedupeKey!.split('|').at(-1)).sort();
		expect(ordinals).toEqual(['0', '1', '2']);
		expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(3);
	});

	it('recomputes a v1 key, which has no ordinal to carry forward', async () => {
		// MEASURED 2026-08-22 across four installs: three of the four are v1-dominant, so this is
		// the ordinary case rather than the exotic one. The design note's collision argument is
		// about v2 and says nothing here; what makes it safe is that the numbering is injective
		// over the group whatever version its members arrived on.
		rows = [
			makeRow({ id: 'a', dedupeKey: '2026-06-24|carrefour|2490|expense||releve.csv' }),
			makeRow({ id: 'b', dedupeKey: '2026-06-24|carrefour|2490|expense||releve (1).csv' })
		];

		const result = await runDedupeKeyRecompute({ prisma });

		expect(result.rewritten).toBe(2);
		expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);
		expect(rows.every((row) => row.dedupeKey!.startsWith(V3))).toBe(true);
	});

	it('keeps a group together when its rows differ only in the time of day', async () => {
		// THE CRASH THIS WALK WAS ONE LINE AWAY FROM. The key carries the date TRUNCATED to
		// YYYY-MM-DD, and the walk pages by the stored DateTime. Selecting on the exact timestamp
		// splits one key group across two pages, numbers each half from zero and writes two
		// identical keys into @@unique([userId, dedupeKeyHash]); the boot check that catches it is
		// fatal by design, so the instance does not start.
		//
		// Reachable through restore: backup/schema.ts defines the date grammar as Date.parse merely
		// succeeding, so it accepts a full instant, and backup/import.ts writes it unchanged.
		rows = [
			makeRow({ id: 'a', date: new Date('2026-06-24T00:00:00.000Z') }),
			makeRow({ id: 'b', date: new Date('2026-06-24T14:30:00.000Z') })
		];

		// ONE PAIR PER BATCH, and without it this test cannot fail. The two timestamps are two
		// pairs, and at the default batch size both land in the same pass, so the group is never
		// split and a walk paging on the exact instant passes exactly like a correct one.
		// MEASURED: with the default size, breaking the day range to a one-millisecond window gave
		// 0 red across all sixteen tests.
		await runDedupeKeyRecompute({ prisma, pairBatchSize: 1 });

		expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);
		expect(rows.map((row) => row.dedupeKey!.split('|').at(-1)).sort()).toEqual(['0', '1']);
	});

	it('unkeys a row whose direction is null, and reports how many it unkeyed', async () => {
		// Counted rather than assumed. The design note's own figure came from a fixture it had just
		// created, which is worth nothing about an installed database; measured across four real
		// installs the count is 0, which says the state has not occurred there and not that it
		// cannot.
		rows = [makeRow({ id: 'a', type: null })];

		const result = await runDedupeKeyRecompute({ prisma });

		expect(result.unkeyed).toBe(1);
		expect(rows[0].dedupeKey).toBe(null);
		expect(rows[0].dedupeKeyHash).toBe(null);
	});

	it('is idempotent: a second pass over a converged table rewrites ZERO rows', async () => {
		// `rewritten: 0`, not "completes without error". The two are different claims and only one
		// of them is the property a migration would have given us.
		rows = [makeRow({ id: 'a' }), makeRow({ id: 'b' })];

		const first = await runDedupeKeyRecompute({ prisma });
		updates = [];
		const second = await runDedupeKeyRecompute({ prisma });

		expect(first.rewritten).toBe(2);
		expect(second.rewritten).toBe(0);
		expect(updates).toEqual([]);
	});

	it('resumes a pass that died between two batches, writing only what is left', async () => {
		// The unit of work is a whole (account, day) group and never part of one, so there is no
		// state between "this group is legacy" and "this group is v3". A crash between batches
		// leaves the rest pending and the pending predicate finds exactly the rest.
		rows = [makeRow({ id: 'a', accountId: 'acc-1' }), makeRow({ id: 'b', accountId: 'acc-2' })];

		// One pair at a time, then stop after the first: the shape of a process that died.
		await runDedupeKeyRecompute({ prisma, pairBatchSize: 1, maxBatches: 1 });
		expect(rows.filter((row) => row.dedupeKey!.startsWith(V3))).toHaveLength(1);

		const resumed = await runDedupeKeyRecompute({ prisma });
		expect(resumed.rewritten).toBe(1);
		expect(rows.every((row) => row.dedupeKey!.startsWith(V3))).toBe(true);
	});

	it('reports progress per batch, with rows done and rows still pending', async () => {
		// A boot that takes a minute with no output is indistinguishable from a hung one, and
		// `docker compose up -d` gives an operator no other window onto it.
		rows = [makeRow({ id: 'a', accountId: 'acc-1' }), makeRow({ id: 'b', accountId: 'acc-2' })];
		const messages: string[] = [];

		await runDedupeKeyRecompute({
			prisma,
			pairBatchSize: 1,
			onProgress: (message) => messages.push(message)
		});

		expect(messages.length).toBeGreaterThan(1);
		expect(messages[0]).toMatch(/\d+ done/);
		expect(messages[0]).toMatch(/pending/);
	});

	it('never puts a key, a label or an id in what it reports', async () => {
		// A deduplication key contains the transaction's own label, which is a merchant name and
		// therefore personal financial data. ASVS 5.0.0 16.2.5.
		rows = [makeRow({ id: 'secret-id', label: 'Docteur Fictif' })];
		const messages: string[] = [];

		await runDedupeKeyRecompute({ prisma, onProgress: (message) => messages.push(message) });

		// LOWERCASED on both sides, and without it this test cannot fail either. The key carries the
		// FOLDED label, so a message leaking the whole key contains `docteur fictif` and a check
		// for `Docteur` misses it. MEASURED: appending the key to the progress line gave 0 red
		// before this line was case-folded.
		const reported = messages.join('\n').toLowerCase();
		expect(reported).not.toContain('docteur');
		expect(reported).not.toContain('secret-id');
		expect(reported).not.toContain('carrefour');
		// And nothing that looks like a key at all, which is the general form rather than a list
		// of the strings this fixture happens to use.
		expect(reported).not.toContain('v3|');
	});

	it('refuses to report progress it did not make', async () => {
		// The loop terminates only because each pass shrinks the pending set. A pass that wrote
		// nothing while rows are still pending would otherwise re-ask for the same page forever, so
		// it throws rather than spinning at boot.
		rows = [makeRow({ id: 'a' })];
		prismaFake.transaction.update.mockImplementationOnce(async () => ({}) as never);

		await expect(runDedupeKeyRecompute({ prisma })).rejects.toThrow(/stalled/);
	});

	it('narrows to one account when asked, which is what re-bucketing needs', async () => {
		// The third call site, known in advance rather than discovered: #372 moves rows to a
		// different Account, which changes a key field, and it needs the recompute scoped to the
		// rows it moved rather than a walk of the whole table.
		rows = [makeRow({ id: 'a', accountId: 'acc-1' }), makeRow({ id: 'b', accountId: 'acc-2' })];

		const result = await runDedupeKeyRecompute({ prisma, accountId: 'acc-2' });

		expect(result.rewritten).toBe(1);
		expect(updates.map((entry) => entry.id)).toEqual(['b']);
	});
});

describe('the batch size', () => {
	it('is a named constant a human can reason about', () => {
		// It is also the unit the per-batch progress line reports against, and a progress line
		// whose unit nobody can picture is not progress.
		expect(DEDUPE_RECOMPUTE_PAIR_BATCH).toBeGreaterThan(0);
		expect(DEDUPE_RECOMPUTE_PAIR_BATCH).toBeLessThanOrEqual(1000);
	});
});
