import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { restoreMissingDefaultCategories } from '$lib/server/categories/defaults';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import {
	readCategoryNatureMappings,
	InvalidCategoryNatureInputError,
	saveCategoryNatureMapping,
	deleteCategoryNatureMapping
} from '$lib/server/transactions/nature';
import { normalizeId } from '$lib/server/transactions/where';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { resolveCategoryByName } from '$lib/server/categories/resolve';
import { findCategoryByTypedName, isReservedCategoryName } from '$lib/server/categories/nameMatch';
import { renameCategoryReferences } from '$lib/server/categories/references';
import { categoryLabel } from '$lib/domain/categoryLabels';
import type { PageServerLoad } from './$types';

export type CategoryRow = {
	id: string;
	name: string;
	defaultKey: string | null;
	transactionCount: number;
	/**
	 * Rules that target this category and would be paused by deleting it (#161).
	 *
	 * Counted for the confirmation dialog, which has to state the consequence before the action
	 * rather than after: the query that finds them has to exist either way, and this is the only
	 * moment the user has the context to react.
	 */
	pausedRuleCount: number;
	nature: TransactionNature | null;
	mappingId: string | null;
};

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);

	const [categories, mappings, rules] = await Promise.all([
		prisma.category.findMany({
			where: { userId: user.id },
			orderBy: { name: 'asc' },
			select: {
				id: true,
				name: true,
				defaultKey: true,
				_count: { select: { transactions: true } }
			}
		}),
		readCategoryNatureMappings(user.id),
		// #161: the delete dialog states the consequence BEFORE the action, so it needs to know how
		// many rules each category would pause. Read once for the page and folded into a count per
		// key, rather than a query per category: the user is thinking about transactions when they
		// delete a category, not about a rule they wrote three months ago, and the dialog is the
		// only moment they hold both.
		//
		// `CategoryRule` only. The legacy `CategorizationRule` does not pause, because its target is
		// a name the import CREATES if it is absent rather than a reference to an existing row (run,
		// not read: see the import route's own tests), so it cannot dangle.
		prisma.categoryRule.findMany({
			where: { userId: user.id },
			select: { targetCategory: true }
		})
	]);

	const mappingByName = new Map(mappings.map((m) => [m.categoryName, m]));

	// Folded with `computeNameKey` and never compared as raw text: a rule stored as "loisirs"
	// belongs to the "Loisirs" being deleted, exactly as `renameCategoryReferences` treats it, and
	// a SQL equality here would answer differently on MariaDB than on SQLite and PostgreSQL.
	const ruleCountByKey = new Map<string, number>();
	for (const rule of rules) {
		const key = computeNameKey(rule.targetCategory);
		ruleCountByKey.set(key, (ruleCountByKey.get(key) ?? 0) + 1);
	}

	const categoryRows: CategoryRow[] = categories.map((cat) => {
		const mapping = mappingByName.get(cat.name) ?? null;
		return {
			id: cat.id,
			name: cat.name,
			defaultKey: cat.defaultKey,
			transactionCount: cat._count.transactions,
			pausedRuleCount: ruleCountByKey.get(computeNameKey(cat.name)) ?? 0,
			nature: mapping ? mapping.nature : null,
			mappingId: mapping ? mapping.id : null
		};
	});

	return { categories: categoryRows, natureOptions: TRANSACTION_NATURES };
};

