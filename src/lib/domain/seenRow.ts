import { isTransactionNature, type TransactionNature } from './transaction';

/**
 * A row as the page loaded it, the two fields a single accept writes: its pin and its manual
 * nature, raw as stored (#1231, #1233). The accept compares them in the same where as the write,
 * the optimistic form of a lost-update guard (Rails `lock_version` as a hidden form field), so a
 * row changed in another tab since is refused rather than overwritten. A claim from the client
 * that can only narrow that where, never widen it.
 */
export type SeenRow = { category: string | null; nature: TransactionNature | null };

/** A bound on the payload, not a rule about names: any stored pin is shorter. */
export const MAX_SEEN_CATEGORY_LENGTH = 1024;

export function seenRowOf(row: {
	manualCategory: string | null;
	manualNature: TransactionNature | null;
}): SeenRow {
	return { category: row.manualCategory, nature: row.manualNature };
}

export function encodeSeenRow(seen: SeenRow): string {
	return JSON.stringify({ category: seen.category, nature: seen.nature });
}

/**
 * Exactly the two keys. The category is taken byte for byte, empty included, because it is
 * compared with what is stored (a restore can store an empty pin) and is never written.
 */
export function parseSeenRow(raw: string): SeenRow | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 2) return null;
	const { category, nature } = record;
	const categoryOk =
		category === null ||
		(typeof category === 'string' && category.length <= MAX_SEEN_CATEGORY_LENGTH);
	const natureOk = nature === null || (typeof nature === 'string' && isTransactionNature(nature));
	if (!categoryOk || !natureOk) return null;
	return { category: category as string | null, nature: nature as TransactionNature | null };
}
