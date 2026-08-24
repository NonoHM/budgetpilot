import { userFacingErrorMessage } from '$lib/server/errors';
import { fail, isHttpError, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { money, toInputValue } from '$lib/domain/money';
import { getLocale } from '$lib/paraglide/runtime';
import {
	deleteBudget,
	getCurrentMonth,
	readBudgetCategoryOptions,
	readCurrentMonthSpending,
	readMonthlyBudgets,
	saveBudget,
	spentCentsFor,
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
			select: { name: true }
		})
	]);

	return {
		budgets: budgets.map((budget) => ({
			...budget,
			amountEuros: formatBudgetInput(budget.amountCents),
			// Through `spentCentsFor`, never `spending.get(...)`: the map is keyed on the FOLDED
			// category name, and a raw lookup here is what made this page report 70,00 € against
			// the dashboard's 74,50 € for the same budget in the same month.
			spentCents: spentCentsFor(spending, budget.categoryName)
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
	// Was the literal 'Validation invalide', byte-identical to the catalogue's own
	// `budgets_error_generic` — so an English user was shown French on the one path that reached
	// it. Same class as the import layer's rendered French (#304), found by the same sweep.
	return userFacingErrorMessage(caught, m.budgets_error_generic());
}

function getErrorStatus(caught: unknown): number {
	return isHttpError(caught) ? caught.status : 400;
}

function formatBudgetInput(amountCents: number): string {
	return toInputValue(money(amountCents), getLocale());
}
