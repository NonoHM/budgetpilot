import type { PrismaClient } from '../database/types.ts';
import { computeNameKey, computeNullableNameKey } from './nameKey.ts';
import {
	findNetWorthCollisions,
	groupCollisions,
	planAccountMerges,
	planCategoryMerges,
	planValuedMerges,
	type AccountMerge,
	type AccountMergeBlocked,
	type CategoryMerge,
	type NetWorthCollision,
	type ValuedMerge
} from './mergePlan.ts';
import { LONG_TRANSACTION_OPTIONS } from '../dbTransaction.ts';

/**
 * Fills the name-key columns and merges the rows that folding names turns into duplicates.
 *
 * Runs once per install, from the `init` hook, before the app serves anything. It is
 * deliberately app code rather than SQL inside the migration: the merge rules are business
 * decisions with a real chance of losing data if they are wrong, so they live in a pure
 * tested module (`mergePlan.ts`) and are executed here, once, instead of being restated in
 * one hand-written SQL dialect per provider.
 *
 * Idempotent by construction. The plan is derived from the data, so a second run on a
 * migrated database finds no null keys and no collisions, and writes nothing. The caller
 * skips it entirely via `hasPendingNameKeys`, which is a handful of counts.
 *
 * Every write is scoped to one user and wrapped in that user's own transaction, so a
 * failure on one account cannot leave another half-merged.
 */

export interface NameKeyBackfillOptions {
	prisma: PrismaClient;
	/** Compute and report the plan without writing anything. */
	dryRun?: boolean;
	/** Progress sink. The CLI prints; the boot path stays quiet until the summary. */
	onProgress?: (message: string) => void;
}

export interface UserNameKeyReport {
	userId: string;
	categoryMerges: CategoryMerge[];
	accountMerges: AccountMerge[];
	accountMergesBlocked: AccountMergeBlocked[];
	budgetMerges: Array<ValuedMerge<number>>;
	natureMerges: Array<ValuedMerge<string>>;
	netWorthCollisions: NetWorthCollision[];
	/** Rows whose key column was written, per table, merges included. */
	keysWritten: Record<string, number>;
}

export interface NameKeyBackfillReport {
	dryRun: boolean;
	users: UserNameKeyReport[];
	rowsDeleted: number;
	transactionsReassigned: number;
}

/** The six columns the backfill fills, and how to spot a row still missing its key. */
const PENDING_KEY_CHECKS = [
	{
		table: 'Category',
		find: (db: PrismaClient) => db.category.count({ where: { nameKey: null } })
	},
	{ table: 'Account', find: (db: PrismaClient) => db.account.count({ where: { nameKey: null } }) },
	{
		table: 'MonthlyBudget',
		find: (db: PrismaClient) => db.monthlyBudget.count({ where: { categoryNameKey: null } })
	},
	{
		table: 'CategoryNatureMapping',
		find: (db: PrismaClient) => db.categoryNatureMapping.count({ where: { categoryNameKey: null } })
	},
	{
		table: 'NetWorthAccount',
		find: (db: PrismaClient) => db.netWorthAccount.count({ where: { nameKey: null } })
	},
	{
		table: 'Transaction',
		find: (db: PrismaClient) =>
			db.transaction.count({ where: { manualCategory: { not: null }, manualCategoryKey: null } })
	}
] as const;

/**
 * Cheap gate for the boot path: are there rows whose key has never been computed?
 *
 * Deliberately not "are there collisions": once the backfill has run, collisions can no
 * longer be created (every write path now dedupes on the key), so a per-boot collision scan
 * would read every category of every user forever to always find nothing.
 */
export async function hasPendingNameKeys(prisma: PrismaClient): Promise<boolean> {
	for (const check of PENDING_KEY_CHECKS) {
		if ((await check.find(prisma)) > 0) return true;
	}
	return false;
}

