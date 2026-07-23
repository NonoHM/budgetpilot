import { prisma } from '$lib/server/db';
import {
	type Transaction,
	type TransactionKind,
	type TransactionNature,
	getTransactionKind,
	isTransactionNature
} from '$lib/domain/transaction';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { normalizeId } from '$lib/server/transactions/where';

const MAX_CATEGORY_NAME_LENGTH = 80;
const NATURE_DEFAULT_BY_KIND: Record<TransactionKind, TransactionNature> = {
	expense: 'spending',
	income: 'income'
};

export interface CategoryNatureMappingRecord {
	id: string;
	categoryName: string;
	nature: TransactionNature;
	createdAt: string;
	updatedAt: string;
}

export interface EffectiveTransactionNatureResult {
	nature: TransactionNature;
	source: 'manual' | 'category' | 'default';
}

export interface TransactionNatureAnalysis {
	incomeCents: number;
	spendingCents: number;
	investmentCents: number;
	transferCents: number;
	refundCents: number;
	feeCents: number;
	uncategorizedCents: number;
}

export function normalizeCategoryName(value: string): string {
	const normalized = value.trim().replace(/\s+/g, ' ');
	if (
		!normalized ||
		normalized.length > MAX_CATEGORY_NAME_LENGTH ||
		/[<>\p{Cc}]/u.test(normalized)
	) {
		return '';
	}

	return normalized;
}

export function parseTransactionNatureInput(value: string): TransactionNature | null {
	const normalized = value.trim();
	return isTransactionNature(normalized) ? normalized : null;
}

export function getEffectiveTransactionNature(
	transaction: Pick<Transaction, 'type' | 'amountCents' | 'nature'> & {
		natureManual?: TransactionNature | null;
		category: string;
	},
	mappings: Map<string, TransactionNature> | Record<string, TransactionNature> = new Map()
): EffectiveTransactionNatureResult {
	if (transaction.natureManual) {
		return { nature: transaction.natureManual, source: 'manual' };
	}

	const mappedNature =
		mappings instanceof Map ? mappings.get(transaction.category) : mappings[transaction.category];
	if (mappedNature) {
		return { nature: mappedNature, source: 'category' };
	}

	return {
		nature: getDefaultTransactionNature(transaction),
		source: 'default'
	};
}

// Effective category: manualCategory takes priority, then the linked category's name,
// then the system sentinel "Non catégorisé". See the convention documented in
// CLAUDE.md — distinct from nature (getEffectiveTransactionNature).
export function getEffectiveCategory(transaction: {
	manualCategory: string | null;
	category: { name: string } | null;
}): string {
	return transaction.manualCategory ?? transaction.category?.name ?? UNCLASSIFIED_CATEGORY;
}

// "To classify" pile: effective category === "Non catégorisé", NOT nature ===
// "uncategorized" (a deliberately chosen category leaves the pile regardless of its
// nature — see CLAUDE.md).
export function isUncategorizedByCategory(transaction: {
	manualCategory: string | null;
	category: { name: string } | null;
}): boolean {
	return getEffectiveCategory(transaction) === UNCLASSIFIED_CATEGORY;
}

export function buildCategoryNatureMap(
	mappings: Array<{ categoryName: string; nature: TransactionNature }>
): Map<string, TransactionNature> {
	return new Map(mappings.map((mapping) => [mapping.categoryName, mapping.nature]));
}

export async function readCategoryNatureMappings(
	userId: string
): Promise<CategoryNatureMappingRecord[]> {
	const mappings = await prisma.categoryNatureMapping.findMany({
		where: { userId },
		orderBy: { categoryName: 'asc' }
	});

	return mappings.map((mapping) => ({
		id: mapping.id,
		categoryName: mapping.categoryName,
		nature: mapping.nature,
		createdAt: mapping.createdAt.toISOString(),
		updatedAt: mapping.updatedAt.toISOString()
	}));
}