export const actions: Actions = {
	createCategory: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const name = getFormValue(formData, 'name').trim().replace(/\s+/g, ' ');

		if (!name || name.length > 80) return fail(400, { error: m.categories_error_invalid_name() });
		if (isReservedCategoryName(name))
			return fail(400, { error: m.categories_error_reserved_name() });

		// Compared against every name the user can SEE, not only the ones stored — see
		// server/categories/nameMatch.ts for why those differ and what it cost. The unique
		// constraint on (userId, nameKey) still backs the stored half of this and is what makes
		// it true under a race; it cannot back the displayed half, because a locale-dependent
		// key has no business in a column.
		const clash = findCategoryByTypedName(name, await readCategoryNames(user.id));
		if (clash) return fail(400, { error: duplicateError(clash) });

		try {
			await prisma.category.create({
				data: { userId: user.id, name, nameKey: computeNameKey(name) }
			});
		} catch (err: unknown) {
			if (isPrismaUniqueError(err)) return fail(400, { error: m.categories_error_duplicate() });
			throw err;
		}

		return { success: m.categories_success_created() };
	},

	renameCategory: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));
		const newName = getFormValue(formData, 'newName').trim().replace(/\s+/g, ' ');

		if (!id) return fail(400, { error: m.categories_error_invalid() });
		if (!newName || newName.length > 80)
			return fail(400, { error: m.categories_error_invalid_name() });
		if (isReservedCategoryName(newName))
			return fail(400, { error: m.categories_error_reserved_name() });

		const cat = await prisma.category.findFirst({ where: { id, userId: user.id } });
		if (!cat) return fail(404, { error: m.categories_error_not_found() });
		if (cat.name === UNCLASSIFIED_CATEGORY) {
			return fail(400, { error: m.categories_error_rename_unclassified() });
		}

		const oldKey = computeNameKey(cat.name);
		const newKey = computeNameKey(newName);

		const others = (await readCategoryNames(user.id)).filter((other) => other.id !== id);
		const clash = findCategoryByTypedName(newName, others);
		if (clash) return fail(400, { error: duplicateError(clash) });

		try {
			await prisma.$transaction(async (tx) => {
				// Renaming freezes the name as free text: defaultKey is set to null, the category
				// will never be translated again — the user-typed text becomes authoritative.
				await tx.category.update({
					where: { id },
					data: { name: newName, nameKey: newKey, defaultKey: null }
				});
				// The category's name is a foreign key in five other columns; they all move here, in
				// this transaction. See categories/references.ts for which, and for the 0-cents
				// budget figure that a partial rename produced.
				await renameCategoryReferences(tx, { userId: user.id, oldKey, newName, newKey });
			});
		} catch (err: unknown) {
			if (isPrismaUniqueError(err)) return fail(400, { error: m.categories_error_duplicate() });
			throw err;
		}

		return { success: m.categories_success_renamed() };
	},

	deleteCategory: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));

		if (!id) return fail(400, { error: m.categories_error_invalid() });

		const cat = await prisma.category.findFirst({ where: { id, userId: user.id } });
		if (!cat) return fail(404, { error: m.categories_error_not_found() });
		if (cat.name === UNCLASSIFIED_CATEGORY) {
			return fail(400, { error: m.categories_error_delete_unclassified() });
		}

		// REFUSED, not repointed, and this is a deliberate departure from how the parent rows below
		// are handled. `TransactionSplit.categoryId` has no cascade from `Category` (deleting a
		// category must never delete money), so an untreated delete fails on the foreign key — but
		// the symmetrical repair, sending the parts to "Non catégorisé" as the transactions go, is
		// worse than the crash: a part may never carry the sentinel (replaceSplits refuses it on
		// input), and a répartie transaction is excluded from the "à classer" pile, so those cents
		// would end up uncategorised AND absent from the one screen that exists to find
		// uncategorised money. Refusing is reversible by the user; that state is not.
		const splitCount = await prisma.transactionSplit.count({
			// Scoped through the category's own owner: `id` is client-supplied, and this count decides
			// whether an action is refused, so an unscoped read would answer questions about another
			// account's data.
			where: { categoryId: id, category: { userId: user.id } }
		});
		if (splitCount > 0) {
			return fail(400, {
				// Explicit `_one`/`_many` selection, the convention this repo already uses (see
				// pluralTx in categories/+page.svelte): Paraglide compiles the two suffixes to two
				// separate functions rather than a pluralising one.
				error:
					splitCount > 1
						? m.categories_error_delete_used_by_splits_many({ count: splitCount })
						: m.categories_error_delete_used_by_splits_one({ count: splitCount }),
				// The refusal must be ACTIONABLE, not merely correct. A count alone tells the user
				// they are blocked without telling them where to look — the /upcoming-bills empty
				// state that recommended the one action which could not help. `?category=` now matches
				// a PART's category (OD-1, same PR), so this link resolves to exactly the
				// transactions the count is about. It ships with OD-1 rather than after it, because a
				// link that resolves to an empty list is worse than no link at all.
				// One field carrying both halves rather than two that can disagree — an href with no
				// label renders an empty link, and a label with no href renders nothing at all.
				errorLink: {
					href: `/transactions?category=${encodeURIComponent(cat.name)}`,
					label: m.categories_error_delete_used_by_splits_link()
				}
			});
		}

		const txCount = await prisma.transaction.count({ where: { categoryId: id, userId: user.id } });

		const fallback = await resolveCategoryByName(user.id, UNCLASSIFIED_CATEGORY);
		const deletedKey = computeNameKey(cat.name);

		await prisma.$transaction([
			prisma.transaction.updateMany({
				where: { categoryId: id, userId: user.id },
				data: { categoryId: fallback.id }
			}),
			// Keyed, like the rename above: a budget or a pin written as "courses" belongs to
			// the "Courses" being deleted and must not survive it.
			prisma.transaction.updateMany({
				where: { userId: user.id, manualCategoryKey: deletedKey },
				data: manualCategoryUpdate(null)
			}),
			prisma.categoryNatureMapping.deleteMany({
				where: { userId: user.id, categoryNameKey: deletedKey }
			}),
			prisma.monthlyBudget.deleteMany({
				where: { userId: user.id, categoryNameKey: deletedKey }
			}),
			prisma.category.delete({ where: { id } })
		]);

		return {
			success:
				txCount > 0
					? m.categories_success_deleted_moved({ count: txCount })
					: m.categories_success_deleted()
		};
	},

	updateNature: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const categoryName = getFormValue(formData, 'categoryName').trim();
		const nature = getFormValue(formData, 'nature').trim();
		const mappingId = getFormValue(formData, 'mappingId').trim();

		if (!categoryName) return fail(400, { error: m.categories_error_invalid() });

		const cat = await prisma.category.findFirst({
			where: { userId: user.id, nameKey: computeNameKey(categoryName) }
		});
		if (!cat) return fail(404, { error: m.categories_error_not_found() });

		if (!nature) {
			if (mappingId) {
				await deleteCategoryNatureMapping(user.id, mappingId);
			}
			return { success: m.categories_success_nature_reset() };
		}

		try {
			await saveCategoryNatureMapping(user.id, { categoryName, nature });
		} catch (err: unknown) {
			// Only the rejected-input case. Anything else is a failed write, and telling the user
			// their nature was invalid would send them rechecking a form that was fine.
			if (!(err instanceof InvalidCategoryNatureInputError)) throw err;
			return fail(400, { error: m.categories_error_invalid_nature() });
		}

		return { success: m.categories_success_nature_updated() };
	},

	restoreDefaults: async ({ locals }) => {
		const user = requireUser(locals.user);
		const created = await restoreMissingDefaultCategories(user.id);
		return {
			success:
				created > 0
					? m.categories_success_defaults_restored({ count: created })
					: m.categories_success_defaults_all_present()
		};
	}
};

type NamedCategory = { id: string; name: string; defaultKey: string | null };

/** The whole list, because a displayed label cannot be turned into a `where` clause. */
function readCategoryNames(userId: string): Promise<NamedCategory[]> {
	return prisma.category.findMany({
		where: { userId },
		select: { id: true, name: true, defaultKey: true }
	});
}

/**
 * Names the row the user can see, never the string in the column. Told "this name already
 * exists" while nothing on screen carries it, a user has no way to find what is blocking them —
 * which is exactly the state an English instance was in, where the blocking row reads
 * "Groceries" and is stored as "Alimentation".
 */
function duplicateError(clash: NamedCategory): string {
	return m.categories_error_duplicate_named({ name: categoryLabel(clash.name, clash.defaultKey) });
}

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

function isPrismaUniqueError(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: string }).code === 'P2002'
	);
}
