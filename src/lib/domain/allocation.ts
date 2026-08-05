import {
	getTransactionKind,
	type Transaction,
	type TransactionKind,
	type TransactionNature
} from './transaction';

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
