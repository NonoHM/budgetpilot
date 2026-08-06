import { prisma } from '$lib/server/db';
import {
	type Transaction,
	type TransactionKind,
	type TransactionNature,
	type TransactionSource,
	getTransactionKind,
	isTransactionNature
} from '$lib/domain/transaction';
import { allocationsOf, type CategoryAllocation } from '$lib/domain/allocation';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { normalizeId } from '$lib/server/transactions/where';
import { normalizeForMatch } from '$lib/domain/normalize';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { withConcurrentWriteRetry } from '$lib/server/database/upsert';

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

	// buildCategoryNatureMap keys on the folded name, so the lookup folds too: a mapping
	// saved on "Courses" applies to a transaction pinned to "courses".
	const lookup = normalizeForMatch(transaction.category);
	const mappedNature = mappings instanceof Map ? mappings.get(lookup) : mappings[lookup];
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

/**
 * Everything the three per-category money reads need to resolve WHERE THE MONEY WENT, as a Prisma
 * `select` fragment to spread.
 *
 * It exists so that readDashboardDataForRange, readCurrentMonthSpending and readTransactionsForRange
 * name these columns ONCE. Each used to spell them out, which was harmless while the answer was two
 * columns and stopped being harmless the moment it became three: a read that forgets one silently
 * resolves a different category for the same row than its siblings do, and nothing fails.
 *
 * `splits` is here rather than at each call site for exactly that reason. A boundary that selects
 * the category columns but forgets the parts would emit allocations that ignore every répartition
 * — every per-category figure it produced would be quietly attributed to the parent's category, on
 * one screen and not the others. Dropping any key from this fragment makes all three call sites
 * fail to typecheck, by name, which is the property that keeps them in agreement.
 *
 * Ordered by `position` because that order is user-visible: it decides which part carries the
 * rounding cent, and the list indicator breaks a dominant-part tie on it.
 *
 * DO NOT make `splits` optional downstream — no `splits?:` on TransactionRowForMapping, no
 * `?? []` in the mappers. That is the obvious suggestion when a new boundary or a test fixture
 * fails to compile, and it is precisely the failure this fragment exists to prevent: the default
 * is indistinguishable from a real unsplit row, so a boundary that forgot the parts would emit
 * allocations attributing every figure to the parent's category, agreeing with nothing and
 * failing nowhere. The compile error names the boundary; the fallback hides it. Adding the
 * columns to the caller is the fix, however many fixtures it touches.
 */
export const EFFECTIVE_CATEGORY_SELECT = {
	manualCategory: true,
	category: { select: { name: true } },
	splits: {
		select: { amountCents: true, position: true, category: { select: { name: true } } },
		orderBy: { position: 'asc' }
	}
} as const;

/** The row shape EFFECTIVE_CATEGORY_SELECT's `splits` key produces. */
export type SplitRow = { amountCents: number; position: number; category: { name: string } };

/** The columns the two mappers below read. A boundary spreading EFFECTIVE_CATEGORY_SELECT and the
 *  identity columns satisfies it; one that forgets a column does not compile. */
export interface TransactionRowForMapping {
	id: string;
	date: Date;
	label: string;
	amountCents: number;
	type: string | null;
	source: string;
	manualCategory: string | null;
	natureManual?: TransactionNature | null;
	category: { name: string } | null;
	splits: SplitRow[];
}

/**
 * One database row to one domain Transaction, with its nature resolved.
 *
 * The return type is NARROWER than `Transaction`, whose `nature` is optional: this mapper always
 * resolves one. Saying so is what lets `allocationsOf` — which requires a resolved nature — take the
 * result directly rather than being handed a `?? 'uncategorized'` fallback. That default is a real
 * nature a user can hold, so it would silently conflate "we do not know" with "the user chose that",
 * inside the one function whose whole job is bucketing money.
 *
 * `type` falls back to the SIGN when the column is null, matching getTransactionKind, which every
 * downstream consumer uses anyway.
 */
export function mapTransactionWithNature(
	transaction: Omit<TransactionRowForMapping, 'splits'>,
	mappingMap: Map<string, TransactionNature>
): Transaction & { nature: TransactionNature } {
	const category = getEffectiveCategory(transaction);
	const type =
		transaction.type === 'income' || transaction.type === 'expense'
			? transaction.type
			: transaction.amountCents >= 0
				? 'income'
				: 'expense';
	const effectiveNature = getEffectiveTransactionNature(
		{
			amountCents: transaction.amountCents,
			type,
			category,
			natureManual: transaction.natureManual ?? null
		},
		mappingMap
	);

	return {
		id: transaction.id,
		date: transaction.date.toISOString().slice(0, 10),
		label: transaction.label,
		amountCents: transaction.amountCents,
		type,
		category,
		source: transaction.source as TransactionSource,
		nature: effectiveNature.nature,
		natureSource: effectiveNature.source
	};
}

