import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import type { CategoryBudget } from '$lib/domain/budget';
import { resolveCategoryByName } from '$lib/server/categories/resolve';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { withConcurrentWriteRetry } from '$lib/server/database/upsert';
import type { Transaction } from '$lib/domain/transaction';
import { allocateByCategory, type CategoryAllocation } from '$lib/domain/allocation';
import { validateTransaction } from '$lib/domain/transaction';
import { parseManualAmountCents } from '$lib/domain/money';
import type { DateRange } from '$lib/server/date-range';
import { prisma } from '$lib/server/db';
import { normalizeId } from '$lib/server/transactions/where';
import { collectAllTransactions } from '$lib/server/transactions/batch';
import {
	buildCategoryNatureMap,
	EFFECTIVE_CATEGORY_SELECT,
	getEffectiveCategory,
	mapTransactionAllocations,
	mapTransactionWithNature,
	type CategoryNatureMappingRecord
} from '$lib/server/transactions/nature';

const MANUAL_ACCOUNT_NAME = 'Compte manuel';
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const MAX_BUDGET_AMOUNT_CENTS = 100_000_000;
const MAX_BUDGET_CATEGORY_LENGTH = 80;

/** Re-exported for callers/tests that historically imported it from here (dashboard.ts). The
 *  actual implementation lives in domain/money.ts, per the architecture posture (pure logic
 *  belongs in domain/, not server/). */
export { parseManualAmountCents } from '$lib/domain/money';

export interface DashboardData {
	/**
	 * The IDENTITY view: one entry per bank line. Read this to ask what happened, how many times,
	 * when, and under what label. Never to ask where the money went — a split transaction still
	 * appears here once, carrying its whole amount under its parent category, and summing these
	 * per category is the double-count this whole design exists to prevent.
	 */
	transactions: Transaction[];
	/**
	 * The MONEY view: one entry per (category, amount) pair. An unsplit transaction contributes
	 * exactly one, so the two arrays have the same total and differ only in how it is attributed.
	 *
	 * CategoryAllocation is deliberately not assignable to Transaction, so passing this to
	 * detectRecurringFlows or any other identity-side consumer is a compile error rather than a
	 * review comment.
	 */
	allocations: CategoryAllocation[];
	budgets: CategoryBudget[];
	categoryNatureMappings: CategoryNatureMappingRecord[];
}

export interface CreateTransactionInput {
	date: string;
	label: string;
	amount: string;
	category: string;
}

export interface SaveBudgetInput {
	category: string;
	limit: string;
	month?: string;
}

export interface MonthlyBudgetRecord {
	id: string;
	categoryName: string;
	amountCents: number;
	createdAt: string;
	updatedAt: string;
}

export function getCurrentMonth(): string {
	const now = new Date();
	const month = `${now.getMonth() + 1}`.padStart(2, '0');
	return `${now.getFullYear()}-${month}`;
}

export function parseMonth(value: string | null): string {
	if (!value) return getCurrentMonth();
	if (!isValidMonth(value)) throw error(400, 'Mois invalide');
	return value;
}

export async function readDashboardData(userId: string, month: string): Promise<DashboardData> {
	const [year, monthNumber] = month.split('-').map(Number);
	return readDashboardDataForRange(userId, {
		from: new Date(Date.UTC(year, monthNumber - 1, 1)),
		to: getNextMonthStart(month),
		budgetMonth: month
	});
}

export async function readDashboardDataForRange(
	userId: string,
	range: Pick<DateRange, 'from' | 'to' | 'budgetMonth'>
): Promise<DashboardData> {
	const [transactions, budgets, mappings] = await Promise.all([
		// Batched (see collectAllTransactions/forEachTransactionBatch), not a plain findMany: this
		// select spreads EFFECTIVE_CATEGORY_SELECT, whose `splits` relation Prisma resolves with a
		// second query carrying one host parameter per parent row, and SQLite refuses that query
		// once the parent count crosses the batch cap. An unbatched findMany here 500'd on any
		// range wide enough to cross it. `order: 'desc'` matches this read's previous `orderBy`.
		collectAllTransactions(
			{
				userId,
				date: {
					gte: range.from,
					lt: range.to
				}
			},
			{
				id: true,
				date: true,
				label: true,
				amountCents: true,
				type: true,
				source: true,
				natureManual: true,
				...EFFECTIVE_CATEGORY_SELECT
			},
			{ order: 'desc' }
		),
		prisma.monthlyBudget.findMany({
			where: { userId },
			orderBy: { categoryName: 'asc' }
		}),
		prisma.categoryNatureMapping.findMany({
			where: { userId },
			orderBy: { categoryName: 'asc' }
		})
	]);
	const mappingMap = buildCategoryNatureMap(mappings);

	return {
		transactions: transactions.map((transaction) => ({
			...mapTransactionWithNature(transaction, mappingMap)
		})),
		allocations: transactions.flatMap((transaction) =>
			mapTransactionAllocations(transaction, mappingMap)
		),
		budgets: budgets.map((budget) => ({
			category: budget.categoryName,
			limitCents: budget.amountCents
		})),
		categoryNatureMappings: mappings.map((mapping) => ({
			id: mapping.id,
			categoryName: mapping.categoryName,
			nature: mapping.nature,
			createdAt: mapping.createdAt.toISOString(),
			updatedAt: mapping.updatedAt.toISOString()
		}))
	};
}

