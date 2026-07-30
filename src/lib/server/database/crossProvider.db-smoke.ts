import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { resolveDatabaseProvider } from '$lib/server/database/provider';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { computeDedupeKeyHash } from '$lib/server/import/dedupeKey';
import { resolveCategoryByName } from '$lib/server/categories/resolve';
import { saveBudget, readMonthlyBudgets } from '$lib/server/budget/dashboard';
import { restoreMissingDefaultCategories } from '$lib/server/categories/defaults';
import {
	saveCategoryNatureMapping,
	readCategoryNatureMappings
} from '$lib/server/transactions/nature';
import {
	resolveImportBucketAccount,
	createImportBatch,
	persistImportedTransactions
} from '$lib/server/import/persist';
import { hasPendingNameKeys, runNameKeyBackfill } from '$lib/server/naming/backfill';
import {
	hasPendingDedupeKeyHashes,
	runDedupeKeyHashBackfill
} from '$lib/server/import/dedupeBackfill';
import type { ImportedTransaction } from '$lib/server/import/types';

/**
 * What this file proves, and why it cannot be proved anywhere else.
 *
 * The app decides name and fingerprint equality itself, in `computeNameKey` and
 * `computeDedupeKeyHash`, because SQL string equality is answered by the column's collation:
 * binary on SQLite, deterministic on PostgreSQL, case- and accent-insensitive by default on
 * MySQL and MariaDB. "Café" and "Cafe" are one value on one engine and two on another, and both
 * halves of that are wrong somewhere. Unit tests assert the app computes the keys; only a real
 * server can assert the database then enforces them.
 *
 * The same is true of concurrency. Every folded write path here is a single upsert on a key
 * rather than a read followed by a write, and the old shape was safe only because SQLite
 * serializes writers. Whether it is safe under READ COMMITTED is a question for PostgreSQL and
 * MySQL, not for a mock.
 *
 * See vitest.db.config.ts for how to run it.
 */

// Refuses to run against an implicit database, and this guard is not politeness. The suite
// imports the app's own client, which falls back to `file:./dev.db` when DATABASE_URL is unset —
// a developer's real local database. Two of the tests below then call the boot backfills, which
// are deliberately global rather than userId-scoped: they walk every user and MERGE categories,
// deleting rows. The per-user cleanup at the end of this file would not undo that. So the
// database has to be named on purpose, every time.
if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database and runs the global boot backfills. Set DATABASE_URL ' +
			'(and DATABASE_PROVIDER for a server engine) to a throwaway database explicitly. It ' +
			'refuses to fall back to the default local SQLite file.'
	);
}

const provider = resolveDatabaseProvider(process.env);

