import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { restoreMissingDefaultCategories } from '$lib/server/categories/defaults';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import {
	readCategoryNatureMappings,
	saveCategoryNatureMapping,
	deleteCategoryNatureMapping
} from '$lib/server/transactions/nature';
import { normalizeId } from '$lib/server/transactions/where';
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

		try {
			await prisma.category.create({ data: { userId: user.id, name } });
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

		const oldName = cat.name;

		try {
			await prisma.$transaction([
				// Renaming freezes the name as free text: defaultKey is set to null, the category
				// will never be translated again — the user-typed text becomes authoritative.
				prisma.category.update({ where: { id }, data: { name: newName, defaultKey: null } }),
				prisma.transaction.updateMany({
					where: { userId: user.id, manualCategory: oldName },
					data: { manualCategory: newName }
				}),
				prisma.categoryNatureMapping.updateMany({
					where: { userId: user.id, categoryName: oldName },
					data: { categoryName: newName }
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

		const txCount = await prisma.transaction.count({ where: { categoryId: id, userId: user.id } });

		const fallback = await prisma.category.upsert({
			where: { userId_name: { userId: user.id, name: UNCLASSIFIED_CATEGORY } },
			create: { userId: user.id, name: UNCLASSIFIED_CATEGORY },
			update: {}
		});

		await prisma.$transaction([
			prisma.transaction.updateMany({
				where: { categoryId: id, userId: user.id },
				data: { categoryId: fallback.id }
			}),
			prisma.transaction.updateMany({
				where: { userId: user.id, manualCategory: cat.name },
				data: { manualCategory: null }
			}),
			prisma.categoryNatureMapping.deleteMany({
				where: { userId: user.id, categoryName: cat.name }
			}),
			prisma.monthlyBudget.deleteMany({
				where: { userId: user.id, categoryName: cat.name }
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

		const cat = await prisma.category.findFirst({ where: { userId: user.id, name: categoryName } });
		if (!cat) return fail(404, { error: m.categories_error_not_found() });

		if (!nature) {
			if (mappingId) {
				await deleteCategoryNatureMapping(user.id, mappingId);
			}
			return { success: m.categories_success_nature_reset() };
		}

		try {
			await saveCategoryNatureMapping(user.id, { categoryName, nature });
		} catch {
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