export async function createManualTransaction(
	userId: string,
	input: CreateTransactionInput
): Promise<void> {
	const amountCents = parseManualAmountCents(input.amount);
	if (amountCents === null) throw error(400, m.dashboard_error_invalid_amount());

	const transaction: Transaction = {
		id: 'pending',
		date: input.date.trim(),
		label: input.label.trim(),
		amountCents,
		type: amountCents >= 0 ? 'income' : 'expense',
		category: normalizeBudgetCategoryName(input.category),
		source: 'manual'
	};
	const validation = validateTransaction(transaction);
	if (!validation.ok) throw error(400, validation.errors.join(', '));

	const [account, category] = await Promise.all([
		ensureManualAccount(userId),
		resolveCategoryByName(userId, transaction.category)
	]);

	await prisma.transaction.create({
		data: {
			userId,
			accountId: account.id,
			categoryId: category.id,
			date: new Date(`${transaction.date}T00:00:00.000Z`),
			label: transaction.label,
			amountCents: transaction.amountCents,
			type: transaction.type,
			source: 'manual'
		}
	});
}

export async function saveBudget(userId: string, input: SaveBudgetInput): Promise<void> {
	if (input.month && !isValidMonth(input.month)) throw error(400, m.budgets_error_invalid_month());

	const limitCents = parseBudgetAmountCents(input.limit);
	const categoryName = normalizeBudgetCategoryName(input.category);
	if (limitCents === null) throw error(400, m.budgets_error_invalid_amount());
	if (!categoryName) throw error(400, m.budgets_error_invalid_category());

	await resolveCategoryByName(userId, categoryName);
	await upsertBudgetByFoldedName(userId, categoryName, limitCents);
}

export async function readMonthlyBudgets(userId: string): Promise<MonthlyBudgetRecord[]> {
	const budgets = await prisma.monthlyBudget.findMany({
		where: { userId },
		orderBy: { categoryName: 'asc' }
	});

	return budgets.map((budget) => ({
		id: budget.id,
		categoryName: budget.categoryName,
		amountCents: budget.amountCents,
		createdAt: budget.createdAt.toISOString(),
		updatedAt: budget.updatedAt.toISOString()
	}));
}

export async function deleteBudget(userId: string, budgetId: string): Promise<void> {
	if (!normalizeId(budgetId)) throw error(400, m.budgets_error_invalid_amount());

	const result = await prisma.monthlyBudget.deleteMany({
		where: { id: budgetId, userId }
	});
	if (result.count === 0) throw error(404, m.budgets_error_not_found());
}

export async function updateBudget(
	userId: string,
	budgetId: string,
	input: SaveBudgetInput
): Promise<void> {
	if (!normalizeId(budgetId)) throw error(400, m.budgets_error_invalid_amount());

	const existing = await prisma.monthlyBudget.findFirst({
		where: { id: budgetId, userId }
	});
	if (!existing) throw error(404, m.budgets_error_not_found());

	const categoryName = normalizeBudgetCategoryName(input.category);
	const amountCents = parseBudgetAmountCents(input.limit);
	if (!categoryName) throw error(400, m.budgets_error_invalid_category());
	if (amountCents === null) throw error(400, m.budgets_error_invalid_amount());

	await resolveCategoryByName(userId, categoryName);

	if (computeNameKey(existing.categoryName) === computeNameKey(categoryName)) {
		await prisma.monthlyBudget.updateMany({
			where: { id: budgetId, userId },
			data: { amountCents }
		});
		return;
	}

	const target = await upsertBudgetByFoldedName(userId, categoryName, amountCents);

	if (target.id !== existing.id) {
		await prisma.monthlyBudget.deleteMany({
			where: { id: existing.id, userId }
		});
	}
}

export async function readBudgetCategoryOptions(userId: string): Promise<string[]> {
	const [categories, manualCategories] = await Promise.all([
		prisma.category.findMany({
			where: { userId },
			orderBy: { name: 'asc' },
			select: { name: true }
		}),
		prisma.transaction.findMany({
			where: {
				userId,
				manualCategory: { not: null }
			},
			distinct: ['manualCategory'],
			orderBy: { manualCategory: 'asc' },
			select: { manualCategory: true }
		})
	]);

	return [
		...new Set([
			...categories.map((item) => item.name),
			...manualCategories.flatMap((item) => (item.manualCategory ? [item.manualCategory] : []))
		])
	].sort((left, right) => left.localeCompare(right, 'fr'));
}

/**
 * Get-or-create for a budget, matching on the folded category name.
 *
 * Mirrors resolveCategoryByName, including why it is one `upsert` on the key rather than a
 * read then a write: a budget saved on "courses" has to land on the row already held by
 * "Courses", because the two are one category for every reader of this table, and two
 * concurrent saves must not each insert their own row.
 *
 * `categoryName` is only written on creation, so an existing budget keeps the spelling it was
 * created with while its amount is updated.
 */
