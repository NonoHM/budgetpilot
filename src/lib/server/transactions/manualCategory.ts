import { computeNullableNameKey } from '../naming/nameKey';

/**
 * The Prisma `data` fragment for pinning (or clearing) a transaction's manual category.
 *
 * `Transaction.manualCategory` and `Transaction.manualCategoryKey` must always be written
 * together: the key column is what every query matches on, so a write that sets the name alone
 * leaves the transaction invisible to its own category. That is easy to get wrong, since the
 * name is the field that reads as "the value" at a call site, so the pair is expressed once here
 * and no write path spells it out itself.
 */
export function manualCategoryUpdate(value: string | null): {
	manualCategory: string | null;
	manualCategoryKey: string | null;
} {
	return { manualCategory: value, manualCategoryKey: computeNullableNameKey(value) };
}
