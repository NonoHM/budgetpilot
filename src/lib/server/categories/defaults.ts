import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import type { TransactionNature } from '$lib/domain/transaction';
import type { DefaultCategoryKey } from '$lib/domain/categories';

/**
 * Default business categories + their analytical nature.
 * Distinct from bank operation types (stored in Transaction.bankOperationType).
 * The "to classify" pile (UNCLASSIFIED_CATEGORY) is NOT here: it's not a chosen category.
 *
 * `name` = canonical FR name stored in DB (de facto identifier: budgets, nature
 * mappings and rules reference categories by name). `key` = Category.defaultKey,
 * the only source of the displayed (translated) label as long as the category isn't renamed.
 */
export const DEFAULT_CATEGORIES: ReadonlyArray<{
	key: DefaultCategoryKey;
	name: string;
	nature: TransactionNature;
}> = [
	{ key: 'food', name: 'Alimentation', nature: 'spending' },
	{ key: 'dining', name: 'Restauration', nature: 'spending' },
	{ key: 'transport', name: 'Transport', nature: 'spending' },
	{ key: 'housing', name: 'Logement', nature: 'spending' },
	{ key: 'bills_energy', name: 'Factures & énergie', nature: 'spending' },
	{ key: 'health', name: 'Santé', nature: 'spending' },
	{ key: 'leisure', name: 'Loisirs', nature: 'spending' },
	{ key: 'subscriptions', name: 'Abonnements', nature: 'spending' },
	{ key: 'shopping', name: 'Shopping', nature: 'spending' },
	{ key: 'travel', name: 'Voyage', nature: 'spending' },
	{ key: 'income', name: 'Revenus', nature: 'income' },
	{ key: 'savings', name: 'Épargne', nature: 'transfer' },
	{ key: 'investment', name: 'Investissement', nature: 'investment' },
	{ key: 'other', name: 'Autres', nature: 'spending' }
];

/**
 * Seeds the default categories + nature mappings for a user, exactly once.
 *
 * Lock: an atomic claim on `User.defaultsSeededAt` (WHERE ... IS NULL) guarantees
 * only one call seeds, even under concurrent calls (simultaneous login + register).
 * Once the flag is set, it's a no-op — so a category deleted later never
 * reappears. We filter out names already present before `createMany` (SQLite doesn't
 * support `skipDuplicates`) so we don't hit unique constraints on
 * categories already created by older imports.
 *
 * Called at register (new accounts) and at login (existing accounts).
 */
export async function ensureDefaultCategoriesSeeded(userId: string): Promise<boolean> {
	const claim = await prisma.user.updateMany({
		where: { id: userId, defaultsSeededAt: null },
		data: { defaultsSeededAt: new Date() }
	});
	if (claim.count !== 1) return false;

	await createMissingDefaultCategories(userId);
	return true;
}

/**
 * Recreates the MISSING default categories (+ their nature mappings) for a user,
 * without depending on the `defaultsSeededAt` flag. Idempotent, doesn't touch categories already
 * present or transactions. Used by the "Restore default categories" button.
 */
export async function restoreMissingDefaultCategories(userId: string): Promise<number> {
	return createMissingDefaultCategories(userId);
}

async function createMissingDefaultCategories(userId: string): Promise<number> {
	const [existingCategories, existingMappings] = await Promise.all([
		prisma.category.findMany({ where: { userId }, select: { name: true } }),
		prisma.categoryNatureMapping.findMany({ where: { userId }, select: { categoryName: true } })
	]);
	// Compared on the folded name: restoring the defaults must not add a second "Loisirs"
	// to a user who already renamed one to "loisirs".
	const existingCategoryNames = new Set(existingCategories.map((c) => computeNameKey(c.name)));
	const existingMappingNames = new Set(existingMappings.map((m) => computeNameKey(m.categoryName)));

	const categoriesToCreate = DEFAULT_CATEGORIES.filter(
		({ name }) => !existingCategoryNames.has(computeNameKey(name))
	).map(({ name, key }) => ({ userId, name, nameKey: computeNameKey(name), defaultKey: key }));
	const mappingsToCreate = DEFAULT_CATEGORIES.filter(
		({ name }) => !existingMappingNames.has(computeNameKey(name))
	).map(({ name, nature }) => ({
		userId,
		categoryName: name,
		categoryNameKey: computeNameKey(name),
		nature
	}));

	if (categoriesToCreate.length > 0) {
		await prisma.category.createMany({ data: categoriesToCreate });
	}
	if (mappingsToCreate.length > 0) {
		await prisma.categoryNatureMapping.createMany({ data: mappingsToCreate });
	}

	return categoriesToCreate.length;
}
