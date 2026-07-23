import * as m from '$lib/paraglide/messages';
import type { TransactionNature } from './transaction';

const NATURE_LABELS: Record<TransactionNature, () => string> = {
	income: m.nature_income,
	spending: m.nature_spending,
	transfer: m.nature_transfer,
	investment: m.nature_investment,
	refund: m.nature_refund,
	fee: m.nature_fee,
	uncategorized: m.nature_uncategorized
};

/** Translated label for an analytical nature (the technical code stays stored as-is). */
export function natureLabel(nature: TransactionNature): string {
	return NATURE_LABELS[nature]();
}