export async function runNameKeyBackfill(
	options: NameKeyBackfillOptions
): Promise<NameKeyBackfillReport> {
	const { prisma, dryRun = false, onProgress } = options;
	const users = await prisma.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } });

	const report: NameKeyBackfillReport = {
		dryRun,
		users: [],
		rowsDeleted: 0,
		transactionsReassigned: 0
	};

	for (const user of users) {
		onProgress?.(`Scanning user ${user.id}`);
		const userReport = await processUser(prisma, user.id, dryRun);
		report.users.push(userReport);
		report.rowsDeleted +=
			userReport.categoryMerges.reduce((total, merge) => total + merge.losers.length, 0) +
			userReport.accountMerges.reduce((total, merge) => total + merge.losers.length, 0) +
			userReport.budgetMerges.reduce((total, merge) => total + merge.losers.length, 0) +
			userReport.natureMerges.reduce((total, merge) => total + merge.losers.length, 0);
		report.transactionsReassigned +=
			userReport.categoryMerges.reduce((total, merge) => total + merge.transactionsToReassign, 0) +
			userReport.accountMerges.reduce((total, merge) => total + merge.transactionsToReassign, 0);
	}

	return report;
}

async function processUser(
	prisma: PrismaClient,
	userId: string,
	dryRun: boolean
): Promise<UserNameKeyReport> {
	const [categories, accounts, budgets, natures, netWorthAccounts] = await Promise.all([
		prisma.category.findMany({
			where: { userId },
			select: { id: true, name: true, defaultKey: true, createdAt: true }
		}),
		prisma.account.findMany({
			where: { userId },
			select: {
				id: true,
				name: true,
				source: true,
				currency: true,
				netWorthAccountId: true,
				bankConnectionId: true,
				providerAccountId: true,
				providerCashAccountType: true,
				createdAt: true
			}
		}),
		prisma.monthlyBudget.findMany({
			where: { userId },
			select: { id: true, categoryName: true, amountCents: true, createdAt: true, updatedAt: true }
		}),
		prisma.categoryNatureMapping.findMany({
			where: { userId },
			select: { id: true, categoryName: true, nature: true, createdAt: true, updatedAt: true }
		}),
		prisma.netWorthAccount.findMany({
			where: { userId },
			select: { id: true, name: true, deletedAt: true, createdAt: true }
		})
	]);

	// Transaction counts are only needed for rows that actually collide, and only so the
	// report can state how much data each merge moves. Counting every category of every
	// user to fill a field nobody reads would be the expensive way to say zero.
	const categoryCounts = await countTransactionsFor(
		prisma,
		userId,
		'categoryId',
		collidingIds(categories, (row) => computeNameKey(row.name))
	);
	const accountCounts = await countTransactionsFor(
		prisma,
		userId,
		'accountId',
		collidingIds(accounts, (row) => `${row.source} ${computeNameKey(row.name)}`)
	);

	const categoryMerges = planCategoryMerges(
		categories.map((row) => ({ ...row, transactionCount: categoryCounts.get(row.id) ?? 0 }))
	);
	const accountPlan = planAccountMerges(
		accounts.map((row) => ({ ...row, transactionCount: accountCounts.get(row.id) ?? 0 }))
	);
	const budgetMerges = planValuedMerges(budgets.map((row) => ({ ...row, value: row.amountCents })));
	const natureMerges = planValuedMerges(
		natures.map((row) => ({ ...row, value: row.nature as string }))
	);
	const netWorthCollisions = findNetWorthCollisions(netWorthAccounts);

	const report: UserNameKeyReport = {
		userId,
		categoryMerges,
		accountMerges: accountPlan.merges,
		accountMergesBlocked: accountPlan.blocked,
		budgetMerges,
		natureMerges,
		netWorthCollisions,
		keysWritten: {
			Category: categories.length,
			Account: accounts.length,
			MonthlyBudget: budgets.length,
			CategoryNatureMapping: natures.length,
			NetWorthAccount: netWorthAccounts.length,
			Transaction: 0
		}
	};

	if (dryRun) {
		report.keysWritten.Transaction = await prisma.transaction.count({
			where: { userId, manualCategory: { not: null } }
		});
		return report;
	}

	await prisma.$transaction(async (tx) => {
		// Merges first: they delete rows, so writing keys before would be wasted work and,
		// worse, would briefly leave two rows carrying the same key.
		for (const merge of categoryMerges) {
			const loserIds = merge.losers.map((row) => row.id);
			await tx.transaction.updateMany({
				where: { userId, categoryId: { in: loserIds } },
				data: { categoryId: merge.survivorId }
			});
			// Parts point at a category by id and `TransactionSplit` has no cascade from `Category`,
			// so the deleteMany below fails on the foreign key if a répartition still carries a loser.
			// Repointing to the survivor is the RIGHT answer here, unlike in /categories' delete path
			// (which refuses): a merge folds two spellings of one category into one, so the part keeps
			// meaning exactly what it meant. Two parts of one transaction can end up in the same
			// category, which is legal and needs no reconciliation.
			await tx.transactionSplit.updateMany({
				where: { categoryId: { in: loserIds }, transaction: { userId } },
				data: { categoryId: merge.survivorId }
			});
			await tx.category.deleteMany({ where: { userId, id: { in: loserIds } } });
			await tx.category.updateMany({
				where: { userId, id: merge.survivorId },
				data: { defaultKey: merge.resolvedDefaultKey }
			});
		}

		for (const merge of accountPlan.merges) {
			const loserIds = merge.losers.map((row) => row.id);
			await tx.transaction.updateMany({
				where: { userId, accountId: { in: loserIds } },
				data: { accountId: merge.survivorId }
			});
			await tx.account.deleteMany({ where: { userId, id: { in: loserIds } } });
			if (Object.keys(merge.adoptedLinks).length > 0) {
				await tx.account.updateMany({
					where: { userId, id: merge.survivorId },
					data: merge.adoptedLinks
				});
			}
		}

		for (const merge of budgetMerges) {
			await tx.monthlyBudget.deleteMany({
				where: { userId, id: { in: merge.losers.map((row) => row.id) } }
			});
			await tx.monthlyBudget.updateMany({
				where: { userId, id: merge.survivorId },
				data: { amountCents: merge.resolvedValue }
			});
		}

		for (const merge of natureMerges) {
			await tx.categoryNatureMapping.deleteMany({
				where: { userId, id: { in: merge.losers.map((row) => row.id) } }
			});
			await tx.categoryNatureMapping.updateMany({
				where: { userId, id: merge.survivorId },
				data: { nature: merge.resolvedValue as never }
			});
		}

		// Then the keys, for every surviving row. Writing them one by one keeps this
		// provider-independent: there is no portable "UPDATE ... SET key = f(name)".
		const deletedCategoryIds = new Set(
			categoryMerges.flatMap((merge) => merge.losers.map((row) => row.id))
		);
		const deletedAccountIds = new Set(
			accountPlan.merges.flatMap((merge) => merge.losers.map((row) => row.id))
		);
		const deletedBudgetIds = new Set(
			budgetMerges.flatMap((merge) => merge.losers.map((row) => row.id))
		);
		const deletedNatureIds = new Set(
			natureMerges.flatMap((merge) => merge.losers.map((row) => row.id))
		);

		for (const row of categories) {
			if (deletedCategoryIds.has(row.id)) continue;
			await tx.category.updateMany({
				where: { userId, id: row.id },
				data: { nameKey: computeNameKey(row.name) }
			});
		}
		for (const row of accounts) {
			if (deletedAccountIds.has(row.id)) continue;
			await tx.account.updateMany({
				where: { userId, id: row.id },
				data: { nameKey: computeNameKey(row.name) }
			});
		}
		for (const row of budgets) {
			if (deletedBudgetIds.has(row.id)) continue;
			await tx.monthlyBudget.updateMany({
				where: { userId, id: row.id },
				data: { categoryNameKey: computeNameKey(row.categoryName) }
			});
		}
		for (const row of natures) {
			if (deletedNatureIds.has(row.id)) continue;
			await tx.categoryNatureMapping.updateMany({
				where: { userId, id: row.id },
				data: { categoryNameKey: computeNameKey(row.categoryName) }
			});
		}
		for (const row of netWorthAccounts) {
			await tx.netWorthAccount.updateMany({
				where: { userId, id: row.id },
				data: { nameKey: computeNameKey(row.name) }
			});
		}

		report.keysWritten.Category = categories.length - deletedCategoryIds.size;
		report.keysWritten.Account = accounts.length - deletedAccountIds.size;
		report.keysWritten.MonthlyBudget = budgets.length - deletedBudgetIds.size;
		report.keysWritten.CategoryNatureMapping = natures.length - deletedNatureIds.size;
		report.keysWritten.Transaction = await backfillTransactionKeys(tx, userId);
	}, LONG_TRANSACTION_OPTIONS);

	return report;
}