/** Users are the isolation boundary here, exactly as they are in the app. */
async function createUser(): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `db-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			// Not a hash of anything, and never used to authenticate: nothing in this suite logs in.
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	return user.id;
}

function importedTransaction(
	overrides: Partial<ImportedTransaction> & { dedupeKey?: string }
): ImportedTransaction {
	const { dedupeKey, ...rest } = overrides;
	return {
		id: '',
		date: '2026-03-01',
		label: 'CARREFOUR MARKET',
		amountCents: -1250,
		type: 'expense',
		category: 'Non catégorisé',
		source: 'csv',
		...rest,
		metadata: {
			reference: '',
			notes: '',
			type: 'expense',
			deduplicationKey: dedupeKey ?? '',
			...rest.metadata
		}
	};
}

const createdUserIds: string[] = [];

async function freshUser(): Promise<string> {
	const userId = await createUser();
	createdUserIds.push(userId);
	return userId;
}

afterAll(async () => {
	// Every owned row cascades from the user (onDelete: Cascade throughout the schema), so
	// deleting the users is the whole cleanup. CI throws the container away anyway; this keeps a
	// developer's own scratch database usable across runs.
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
	await prisma.$disconnect();
});

describe(`cross-provider database behavior (${provider})`, () => {
	let userId: string;

	beforeEach(async () => {
		userId = await freshUser();
	});

	it('connects to the configured provider and applies its migration history', async () => {
		// If the migrations never ran, or ran against a different schema, every other test here
		// fails with something unhelpful. Ask the question directly first.
		const count = await prisma.user.count({ where: { id: userId } });
		expect(count).toBe(1);
	});

	describe('folded name equality', () => {
		it('resolves two spellings of one category to the same row and keeps the first spelling', async () => {
			const first = await resolveCategoryByName(userId, 'Café');
			const second = await resolveCategoryByName(userId, 'cafe');

			expect(second.id).toBe(first.id);

			const stored = await prisma.category.findMany({
				where: { userId },
				select: { name: true }
			});
			// An import announcing "cafe" must not rename the category the user called "Café".
			expect(stored).toEqual([{ name: 'Café' }]);
		});

		it('keeps names that fold differently apart', async () => {
			const courses = await resolveCategoryByName(userId, 'Courses');
			const loisirs = await resolveCategoryByName(userId, 'Loisirs');

			expect(loisirs.id).not.toBe(courses.id);
		});

		it('rejects a second category carrying an existing folded key', async () => {
			await resolveCategoryByName(userId, 'Courses');

			// The direct write is the point: this is the guarantee the database owns, not the one
			// the application's own pre-checks provide.
			await expect(
				prisma.category.create({
					data: { userId, name: 'COURSES', nameKey: computeNameKey('COURSES') }
				})
			).rejects.toMatchObject({ code: 'P2002' });
		});

		it('scopes the constraint to one user', async () => {
			const otherUserId = await freshUser();

			const mine = await resolveCategoryByName(userId, 'Courses');
			const theirs = await resolveCategoryByName(otherUserId, 'Courses');

			expect(theirs.id).not.toBe(mine.id);
		});
	});

	describe('concurrent writers', () => {
		it('collapses concurrent first-time category creations onto one row', async () => {
			// The race the single upsert exists for. Under READ COMMITTED two writers can both
			// miss a preceding read, which is why there is no preceding read any more.
			const results = await Promise.all(
				Array.from({ length: 8 }, () => resolveCategoryByName(userId, 'Abonnements'))
			);

			const ids = new Set(results.map((result) => result.id));
			expect(ids.size).toBe(1);

			const rows = await prisma.category.count({ where: { userId } });
			expect(rows).toBe(1);
		});

		it('collapses concurrent budget saves for one folded category onto one row', async () => {
			// The case that first exposed the empty-update problem: this failed with P2002 on
			// PostgreSQL while every SQLite run passed. Six spellings rather than two, so the
			// race is hit rather than hoped for.
			const spellings = [
				'Alimentation',
				'ALIMENTATION',
				'alimentation',
				'AlImEnTaTiOn',
				'Álimentation',
				'alimentation '
			];
			await Promise.all(
				spellings.map((category) => saveBudget(userId, { category, limit: '250' }))
			);

			const budgets = await readMonthlyBudgets(userId);
			expect(budgets).toHaveLength(1);
			expect(budgets[0].amountCents).toBe(25000);

			const categories = await prisma.category.count({ where: { userId } });
			expect(categories).toBe(1);
		});

		it('lets two simultaneous default-category restores both succeed', async () => {
			// A double-click on "Restore default categories". Both calls see the same missing
			// set and both insert it, which is why the upsert loop there is retried rather than
			// merely upserted.
			const [first, second] = await Promise.all([
				restoreMissingDefaultCategories(userId),
				restoreMissingDefaultCategories(userId)
			]);

			expect(first + second).toBeGreaterThan(0);

			const names = await prisma.category.findMany({ where: { userId }, select: { name: true } });
			expect(new Set(names.map((row) => row.name)).size).toBe(names.length);
		});

		it('collapses concurrent nature mappings for one folded category onto one row', async () => {
			await Promise.all([
				saveCategoryNatureMapping(userId, { categoryName: 'Salaire', nature: 'income' }),
				saveCategoryNatureMapping(userId, { categoryName: 'salaire', nature: 'refund' })
			]);

			const mappings = await readCategoryNatureMappings(userId);
			expect(mappings).toHaveLength(1);
			expect(['income', 'refund']).toContain(mappings[0].nature);
		});
	});

	describe('import deduplication', () => {
		async function importRows(rows: ImportedTransaction[]) {
			const bucket = await resolveImportBucketAccount({
				userId,
				name: 'Compte courant',
				source: 'csv'
			});
			const batchId = await createImportBatch({
				userId,
				source: 'csv',
				fileName: 'db-smoke.csv',
				profile: 'generic',
				rowCount: rows.length,
				invalidRows: 0,
				period: { from: '2026-03-01', to: '2026-03-31' }
			});
			return persistImportedTransactions({
				userId,
				accountId: bucket.accountId,
				importBatchId: batchId,
				source: 'csv',
				transactions: rows
			});
		}

		it('treats two fingerprints differing only by an accent as two transactions', async () => {
			// The bug this whole hash exists for. On a MySQL default collation the raw keys
			// compare equal, and one of two genuine payments is swallowed as a duplicate.
			const result = await importRows([
				importedTransaction({
					label: 'CAFÉ DE LA GARE',
					dedupeKey: '2026-03-01|café de la gare|-1250'
				}),
				importedTransaction({
					label: 'CAFE DE LA GARE',
					dedupeKey: '2026-03-01|cafe de la gare|-1250'
				})
			]);

			expect(result.importedRows).toBe(2);
			expect(result.duplicateRows).toBe(0);
		});

		it('skips a row whose fingerprint was already imported', async () => {
			const row = importedTransaction({ dedupeKey: '2026-03-01|carrefour market|-1250' });

			const first = await importRows([row]);
			expect(first.importedRows).toBe(1);

			const second = await importRows([row]);
			expect(second).toMatchObject({ importedRows: 0, duplicateRows: 1 });
		});

		it('carries on with the rest of the batch after a duplicate', async () => {
			// PostgreSQL aborts the enclosing transaction when a constraint fires, so a caught
			// unique violation only survives if persistTransaction runs outside one. The rows
			// after the duplicate are what proves it does.
			const duplicate = importedTransaction({ dedupeKey: '2026-03-02|loyer|-70000' });
			await importRows([duplicate]);

			const result = await importRows([
				duplicate,
				importedTransaction({ label: 'SNCF', dedupeKey: '2026-03-03|sncf|-4500' }),
				importedTransaction({ label: 'EDF', dedupeKey: '2026-03-04|edf|-8900' })
			]);

			expect(result).toMatchObject({ importedRows: 2, duplicateRows: 1 });
		});

		it('rejects a second transaction carrying an existing fingerprint hash', async () => {
			const account = await resolveImportBucketAccount({ userId, name: 'Direct', source: 'csv' });
			const category = await resolveCategoryByName(userId, 'Non catégorisé');
			const dedupeKey = '2026-03-05|direct|-100';

			const data = {
				userId,
				accountId: account.accountId,
				categoryId: category.id,
				date: new Date('2026-03-05T00:00:00.000Z'),
				label: 'DIRECT',
				amountCents: -100,
				type: 'expense',
				source: 'csv',
				dedupeKey,
				dedupeKeyHash: computeDedupeKeyHash(dedupeKey)
			};

			await prisma.transaction.create({ data });
			await expect(prisma.transaction.create({ data })).rejects.toMatchObject({ code: 'P2002' });
		});
	});

	describe('bucket resolution', () => {
		it('lands every folded spelling on one bucket', async () => {
			const first = await resolveImportBucketAccount({
				userId,
				name: 'Compte joint',
				source: 'csv'
			});
			const again = await resolveImportBucketAccount({
				userId,
				name: 'COMPTE JOINT',
				source: 'csv'
			});

			expect(first.created).toBe(true);
			expect(again).toEqual({ accountId: first.accountId, created: false });
		});

		// Account is the one keyed table with no unique constraint on its key: the name-key
		// backfill refuses to merge buckets carrying conflicting bank or net-worth links and
		// leaves both in place, so several rows can legitimately share a key. An unordered
		// findFirst over them is stable on SQLite and arbitrary on PostgreSQL, which is what the
		// `orderBy` on that lookup exists for.
		//
		// The situation cannot arise on MySQL at all, and the next test is what says so: the raw
		// `(userId, name, source)` constraint still standing there is itself case- and
		// accent-insensitive, so the second row is refused before it exists.
		it.skipIf(provider === 'mysql')(
			'answers with the oldest bucket every time when several share a folded name',
			async () => {
				const nameKey = computeNameKey('Compte joint');
				const older = await prisma.account.create({
					data: {
						userId,
						name: 'Compte joint',
						nameKey,
						source: 'csv',
						createdAt: new Date('2026-01-01T00:00:00.000Z')
					},
					select: { id: true }
				});
				await prisma.account.create({
					data: {
						userId,
						name: 'COMPTE JOINT',
						nameKey,
						source: 'csv',
						createdAt: new Date('2026-02-01T00:00:00.000Z')
					}
				});

				const resolutions = await Promise.all([
					resolveImportBucketAccount({ userId, name: 'compte joint', source: 'csv' }),
					resolveImportBucketAccount({ userId, name: 'Compte Joint', source: 'csv' }),
					resolveImportBucketAccount({ userId, name: 'COMPTE JOINT', source: 'csv' })
				]);

				for (const resolution of resolutions) {
					expect(resolution).toEqual({ accountId: older.id, created: false });
				}
			}
		);

		it.runIf(provider === 'mysql')(
			'refuses a second bucket whose name folds onto an existing one',
			async () => {
				await prisma.account.create({
					data: {
						userId,
						name: 'Compte joint',
						nameKey: computeNameKey('Compte joint'),
						source: 'csv'
					}
				});

				// The engine's own collation, not the app's key, is what rejects this. Stricter
				// than the other two providers and in the same direction the app already wants,
				// so it is recorded rather than worked around.
				await expect(
					prisma.account.create({
						data: {
							userId,
							name: 'COMPTE JOINT',
							nameKey: computeNameKey('COMPTE JOINT'),
							source: 'csv'
						}
					})
				).rejects.toMatchObject({ code: 'P2002' });
			}
		);
	});

	// The two tests here are the only ones that reach outside their own user: `hasPending*` and
	// `runNameKeyBackfill` ask about, and rewrite, the whole database, because that is what they
	// do at boot. It holds because every other test in this file writes its keys eagerly, so
	// nothing else is ever pending. A future test that creates a deliberately unkeyed row and
	// leaves it there would break these two, and the failure would point here rather than at
	// itself — move that row's creation into its own test if it comes up.
	describe('boot backfills against the new constraints', () => {
		it('merges unkeyed folded duplicates without violating the unique index', async () => {
			// The upgrade path in one test: `migrate deploy` creates the index before any app
			// code runs, so an install arriving from an earlier release meets it with every key
			// still NULL. NULLs are distinct in a unique index on all three providers, which is
			// what lets both rows exist until the backfill merges them.
			const survivor = await prisma.category.create({
				data: {
					userId,
					name: 'Courses',
					nameKey: null,
					createdAt: new Date('2026-01-01T00:00:00.000Z')
				},
				select: { id: true }
			});
			const loser = await prisma.category.create({
				data: {
					userId,
					name: 'COURSES',
					nameKey: null,
					createdAt: new Date('2026-02-01T00:00:00.000Z')
				},
				select: { id: true }
			});

			expect(await hasPendingNameKeys(prisma)).toBe(true);

			await runNameKeyBackfill({ prisma });

			const remaining = await prisma.category.findMany({
				where: { userId },
				select: { id: true, nameKey: true }
			});
			expect(remaining).toEqual([{ id: survivor.id, nameKey: computeNameKey('Courses') }]);
			expect(remaining.map((row) => row.id)).not.toContain(loser.id);

			// Idempotent: an install that already ran it skips the work entirely on the next boot.
			expect(await hasPendingNameKeys(prisma)).toBe(false);
		});

		it('hashes fingerprints left over from an earlier release', async () => {
			const account = await resolveImportBucketAccount({ userId, name: 'Ancien', source: 'csv' });
			const category = await resolveCategoryByName(userId, 'Non catégorisé');
			const dedupeKey = '2026-03-06|ancien|-500';

			await prisma.transaction.create({
				data: {
					userId,
					accountId: account.accountId,
					categoryId: category.id,
					date: new Date('2026-03-06T00:00:00.000Z'),
					label: 'ANCIEN',
					amountCents: -500,
					type: 'expense',
					source: 'csv',
					dedupeKey,
					dedupeKeyHash: null
				}
			});

			expect(await hasPendingDedupeKeyHashes(prisma)).toBe(true);

			const written = await runDedupeKeyHashBackfill({ prisma });
			expect(written).toBe(1);

			const row = await prisma.transaction.findFirst({
				where: { userId },
				select: { dedupeKeyHash: true }
			});
			expect(row?.dedupeKeyHash).toBe(computeDedupeKeyHash(dedupeKey));
			expect(await hasPendingDedupeKeyHashes(prisma)).toBe(false);
		});
	});
});
