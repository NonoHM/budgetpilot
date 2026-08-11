import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import {
	applyCategoryRules,
	parseCategoryRuleInput,
	previewCategoryRules
} from '$lib/server/categorization/rules';
import { restoreMissingDefaultRules } from '$lib/server/categorization/defaultRules';
import { isRuleTargetLive, toCategoryNameKeys } from '$lib/server/categories/references';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { normalizeId } from '$lib/server/transactions/where';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const [rules, categories, preview] = await Promise.all([
		prisma.categoryRule.findMany({
			where: { userId: user.id },
			orderBy: { createdAt: 'desc' },
			select: {
				id: true,
				name: true,
				matchText: true,
				targetCategory: true,
				targetNature: true,
				isRegex: true,
				enabled: true,
				defaultRuleKey: true,
				createdAt: true,
				updatedAt: true
			}
		}),
		prisma.category.findMany({
			where: { userId: user.id },
			select: { name: true }
		}),
		url.searchParams.get('preview') === '1' ? previewCategoryRules(user.id) : Promise.resolve(null)
	]);

	// #161: a rule whose target no longer resolves to one of the user's categories is PAUSED. It
	// keeps its row and its pattern and does not fire, and this is where the user finds out.
	//
	// Derived here rather than read from a column, for the reasons `references.ts` sets out: the
	// verdict is recomputed on every render, so recreating a category resumes its rules and no
	// stored sentence can outlive the fact it describes. Free, because `categories` is loaded above
	// anyway to populate the target picker.
	//
	// Sent as a resolved boolean rather than left to the component: the fold is `computeNameKey`,
	// a server concern that has to agree with `renameCategoryReferences`, and a page that
	// re-derived it from `categories` in the browser would be the retyped-oracle shape.
	const categoryNameKeys = toCategoryNameKeys(categories);

	return {
		rules: rules.map((rule) => ({
			...rule,
			paused: !isRuleTargetLive(rule.targetCategory, categoryNameKeys),
			createdAt: rule.createdAt.toISOString(),
			updatedAt: rule.updatedAt.toISOString()
		})),
		categories,
		natureOptions: TRANSACTION_NATURES,
		preview
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const parsed = parseCategoryRuleInput({
			name: getFormValue(formData, 'name'),
			matchText: getFormValue(formData, 'matchText'),
			targetCategory: getFormValue(formData, 'targetCategory'),
			targetNature: getFormValue(formData, 'targetNature'),
			enabled: getFormValue(formData, 'enabled') !== 'off',
			isRegex: getFormValue(formData, 'isRegex') === 'true'
		});

		if (!parsed.ok) return fail(400, { error: parsed.error });

		await prisma.categoryRule.create({
			data: {
				userId: user.id,
				...parsed.value
			}
		});

		return { success: m.rules_success_created() };
	},
	toggle: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));
		const enabled = getFormValue(formData, 'enabled') === 'true';
		if (!id) return fail(400, { error: m.rules_error_invalid() });

		const result = await prisma.categoryRule.updateMany({
			where: { id, userId: user.id },
			data: { enabled }
		});
		if (result.count === 0) return fail(404, { error: m.rules_error_not_found() });

		return { success: enabled ? m.rules_success_enabled() : m.rules_success_disabled() };
	},
	delete: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));
		if (!id) return fail(400, { error: m.rules_error_invalid() });

		const result = await prisma.categoryRule.deleteMany({
			where: { id, userId: user.id }
		});
		if (result.count === 0) return fail(404, { error: m.rules_error_not_found() });

		return { success: m.rules_success_deleted() };
	},
	update: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));
		if (!id) return fail(400, { error: m.rules_error_invalid() });

		const parsed = parseCategoryRuleInput({
			name: getFormValue(formData, 'name'),
			matchText: getFormValue(formData, 'matchText'),
			targetCategory: getFormValue(formData, 'targetCategory'),
			targetNature: getFormValue(formData, 'targetNature'),
			enabled: true,
			isRegex: getFormValue(formData, 'isRegex') === 'true'
		});

		if (!parsed.ok) return fail(400, { error: parsed.error });

		const result = await prisma.categoryRule.updateMany({
			where: { id, userId: user.id },
			data: {
				name: parsed.value.name,
				matchText: parsed.value.matchText,
				targetCategory: parsed.value.targetCategory,
				targetNature: parsed.value.targetNature,
				isRegex: parsed.value.isRegex,
				// Editing a predefined rule freezes it as a custom rule (same logic as
				// renaming a category): never re-seeded or overwritten by "Restore" again.
				defaultRuleKey: null
			}
		});
		if (result.count === 0) return fail(404, { error: m.rules_error_not_found() });

		return { success: m.rules_success_updated() };
	},
	apply: async ({ locals }) => {
		const user = requireUser(locals.user);
		const updated = await applyCategoryRules(user.id);

		return { success: m.rules_success_applied({ count: updated }) };
	},
	restoreDefaults: async ({ locals }) => {
		const user = requireUser(locals.user);
		const created = await restoreMissingDefaultRules(user.id);
		return {
			success:
				created > 0
					? m.rules_success_defaults_restored({ count: created })
					: m.rules_success_defaults_all_present()
		};
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}