type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Rows per `id: { in: [...] }` batch, well under every provider's bind-parameter limit. */
const KEY_UPDATE_BATCH = 500;

/**
 * `manualCategory` is a free-text pin on a transaction, so its key is a plain per-row
 * derivation with no merge decision attached.
 *
 * Rows are selected by id, never by re-matching the name in SQL. This code exists precisely
 * because name equality in SQL is the database's opinion rather than the app's: on a
 * case-insensitive collation, `manualCategory = 'Courses'` also matches every row pinned to
 * "courses", and under `utf8mb4_general_ci` a single emoji matches every other emoji. Writing
 * the key of the row you asked for onto rows you did not is exactly the failure mode this
 * whole change removes, so the backfill must not depend on that equality either.
 */
async function backfillTransactionKeys(tx: TransactionClient, userId: string): Promise<number> {
	const rows = await tx.transaction.findMany({
		where: { userId, manualCategory: { not: null } },
		select: { id: true, manualCategory: true }
	});

	// One update per distinct key rather than per row: the pins come from the same category
	// vocabulary, so the grouping is small even on a large history.
	const idsByKey = new Map<string, string[]>();
	for (const row of rows) {
		const key = computeNullableNameKey(row.manualCategory);
		if (key === null) continue;
		const bucket = idsByKey.get(key);
		if (bucket) bucket.push(row.id);
		else idsByKey.set(key, [row.id]);
	}

	let updated = 0;
	for (const [key, ids] of idsByKey) {
		for (let start = 0; start < ids.length; start += KEY_UPDATE_BATCH) {
			const result = await tx.transaction.updateMany({
				where: { userId, id: { in: ids.slice(start, start + KEY_UPDATE_BATCH) } },
				data: { manualCategoryKey: key }
			});
			updated += result.count;
		}
	}
	return updated;
}

/** Ids belonging to a group of two or more rows that fold to the same key. */
function collidingIds<T extends { id: string; createdAt: Date }>(
	rows: T[],
	keyOf: (row: T) => string
): string[] {
	return groupCollisions(rows, keyOf).flatMap((group) => [
		group.survivor.id,
		...group.losers.map((row) => row.id)
	]);
}

async function countTransactionsFor(
	prisma: PrismaClient,
	userId: string,
	field: 'categoryId' | 'accountId',
	ids: string[]
): Promise<Map<string, number>> {
	if (ids.length === 0) return new Map();
	const grouped = await prisma.transaction.groupBy({
		by: [field],
		where: { userId, [field]: { in: ids } },
		_count: { _all: true }
	});
	return new Map(grouped.map((row) => [row[field] as string, row._count._all]));
}