async function upsertBudgetByFoldedName(
	userId: string,
	categoryName: string,
	amountCents: number
): Promise<{ id: string }> {
	const categoryNameKey = computeNameKey(categoryName);

	return withConcurrentWriteRetry(() =>
		prisma.monthlyBudget.upsert({
			where: { userId_categoryNameKey: { userId, categoryNameKey } },
			update: { amountCents },
			create: { userId, categoryName, categoryNameKey, amountCents },
			select: { id: true }
		})
	);
}

/**
 * Idempotent upsert of the implicit manual-entry bucket — never overwrites an existing link.
 *
 * Retried on a concurrent insert for the reason in server/database/upsert.ts: this runs on the
 * very first manual transaction a user creates, and two submissions arriving together would
 * otherwise have one of them fail on the unique constraint.
 */
export async function ensureManualAccount(userId: string) {
	return withConcurrentWriteRetry(() =>
		prisma.account.upsert({
			where: {
				userId_name_source: {
					userId,
					name: MANUAL_ACCOUNT_NAME,
					source: 'manual'
				}
			},
			update: {},
			create: {
				userId,
				name: MANUAL_ACCOUNT_NAME,
				nameKey: computeNameKey(MANUAL_ACCOUNT_NAME),
				source: 'manual',
				currency: 'EUR'
			}
		})
	);
}

/** Read-only lookup: unlike ensureManualAccount, never creates the bucket as a side effect. */
export async function findManualAccount(
	userId: string
): Promise<{ id: string; netWorthAccountId: string | null } | null> {
	return prisma.account.findUnique({
		where: {
			userId_name_source: {
				userId,
				name: MANUAL_ACCOUNT_NAME,
				source: 'manual'
			}
		},
		select: { id: true, netWorthAccountId: true }
	});
}

function parseBudgetAmountCents(value: string): number | null {
	const amountCents = parseManualAmountCents(value);
	if (amountCents === null || amountCents <= 0 || amountCents > MAX_BUDGET_AMOUNT_CENTS) {
		return null;
	}

	return amountCents;
}

function normalizeBudgetCategoryName(value: string): string {
	const normalized = value.trim().replace(/\s+/g, ' ');
	if (
		!normalized ||
		normalized.length > MAX_BUDGET_CATEGORY_LENGTH ||
		/[<>\p{Cc}]/u.test(normalized)
	) {
		return '';
	}
	if (normalized === UNCLASSIFIED_CATEGORY) throw error(400, m.categories_error_reserved_name());

	return normalized;
}

function getNextMonthStart(month: string): Date {
	const [year, monthNumber] = month.split('-').map(Number);
	return new Date(Date.UTC(year, monthNumber, 1));
}

function isValidMonth(value: string): boolean {
	if (!MONTH_PATTERN.test(value)) return false;
	const month = Number(value.slice(5, 7));
	return month >= 1 && month <= 12;
}

/**
 * Per-category spending for the CURRENT calendar month.
 *
 * Two things about it that are easy to miss, both pre-existing and both left as they are:
 *
 *  - It reads the WALL CLOCK, so it is the one aggregate here that cannot be pinned by passing a
 *    range. Anything measuring this function (a golden master, a fixture) has to seed against the
 *    real current month or accept that its output moves.
 *  - It selects `type: 'expense'` in SQL, where every other money read resolves the kind through
 *    getTransactionKind and falls back to the SIGN when `type` is null. So a negative transaction
 *    with no stored type counts as an expense everywhere else and is invisible here.
 *
 * It attributes through `allocateByCategory` rather than through `allocationsOf`, and that is the
 * one place in the app where the two differ. It asks only WHERE THE MONEY WENT: it selects neither
 * the identity columns a Transaction needs nor the nature mappings, and it uses no nature. Going
 * through the full allocation would mean an extra query and inventing a Transaction to throw away.
 * The remainder rule is the same function in both paths, which is the property that matters.
 */
export async function readCurrentMonthSpending(userId: string): Promise<Map<string, number>> {
	const now = new Date();
	const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const firstOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

	// Batched, same reason as readDashboardDataForRange above: this select also spreads
	// EFFECTIVE_CATEGORY_SELECT. Order is irrelevant here — the result is only ever summed into a
	// Map — so the default direction is left unspecified.
	const transactions = await collectAllTransactions(
		{
			userId,
			type: 'expense',
			date: { gte: firstOfMonth, lt: firstOfNextMonth }
		},
		{
			amountCents: true,
			...EFFECTIVE_CATEGORY_SELECT
		}
	);

	const spending = new Map<string, number>();
	for (const tx of transactions) {
		const allocated = allocateByCategory(
			{ category: getEffectiveCategory(tx), amountCents: tx.amountCents },
			tx.splits.map((split) => ({
				category: split.category.name,
				amountCents: split.amountCents
			}))
		);
		for (const entry of allocated) {
			spending.set(
				entry.category,
				(spending.get(entry.category) ?? 0) + Math.abs(entry.amountCents)
			);
		}
	}
	return spending;
}
