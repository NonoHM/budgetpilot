import * as m from '$lib/paraglide/messages';
import type { NetWorthAccountType } from './netWorth';

const NET_WORTH_ACCOUNT_TYPE_LABELS: Record<NetWorthAccountType, () => string> = {
	checking: m.net_worth_type_checking,
	savings: m.net_worth_type_savings,
	investment: m.net_worth_type_investment,
	real_estate: m.net_worth_type_real_estate,
	other: m.net_worth_type_other,
	debt: m.net_worth_type_debt
};

/** Translated label for a net worth account type (fixed enum, never renamable by the user). */
export function netWorthAccountTypeLabel(type: NetWorthAccountType): string {
	return NET_WORTH_ACCOUNT_TYPE_LABELS[type]();
}
