import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeDedupeKeyHash } from './dedupeKey';
import { DEDUPE_KEY_PREFIX } from './dedupeKeyVersion';
import { hasPendingDedupeKeyVersions, runDedupeKeyRecompute } from './dedupeRecomputeBackfill';

/**
 * The boot recompute against a REAL engine, which is the only place three of these claims can be
 * answered at all.
 *
 * A mocked suite decides equality in JavaScript. The questions here are the database's: whether a
 * unique index accepts what the recompute writes on an engine whose own collation would have merged
 * two of its inputs, whether a `groupBy` over `(accountId, date)` returns what the walk assumes,
 * and whether a half-finished pass is safe to resume when the rows are on a server rather than in
 * an array.
 */

const V3 = DEDUPE_KEY_PREFIX;

let userId = '';
let accountA = '';
let accountB = '';
let categoryId = '';

/** A legacy key of the shape a v1 install holds: the uploaded file's name is embedded in it. */
function legacyKey(date: string, label: string, magnitude: number, fileName: string): string {
	return [date, label.toLowerCase(), magnitude, 'expense', '', fileName].join('|');
}

async function seed(
	rows: Array<{ accountId: string; date: string; label: string; cents: number; key: string | null }>
) {
	for (const row of rows) {
		await prisma.transaction.create({
			data: {
				userId,
				accountId: row.accountId,
				categoryId,
				date: new Date(row.date),
				label: row.label,
				amountCents: row.cents,
				type: 'expense',
				source: 'csv',
				currency: 'EUR',
				exponent: 2,
				dedupeKey: row.key,
				dedupeKeyHash: row.key ? computeDedupeKeyHash(row.key) : null
			}
		});
	}
}

async function storedKeys(): Promise<Array<string | null>> {
	const rows = await prisma.transaction.findMany({
		where: { userId },
		select: { dedupeKey: true },
		orderBy: { id: 'asc' }
	});
	return rows.map((row) => row.dedupeKey);
}

beforeEach(async () => {
	const user = await prisma.user.create({
		data: {
			email: `recompute-${Date.now()}-${Math.floor(performance.now())}@example.test`,
			passwordHash: 'x',
			role: 'USER'
		}
	});
	userId = user.id;
	const category = await prisma.category.create({ data: { userId, name: 'Alimentation' } });
	categoryId = category.id;
	const a = await prisma.account.create({
		data: {
			userId,
			name: 'Bucket A',
			nameKey: 'bucket a',
			source: 'csv',
			currency: 'EUR',
			exponent: 2
		}
	});
	const b = await prisma.account.create({
		data: {
			userId,
			name: 'Bucket B',
			nameKey: 'bucket b',
			source: 'revolut',
			currency: 'EUR',
			exponent: 2
		}
	});
	accountA = a.id;
	accountB = b.id;
});