/**
 * One database row to its allocations — the ONLY supported way to read money out of a transaction.
 *
 * An unsplit row yields exactly one allocation carrying its whole amount, so no consumer needs a
 * special case and none can tell the two apart. That is the point: a site written against
 * allocations is correct for split and unsplit rows alike, and a site written against
 * `Transaction.amountCents` is a double-count the moment parts exist.
 *
 * NATURE RESOLVES PER PART (OD-4). Each part's nature comes from its OWN category through the same
 * getEffectiveTransactionNature every other read uses, so a purchase split into a spending part and
 * a transfer part finally reports as both. The parent's `natureManual` still overrides every part:
 * one manual override, no new UI, and it stays the single place a user can contradict the mapping.
 */
export function mapTransactionAllocations(
	transaction: TransactionRowForMapping,
	mappingMap: Map<string, TransactionNature>
): CategoryAllocation[] {
	const parent = mapTransactionWithNature(transaction, mappingMap);

	const parts = transaction.splits.map((split) => ({
		category: split.category.name,
		amountCents: split.amountCents,
		nature: getEffectiveTransactionNature(
			{
				amountCents: split.amountCents,
				type: parent.type,
				category: split.category.name,
				natureManual: transaction.natureManual ?? null
			},
			mappingMap
		).nature
	}));

	return allocationsOf(parent, parts);
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

/**
 * Keyed by the folded category name (see domain/normalize.ts), not the raw one, so nature
 * mappings match the same way categories are compared everywhere else.
 *
 * Two mappings folding to one name cannot coexist after the name-key backfill, so this
 * introduces no last-one-wins ambiguity.
 */
export function buildCategoryNatureMap(
	mappings: Array<{ categoryName: string; nature: TransactionNature }>
): Map<string, TransactionNature> {
	return new Map(
		mappings.map((mapping) => [normalizeForMatch(mapping.categoryName), mapping.nature])
	);
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

/**
 * Rejected input, as opposed to a write that failed.
 *
 * Its own type so a caller can tell the user "that nature is not valid" without also saying it
 * about a database error. Before the two were distinguishable, a `catch` around this function
 * blamed the user's input for anything that went wrong underneath.
 */
export class InvalidCategoryNatureInputError extends Error {}

export async function saveCategoryNatureMapping(
	userId: string,
	input: { categoryName: string; nature: string }
): Promise<void> {
	const categoryName = normalizeCategoryName(input.categoryName);
	const nature = parseTransactionNatureInput(input.nature);
	if (!categoryName) throw new InvalidCategoryNatureInputError('Invalid category');
	if (!nature) throw new InvalidCategoryNatureInputError('Invalid nature');

	const categoryNameKey = computeNameKey(categoryName);

	// One upsert on the folded key, not a read then a write: a mapping already stored under
	// "Courses" is the row a save on "courses" must update, and two concurrent saves must not
	// each insert their own row. `categoryName` is only written on creation, so an existing
	// mapping keeps the spelling it was created with.
	//
	// Retried, because the upsert is not itself atomic on every engine (server/database/upsert.ts):
	// on MySQL two concurrent saves of one folded category still both reached the insert.
	await withConcurrentWriteRetry(() =>
		prisma.categoryNatureMapping.upsert({
			where: { userId_categoryNameKey: { userId, categoryNameKey } },
			update: { nature },
			create: {
				userId,
				categoryName,
				categoryNameKey,
				nature
			}
		})
	);
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

/**
 * The per-nature buckets, over ALLOCATIONS rather than transactions.
 *
 * This is where OD-4 is paid for: a transaction split into a spending part and a transfer part
 * lands in two buckets, which is the whole point, and it is also the one aggregate whose figure a
 * conservation guard can no longer pin per transaction. Σ over all buckets still equals Σ over the
 * allocations, so the total is conserved; what moves is which bucket holds it.
 *
 * Takes CategoryAllocation, not Transaction, deliberately: an allocation carries a resolved `nature`
 * and a resolved `kind`, so neither has to be re-derived here, and passing a Transaction[] is a
 * compile error rather than a silent attribution of every part to the parent's nature.
 */
export function analyzeTransactionNatures(
	allocations: CategoryAllocation[]
): TransactionNatureAnalysis {
	return allocations.reduce<TransactionNatureAnalysis>(
		(summary, { nature, kind, amountCents }) => {
			const amount = Math.abs(amountCents);
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
		select: { categoryNameKey: true }
	});
	// Matched on the key columns rather than the names: a raw `name IN (...)` is decided by
	// the database's collation, which is exactly what the keys exist to avoid.
	const mappedKeys = uncategorizedMappings
		.map((mapping) => mapping.categoryNameKey)
		.filter((key): key is string => key !== null);

	if (mappedKeys.length === 0) {
		return prisma.transaction.count({ where: { userId, natureManual: 'uncategorized' } });
	}

	const mappedCategories = await prisma.category.findMany({
		where: { userId, nameKey: { in: mappedKeys } },
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
						{ manualCategoryKey: { in: mappedKeys } },
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
	if (budgetCategories.has(normalizeForMatch(transaction.category))) return true;

	const nature = transaction.nature ?? getDefaultTransactionNature(transaction);
	return nature === 'spending' || nature === 'fee';
}

function getDefaultTransactionNature(
	transaction: Pick<Transaction, 'type' | 'amountCents'>
): TransactionNature {
	const kind = getTransactionKind(transaction);
	return NATURE_DEFAULT_BY_KIND[kind];
}