export async function saveCategoryNatureMapping(
	userId: string,
	input: { categoryName: string; nature: string }
): Promise<void> {
	const categoryName = normalizeCategoryName(input.categoryName);
	const nature = parseTransactionNatureInput(input.nature);
	if (!categoryName) throw new Error('Invalid category');
	if (!nature) throw new Error('Invalid nature');

	await prisma.categoryNatureMapping.upsert({
		where: {
			userId_categoryName: {
				userId,
				categoryName
			}
		},
		update: { nature },
		create: {
			userId,
			categoryName,
			nature
		}
	});
}

export async function deleteCategoryNatureMapping(
	userId: string,
	mappingId: string
): Promise<boolean> {
	const normalizedId = normalizeId(mappingId);
	if (!normalizedId) return false;

	const result = await prisma.categoryNatureMapping.deleteMany({
		where: { id: normalizedId, userId }
	});
	return result.count > 0;
}

export function analyzeTransactionNatures(transactions: Transaction[]): TransactionNatureAnalysis {
	return transactions.reduce<TransactionNatureAnalysis>(
		(summary, transaction) => {
			const nature = transaction.nature ?? getDefaultTransactionNature(transaction);
			const amount = Math.abs(transaction.amountCents);
			const kind = getTransactionKind(transaction);
			if (nature === 'income') summary.incomeCents += amount;
			if (nature === 'spending' && kind === 'expense') summary.spendingCents += amount;
			if (nature === 'investment' && kind === 'expense') summary.investmentCents += amount;
			if (nature === 'transfer' && kind === 'expense') summary.transferCents += amount;
			if (nature === 'refund') summary.refundCents += amount;
			if (nature === 'fee' && kind === 'expense') summary.feeCents += amount;
			if (nature === 'uncategorized' && kind === 'expense') summary.uncategorizedCents += amount;
			return summary;
		},
		{
			incomeCents: 0,
			spendingCents: 0,
			investmentCents: 0,
			transferCents: 0,
			refundCents: 0,
			feeCents: 0,
			uncategorizedCents: 0
		}
	);
}

// Pure SQL count: nature effective is 'uncategorized' only via natureManual === 'uncategorized'
// (manual override wins) OR, when natureManual is unset, via a CategoryNatureMapping targeting
// 'uncategorized' on the transaction's effective category (manualCategory ?? category.name) —
// getDefaultTransactionNature() never falls back to 'uncategorized', so no other path exists.
// Avoids loading every transaction into memory just to re-derive this in JS (see CLAUDE.md
// technical debt on unbounded scans).
export async function countUncategorizedTransactions(userId: string): Promise<number> {
	const uncategorizedMappings = await prisma.categoryNatureMapping.findMany({
		where: { userId, nature: 'uncategorized' },
		select: { categoryName: true }
	});
	const mappedNames = uncategorizedMappings.map((mapping) => mapping.categoryName);

	if (mappedNames.length === 0) {
		return prisma.transaction.count({ where: { userId, natureManual: 'uncategorized' } });
	}

	const mappedCategories = await prisma.category.findMany({
		where: { userId, name: { in: mappedNames } },
		select: { id: true }
	});
	const mappedCategoryIds = mappedCategories.map((category) => category.id);

	return prisma.transaction.count({
		where: {
			userId,
			OR: [
				{ natureManual: 'uncategorized' },
				{
					natureManual: null,
					OR: [
						{ manualCategory: { in: mappedNames } },
						{ manualCategory: null, categoryId: { in: mappedCategoryIds } }
					]
				}
			]
		}
	});
}

export function shouldCountTransactionInBudget(
	transaction: Pick<Transaction, 'type' | 'amountCents' | 'category' | 'nature'>,
	budgetCategories: Set<string>
): boolean {
	const kind = getTransactionKind(transaction);
	if (kind !== 'expense') return false;
	if (budgetCategories.has(transaction.category)) return true;

	const nature = transaction.nature ?? getDefaultTransactionNature(transaction);
	return nature === 'spending' || nature === 'fee';
}

function getDefaultTransactionNature(
	transaction: Pick<Transaction, 'type' | 'amountCents'>
): TransactionNature {
	const kind = getTransactionKind(transaction);
	return NATURE_DEFAULT_BY_KIND[kind];
}
