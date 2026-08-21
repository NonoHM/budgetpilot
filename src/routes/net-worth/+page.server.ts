import { userFacingErrorMessage } from '$lib/server/errors';
import { fail, isHttpError, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { isLinkableNetWorthAccountType, isNetWorthAccountType } from '$lib/domain/netWorth';
import { isSavingsGoalLinkableAccountType } from '$lib/domain/savingsGoal';
import { money, toInputValue } from '$lib/domain/money';
import { getLocale } from '$lib/paraglide/runtime';
import {
	createNetWorthAccount,
	deleteNetWorthAccount,
	getManualAccountNetWorthLink,
	readNetWorthAccounts,
	readNetWorthSeries,
	setManualAccountNetWorthLink,
	updateNetWorthAccount
} from '$lib/server/net-worth/service';
import {
	createSavingsGoal,
	deleteSavingsGoal,
	dismissReachedBanner,
	readSavingsGoalHistory,
	readSavingsGoals,
	updateSavingsGoal
} from '$lib/server/savings-goals/service';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	const [accounts, series, manualAccountNetWorthAccountId, savingsGoals] = await Promise.all([
		readNetWorthAccounts(user.id),
		readNetWorthSeries(user.id),
		getManualAccountNetWorthLink(user.id),
		readSavingsGoals(user.id)
	]);

	const savingsGoalsWithHistory = await Promise.all(
		savingsGoals.map(async (goal) => ({
			...goal,
			// linkStale still means the goal HAD a link (just now stale/removed): the
			// NetWorthSnapshot history for that account is preserved regardless (same
			// principle as NetWorthAccount's own soft-delete keeping its snapshots alive on
			// the timeline), so it must not disappear from the detail view.
			history:
				goal.linkedAccount || goal.linkStale ? await readSavingsGoalHistory(user.id, goal.id) : []
		}))
	);

	return {
		accounts: accounts.map((account) => ({
			...account,
			balanceEuros: formatBalanceInput(account)
		})),
		series,
		manualAccountNetWorthAccountId,
		savingsGoals: savingsGoalsWithHistory,
		// Excludes 'debt' even though isLinkableNetWorthAccountType() allows it for the (unrelated)
		// Account-linking toggle above — see isSavingsGoalLinkableAccountType()'s doc comment. The
		// user must never be offered an account in this Combobox that the server would reject.
		linkableAccounts: accounts.filter((account) => isSavingsGoalLinkableAccountType(account.type))
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const type = getFormValue(formData, 'type');
		const connectToTransactions = shouldConnectToTransactions(formData, type);

		try {
			const created = await createNetWorthAccount(user.id, {
				name: getFormValue(formData, 'name'),
				type,
				balance: getFormValue(formData, 'balance'),
				asOfDate: getFormValue(formData, 'asOfDate') || undefined
			});
			if (connectToTransactions) {
				await setManualAccountNetWorthLink(user.id, created.id);
			}
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: m.net_worth_success_created() };
	},
	update: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const accountId = getFormValue(formData, 'id');
		const type = getFormValue(formData, 'type');
		const connectToTransactions = shouldConnectToTransactions(formData, type);

		try {
			await updateNetWorthAccount(user.id, accountId, {
				name: getFormValue(formData, 'name'),
				type,
				balance: getFormValue(formData, 'balance'),
				asOfDate: getFormValue(formData, 'asOfDate') || undefined
			});

			const currentLink = await getManualAccountNetWorthLink(user.id);
			if (connectToTransactions) {
				await setManualAccountNetWorthLink(user.id, accountId);
			} else if (currentLink === accountId) {
				await setManualAccountNetWorthLink(user.id, null);
			}
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: m.net_worth_success_updated() };
	},
	delete: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		try {
			await deleteNetWorthAccount(user.id, getFormValue(formData, 'id'));
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: m.net_worth_success_deleted() };
	},
	createSavingsGoal: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		try {
			await createSavingsGoal(user.id, {
				name: getFormValue(formData, 'name'),
				targetAmount: getFormValue(formData, 'targetAmount'),
				trackingMode: getFormValue(formData, 'trackingMode'),
				netWorthAccountId: getFormValue(formData, 'netWorthAccountId') || undefined,
				currentAmount: getFormValue(formData, 'currentAmount') || undefined,
				targetDate: getFormValue(formData, 'targetDate') || undefined
			});
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: m.savings_goal_success_created() };
	},
	updateSavingsGoal: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		try {
			await updateSavingsGoal(user.id, getFormValue(formData, 'id'), {
				name: getFormValue(formData, 'name'),
				targetAmount: getFormValue(formData, 'targetAmount'),
				trackingMode: getFormValue(formData, 'trackingMode'),
				netWorthAccountId: getFormValue(formData, 'netWorthAccountId') || undefined,
				currentAmount: getFormValue(formData, 'currentAmount') || undefined,
				targetDate: getFormValue(formData, 'targetDate') || undefined
			});
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: m.savings_goal_success_updated() };
	},
	deleteSavingsGoal: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		try {
			await deleteSavingsGoal(user.id, getFormValue(formData, 'id'));
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: m.savings_goal_success_deleted() };
	},
	dismissSavingsGoalReachedBanner: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();

		try {
			await dismissReachedBanner(user.id, getFormValue(formData, 'id'));
		} catch (caught) {
			return fail(getErrorStatus(caught), { error: getErrorMessage(caught) });
		}

		return { success: true };
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

/**
 * The client only shows the toggle for linkable types (see LINKABLE_NET_WORTH_ACCOUNT_TYPES),
 * but a forged submission could still send `connectToTransactions=true` alongside a
 * non-linkable type (real_estate, other) — re-validated server-side rather than trusted.
 */
function shouldConnectToTransactions(formData: FormData, type: string): boolean {
	if (getFormValue(formData, 'connectToTransactions') !== 'true') return false;
	return isNetWorthAccountType(type) && isLinkableNetWorthAccountType(type);
}

function getErrorMessage(caught: unknown): string {
	// See the note in budgets/+page.server.ts: this was the same hardcoded French literal.
	return userFacingErrorMessage(caught, m.net_worth_error_generic());
}

function getErrorStatus(caught: unknown): number {
	return isHttpError(caught) ? caught.status : 400;
}

/**
 * The account's own denomination, not the application default.
 *
 * The one-line change the design note promised: `money(balanceCents)` used to take the default
 * currency and the default exponent, so a non-euro account rendered with euro decimals. It now
 * reads the row, which is what storing the pair was for. `toInputValue` takes its fraction digits
 * from the EXPONENT rather than from locale data, deliberately, so an account stored at exponent 2
 * shows two decimals even for a code CLDR renders with none. See docs/audits/
 * 2026-08-21-stored-forms-design.md, Part B, for the fifteen codes where the two disagree.
 */
function formatBalanceInput(account: {
	balanceCents: number;
	currency: string;
	exponent: number;
}): string {
	return toInputValue(money(account.balanceCents, account.currency, account.exponent), getLocale());
}