describe('the recompute against a real engine', () => {
	it('CALIBRATION: two rows differing only by an accent are two rows here', async () => {
		// FIRST, and the reason every figure below means anything. On MySQL and MariaDB the default
		// collation is accent- and case-insensitive, so a harness whose calibration also collapsed
		// would report the same clean result as a working one. The app decides equality on the
		// SHA-256 of the key rather than on the engine's opinion, and this is what proves the
		// engine is not overruling it.
		expect.assertions(2);

		await seed([
			{
				accountId: accountA,
				date: '2026-06-01T00:00:00.000Z',
				label: 'CAFÉ DE LA GARE',
				cents: -350,
				key: legacyKey('2026-06-01', 'café de la gare', 350, 'r.csv')
			},
			{
				accountId: accountA,
				date: '2026-06-01T00:00:00.000Z',
				label: 'CAFE DE LA GARE',
				cents: -350,
				key: legacyKey('2026-06-01', 'cafe de la gare', 350, 'r.csv')
			}
		]);

		await runDedupeKeyRecompute({ prisma });

		const keys = await storedKeys();
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
	});

	it('carries a populated table from legacy keys to the current version with no row lost', async () => {
		// Absolute figures beside the emptiness assertion, so "nothing left pending" is a
		// measurement rather than a shrug.
		expect.assertions(5);

		await seed(
			Array.from({ length: 12 }, (_, index) => ({
				accountId: index % 2 === 0 ? accountA : accountB,
				date: `2026-06-${String((index % 6) + 1).padStart(2, '0')}T00:00:00.000Z`,
				label: `Marchand ${index % 4}`,
				cents: -(100 + (index % 3) * 10),
				key: legacyKey(
					`2026-06-0${(index % 6) + 1}`,
					`marchand ${index % 4}`,
					100 + (index % 3) * 10,
					'r.csv'
				)
			}))
		);
		const before = await prisma.transaction.count({ where: { userId } });
		expect(before).toBe(12);

		const result = await runDedupeKeyRecompute({ prisma });

		expect(await prisma.transaction.count({ where: { userId } })).toBe(12);
		expect(result.rewritten).toBe(12);
		const keys = await storedKeys();
		expect(keys.every((key) => key !== null && key.startsWith(V3))).toBe(true);
		expect(await hasPendingDedupeKeyVersions(prisma)).toBe(false);
	});

	it('separates one transaction held by two buckets, which the previous key merged', async () => {
		// The #449 shape at the key layer, reported honestly: the key can now separate them, and on
		// the CSV path nothing yet gives a user two buckets for two accounts at one bank. #372 is
		// what makes that effective.
		expect.assertions(2);

		await seed([
			{
				accountId: accountA,
				date: '2026-06-01T00:00:00.000Z',
				label: 'FRAIS DE TENUE',
				cents: -250,
				key: legacyKey('2026-06-01', 'frais de tenue', 250, 'a.csv')
			},
			{
				accountId: accountB,
				date: '2026-06-01T00:00:00.000Z',
				label: 'FRAIS DE TENUE',
				cents: -250,
				key: legacyKey('2026-06-01', 'frais de tenue', 250, 'b.csv')
			}
		]);

		await runDedupeKeyRecompute({ prisma });

		const keys = await storedKeys();
		expect(new Set(keys).size).toBe(2);
		// Both ordinal 0: they are separated by the ACCOUNT rather than by a counter, which is the
		// difference between a key that can express two accounts and one that renumbers around them.
		expect(keys.map((key) => key!.split('|').at(-1))).toEqual(['0', '0']);
	});

	it('accepts a group of three under the unique index, numbered densely', async () => {
		// The constraint is @@unique([userId, dedupeKeyHash]) and it is the database's to enforce.
		// Three identical rows are three keys or the third write throws.
		expect.assertions(2);

		await seed(
			Array.from({ length: 3 }, () => ({
				accountId: accountA,
				date: '2026-06-01T00:00:00.000Z',
				label: 'CAFE',
				cents: -250,
				key: null
			}))
		);
		// Seeded unkeyed above so the three inserts do not collide before the recompute exists;
		// then given legacy keys that differ, which is what a v1 install actually holds.
		const rows = await prisma.transaction.findMany({ where: { userId }, select: { id: true } });
		for (const [index, row] of rows.entries()) {
			const key = legacyKey('2026-06-01', 'cafe', 250, `r${index}.csv`);
			await prisma.transaction.update({
				where: { id: row.id },
				data: { dedupeKey: key, dedupeKeyHash: computeDedupeKeyHash(key) }
			});
		}

		await runDedupeKeyRecompute({ prisma });

		const keys = await storedKeys();
		expect(new Set(keys).size).toBe(3);
		expect(keys.map((key) => key!.split('|').at(-1)).sort()).toEqual(['0', '1', '2']);
	});

	it('is idempotent: a second pass rewrites ZERO rows', async () => {
		// `rewritten: 0`, not "no error". That is the property a migration would have given us and
		// it is now ours to provide.
		expect.assertions(2);

		await seed([
			{
				accountId: accountA,
				date: '2026-06-01T00:00:00.000Z',
				label: 'MARCHAND',
				cents: -100,
				key: legacyKey('2026-06-01', 'marchand', 100, 'r.csv')
			}
		]);

		const first = await runDedupeKeyRecompute({ prisma });
		const second = await runDedupeKeyRecompute({ prisma });

		expect(first.rewritten).toBe(1);
		expect(second.rewritten).toBe(0);
	});

	it('survives a run interrupted halfway, then resumed', async () => {
		// prisma migrate deploy wraps nothing, which is why this is app code: a partial pass has to
		// be recoverable. Proved rather than asserted, by stopping after one batch of one pair.
		expect.assertions(4);

		await seed([
			{
				accountId: accountA,
				date: '2026-06-01T00:00:00.000Z',
				label: 'UN',
				cents: -100,
				key: legacyKey('2026-06-01', 'un', 100, 'r.csv')
			},
			{
				accountId: accountB,
				date: '2026-06-02T00:00:00.000Z',
				label: 'DEUX',
				cents: -200,
				key: legacyKey('2026-06-02', 'deux', 200, 'r.csv')
			}
		]);

		await runDedupeKeyRecompute({ prisma, pairBatchSize: 1, maxBatches: 1 });
		const halfway = await storedKeys();
		expect(halfway.filter((key) => key!.startsWith(V3))).toHaveLength(1);
		expect(await hasPendingDedupeKeyVersions(prisma)).toBe(true);

		const resumed = await runDedupeKeyRecompute({ prisma });

		expect(resumed.rewritten).toBe(1);
		expect((await storedKeys()).every((key) => key!.startsWith(V3))).toBe(true);
	});

	it('keeps a group together when its rows differ only in the time of day', async () => {
		// The crash this walk was one line away from, against a real unique index rather than an
		// array. Reachable through restore, which accepts a full instant where the import path
		// writes midnight. One pair per batch, or the two timestamps land in one pass and the
		// defect is invisible.
		expect.assertions(2);

		await seed([
			{
				accountId: accountA,
				date: '2026-06-01T00:00:00.000Z',
				label: 'MIDI',
				cents: -100,
				key: legacyKey('2026-06-01', 'midi', 100, 'r.csv')
			},
			{
				accountId: accountA,
				date: '2026-06-01T14:30:00.000Z',
				label: 'MIDI',
				cents: -100,
				key: legacyKey('2026-06-01', 'midi', 100, 'r2.csv')
			}
		]);

		await runDedupeKeyRecompute({ prisma, pairBatchSize: 1 });

		const keys = await storedKeys();
		expect(new Set(keys).size).toBe(2);
		expect(keys.map((key) => key!.split('|').at(-1)).sort()).toEqual(['0', '1']);
	});
});
