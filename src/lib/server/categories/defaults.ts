import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { withConcurrentWriteRetry } from '$lib/server/database/upsert';
import type { TransactionNature } from '$lib/domain/transaction';
import type { DefaultCategoryKey } from '$lib/domain/categories';

/**
 * Default business categories + their analytical nature.
 * Distinct from bank operation types (stored in Transaction.bankOperationType).
 * The "to classify" pile (UNCLASSIFIED_CATEGORY) is NOT here: it's not a chosen category.
 *
 * `name` is the name, full stop: what is stored, what is displayed, what budgets, nature mappings
 * and rules reference. These fourteen are INITIAL SUGGESTIONS, not a protected class. The moment
 * they are seeded they are ordinary rows the user owns, renames and deletes like any other, and
 * nothing downstream can tell one of them from a category the user typed.
 *
 * `key` no longer decides how the row is displayed (#162 retired that). It survives for two jobs,
 * both of which are about these fourteen as a CATALOGUE rather than about any row in a database:
 * naming the nature each one ships with, and letting `/categories` offer to rename the seeded rows
 * into the reader's own language once.
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

	const missing = DEFAULT_CATEGORIES.filter(
		({ name }) => !existingCategoryNames.has(computeNameKey(name))
	);

	// One comparison, on the folded stored name, and that is now the whole test.
	//
	// There used to be a second one. A default could be absent under its stored name and yet
	// already on screen, because the fourteen were displayed through a translation: a user on an
	// English instance who deleted Groceries and made their own category of that name had one row
	// reading "Groceries", and recreating the default gave them two. Since #162 the stored name is
	// the displayed name, so "absent under its stored name" and "absent from the screen" are the
	// same statement and the shadowing check has nothing left to catch.
	//
	// `defaultKey` is NOT written. The column survives #162 as a tombstone (see prisma/schema.prisma)
	// and nothing reads it; writing it here would hand every newly seeded account the two-meaning
	// column the chantier exists to retire, one user at a time.
	const categoriesToCreate = missing.map(({ name }) => ({
		userId,
		name,
		nameKey: computeNameKey(name)
	}));
	// A mapping missing beside a category that exists is still restored, which is what resetting a
	// nature leaves behind.
	const mappingsToCreate = DEFAULT_CATEGORIES.filter(
		({ name }) => !existingMappingNames.has(computeNameKey(name))
	).map(({ name, nature }) => ({
		userId,
		categoryName: name,
		categoryNameKey: computeNameKey(name),
		nature
	}));

	// Upserted one by one rather than a single `createMany`, because the read above and these
	// writes are not one atomic step. `ensureDefaultCategoriesSeeded` is protected by its
	// `defaultsSeededAt` claim, but "Restore default categories" is a plain button: two clicks,
	// or two tabs, both compute the same missing set and both insert. That raced the unique
	// constraint into a 500 instead of doing nothing, which is the wrong answer for an action
	// whose whole contract is idempotence. `createMany({ skipDuplicates })` would say this in
	// one statement, but SQLite does not support it. Fourteen rows, on an explicit user action.
	//
	// The upsert alone is not enough, which is the whole point of this paragraph: `update: {}`
	// costs Prisma its atomic `INSERT ... ON CONFLICT`, leaving a select followed by an insert
	// that two clicks can still both reach. See server/database/upsert.ts.
	for (const data of categoriesToCreate) {
		await withConcurrentWriteRetry(() =>
			prisma.category.upsert({
				where: { userId_nameKey: { userId, nameKey: data.nameKey } },
				update: {},
				create: data
			})
		);
	}
	for (const data of mappingsToCreate) {
		await withConcurrentWriteRetry(() =>
			prisma.categoryNatureMapping.upsert({
				where: { userId_categoryNameKey: { userId, categoryNameKey: data.categoryNameKey } },
				update: {},
				create: data
			})
		);
	}

	// What was missing when we looked. A concurrent restore can make this overstate by the rows
	// it created first: a cosmetic difference in the "N categories restored" message, where the
	// alternative was failing the request outright.
	return categoriesToCreate.length;
}
