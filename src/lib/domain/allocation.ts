import {
	getTransactionKind,
	type Transaction,
	type TransactionKind,
	type TransactionNature
} from './transaction';

/**
 * Floor on the number of parts in a répartition.
 *
 * A one-part split is a category wearing a costume: added complexity, no benefit. Removing the
 * répartition entirely is a separate, explicit action, never the side effect of deleting parts
 * until one is left.
 */
export const MIN_SPLITS_PER_TRANSACTION = 2;

/**
 * Ceiling on the number of parts, enforced server-side independently of any UI.
 *
 * Well past any real receipt, low enough to bound a forged request. It lives in domain/ rather
 * than in the write path because the backup validator needs it too — the payload bound is
 * `transactions.length * MAX_SPLITS_PER_TRANSACTION`, which is a claim about every write path
 * rather than about one function. Same placement, and the same reasoning, as
 * MAX_TAGS_PER_TRANSACTION in domain/tags.ts.
 */
export const MAX_SPLITS_PER_TRANSACTION = 20;

/**
 * Write-path cap on a part's free-text note.
 *
 * Deliberately tighter than the backup schema's MAX_PORTABLE_STRING (191): this bounds what THIS
 * version produces, while the backup bound must still accept what an older version legally wrote.
 * The same split the Account.providerAccountId note records.
 */
export const MAX_SPLIT_NOTE_LENGTH = 80;

/**
 * One (category, amount) pair resolved from a transaction. NOT a Transaction, and the distinction
 * is the entire protection: an allocation has no identity, cannot be counted as an occurrence,
 * cannot anchor a recurring stream, and must never be a grouping key for anything but its own
 * category. `transactionId` is for drill-down and de-duplication only.
 */
export interface CategoryAllocation {
	transactionId: string;
	date: string;
	category: string;
	amountCents: number;
	nature: TransactionNature;
	kind: TransactionKind;
}

/**
 * allocations(t) = t.parts ++ [ { category: t.category, amountCents: t.amountCents − Σ parts } ]
 *                  with the trailing element dropped when its amount is 0.
 *
 * Total by construction, which is why there is no special case anywhere downstream:
 *  - unsplit         → one allocation, the whole amount, under the parent's category;
 *  - correctly split → remainder 0 → exactly the parts;
 *  - amount moved out from under the parts → the parts PLUS the difference.
 * Therefore Σ allocations ≡ Σ transaction totals. Conservation is a theorem, not a hope, which is
 * what makes it safe to keep the anti-double-count guard switched on — a guard that fires on good
 * data gets switched off.
 *
 * A part's `nature` falls back to the transaction's nature when not supplied. The remainder
 * element always carries the transaction's own category and nature.
 *
 * TWO EDGE CASES THE ONE-LINE DEFINITION ABOVE DOES NOT COVER, both deliberate:
 *
 *  - An UNSPLIT transaction always yields exactly one allocation, even when its amount is 0.
 *    Read literally, "drop the trailing element when its amount is 0" would return [] for a
 *    zero-amount transaction and the anti-double-count guard's second assertion — every
 *    transaction covered exactly once — would fail on legitimate data. The drop applies only
 *    when there is something left to return.
 *
 *  - `nature` is REQUIRED on the input, not optional as it is on the domain Transaction. Both
 *    read boundaries already resolve it through getEffectiveTransactionNature before building a
 *    Transaction, so this costs nothing today and makes "a boundary forgot to resolve nature" a
 *    compile error. Defaulting instead would have to pick a value, and every available value is
 *    a lie: 'uncategorized' is a real nature the user can hold, so it would silently conflate
 *    "we do not know" with "the user classified it that way" — in a function whose whole job is
 *    to bucket money.
 */
export function allocationsOf(
	transaction: Transaction & { nature: TransactionNature },
	parts?: ReadonlyArray<{ category: string; amountCents: number; nature?: TransactionNature }>
): CategoryAllocation[] {
	const kind = getTransactionKind(transaction);
	const transactionNature = transaction.nature;

	const resolvedParts = (parts ?? []).map((part) => ({
		transactionId: transaction.id,
		date: transaction.date,
		category: part.category,
		amountCents: part.amountCents,
		nature: part.nature ?? transactionNature,
		kind
	}));

	const partsSum = resolvedParts.reduce((sum, part) => sum + part.amountCents, 0);
	const remainderCents = transaction.amountCents - partsSum;

	if (remainderCents === 0 && resolvedParts.length > 0) return resolvedParts;

	return [
		...resolvedParts,
		{
			transactionId: transaction.id,
			date: transaction.date,
			category: transaction.category,
			amountCents: remainderCents,
			nature: transactionNature,
			kind
		}
	];
}
