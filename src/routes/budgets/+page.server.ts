import { fail, isHttpError, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import {
	deleteBudget,
	getCurrentMonth,
	readBudgetCategoryOptions,
	readCurrentMonthSpending,
	readMonthlyBudgets,
	saveBudget,
	updateBudget
} from '$lib/server/budget/dashboard';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	const [budgets, categoryOptions, spending, categories] = await Promise.all([
		readMonthlyBudgets(user.id),
		readBudgetCategoryOptions(user.id),
		readCurrentMonthSpending(user.id),
		prisma.category.findMany({
			where: { userId: user.id },
			select: { name: true, defaultKey: true }
		})
	]);

	return {
		budgets: budgets.map((budget) => ({
			...budget,
			amountEuros: formatBudgetInput(budget.amountCents),
			spentCents: spending.get(budget.categoryName) ?? 0
		})),
		categoryOptions,
		categories,
		currentMonth: getCurrentMonth()
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		try {
			await saveBudget(user.id, {
				category: getFormValue(formData, 'category'),
				limit: getFormValue(formData, 'amount')
			});
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: m.budgets_success_created() };
	},
	update: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		try {
			await updateBudget(user.id, getFormValue(formData, 'id'), {
				category: getFormValue(formData, 'category'),
				limit: getFormValue(formData, 'amount')
			});
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: m.budgets_success_updated() };
	},
	delete: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		try {
			await deleteBudget(user.id, getFormValue(formData, 'id'));
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: m.budgets_success_deleted() };
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

function getErrorMessage(caught: unknown): string {
	if (isHttpError(caught)) return caught.body.message;
	return caught instanceof Error ? caught.message : 'Validation invalide';
}

function getErrorStatus(caught: unknown): number {
	return isHttpError(caught) ? caught.status : 400;
}

function formatBudgetInput(amountCents: number): string {
	return (amountCents / 100).toFixed(2).replace('.', ',');
}
