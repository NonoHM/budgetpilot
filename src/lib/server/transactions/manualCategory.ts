import type { CategorySetBy } from '$lib/domain/categorySetBy';
import { computeNullableNameKey } from '../naming/nameKey';

/**
 * The Prisma `data` fragment for pinning (or clearing) a transaction's manual category.
 *
 * `Transaction.manualCategory` and `Transaction.manualCategoryKey` must always be written
 * together: the key column is what every query matches on, so a write that sets the name alone
 * leaves the transaction invisible to its own category. That is easy to get wrong, since the
 * name is the field that reads as "the value" at a call site, so the pair is expressed once here
 * and no write path spells it out itself.
 *
 * Who set the pin travels with it (#1013), as a REQUIRED argument so the compiler names every
 * writer: `null` only where the author is not known (a restored file that does not say). The
 * source is stamped with the key it was written for; `categorySetBy` reads it, and clearing the
 * pin clears both.
 */
export function manualCategoryUpdate(
	value: string | null,
	source: CategorySetBy | null
): {
	manualCategory: string | null;
	manualCategoryKey: string | null;
	manualCategorySource: CategorySetBy | null;
	manualCategorySourceKey: string | null;
} {
	const key = computeNullableNameKey(value);
	const stamped = key === null ? null : source;
	return {
		manualCategory: value,
		manualCategoryKey: key,
		manualCategorySource: stamped,
		manualCategorySourceKey: stamped === null ? null : key
	};
}
