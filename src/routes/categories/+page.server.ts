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
import type { PageServerLoad } from './$types';

export type CategoryRow = {
	id: string;
	name: string;
	defaultKey: string | null;
	transactionCount: number;
	nature: TransactionNature | null;
	mappingId: string | null;
};

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);

	const [categories, mappings] = await Promise.all([
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
		readCategoryNatureMappings(user.id)
	]);

	const mappingByName = new Map(mappings.map((m) => [m.categoryName, m]));

	const categoryRows: CategoryRow[] = categories.map((cat) => {
		const mapping = mappingByName.get(cat.name) ?? null;
		return {
			id: cat.id,
			name: cat.name,
			defaultKey: cat.defaultKey,
			transactionCount: cat._count.transactions,
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
		if (name === UNCLASSIFIED_CATEGORY)
			return fail(400, { error: m.categories_error_reserved_name() });

		// Folded pre-check, kept for the message rather than for the guarantee: the unique
		// constraint on (userId, nameKey) already refuses "courses" next to an existing
		// "Courses". Asking first turns that into "this category already exists" instead of a
		// P2002 the user never asked about. The constraint is what makes it true; this is what
		// makes it readable.
		const clash = await prisma.category.findFirst({
			where: { userId: user.id, nameKey: computeNameKey(name) },
			select: { id: true }
		});
		if (clash) return fail(400, { error: m.categories_error_duplicate() });

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
		if (newName === UNCLASSIFIED_CATEGORY)
			return fail(400, { error: m.categories_error_reserved_name() });

		const cat = await prisma.category.findFirst({ where: { id, userId: user.id } });
		if (!cat) return fail(404, { error: m.categories_error_not_found() });
		if (cat.name === UNCLASSIFIED_CATEGORY) {
			return fail(400, { error: m.categories_error_rename_unclassified() });
		}

		const oldKey = computeNameKey(cat.name);
		const newKey = computeNameKey(newName);

		const clash = await prisma.category.findFirst({
			where: { userId: user.id, nameKey: newKey, id: { not: id } },
			select: { id: true }
		});
		if (clash) return fail(400, { error: m.categories_error_duplicate() });

		try {
			await prisma.$transaction([
				// Renaming freezes the name as free text: defaultKey is set to null, the category
				// will never be translated again — the user-typed text becomes authoritative.
				prisma.category.update({
					where: { id },
					data: { name: newName, nameKey: newKey, defaultKey: null }
				}),
				// Matched on the key so every spelling the user pinned follows the rename, not
				// just the one that happened to match the old name character for character.
				prisma.transaction.updateMany({
					where: { userId: user.id, manualCategoryKey: oldKey },
					data: manualCategoryUpdate(newName)
				}),
				prisma.categoryNatureMapping.updateMany({
					where: { userId: user.id, categoryNameKey: oldKey },
					data: { categoryName: newName, categoryNameKey: newKey }
				})
			]);
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
						: m.categories_error_delete_used_by_splits_one({ count: splitCount })
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
