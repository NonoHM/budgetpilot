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

/**
 * The natures worth badging on a row. `spending`/`income` are the default a category with no
 * mapping falls back to, so badging them would put a tag on nearly every row and say nothing;
 * `uncategorized` is an absence, not a fact about the money.
 */
const TAGGED_NATURES: ReadonlySet<TransactionNature> = new Set([
	'transfer',
	'investment',
	'refund',
	'fee'
]);

/**
 * Badge text for a row's nature, or `null` when the nature carries no distinction worth showing.
 *
 * Shared by the dashboard transaction list, the upcoming-bills widget and `/upcoming-bills` so the
 * same transaction cannot be tagged on one surface and untagged on another — the exact divergence
 * item C found between the transaction list (zinc-grey, "Transfert") and the bills total.
 */
export function getNatureTag(nature: TransactionNature | undefined | null): string | null {
	return nature && TAGGED_NATURES.has(nature) ? natureLabel(nature) : null;
}
