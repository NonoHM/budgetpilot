/**
 * Whether two import periods describe any of the same days.
 *
 * ## What this is for, and it is a data-loss guard rather than a tidiness rule
 *
 * A correction re-asks for the statement, and nothing proves the file handed back is the statement
 * being corrected. `correctionMatchesFile` compares the HEADER SHAPE, and two statements from one
 * bank have the same headers by construction, so June's file passes as a correction for July's
 * import. Measured in a browser on 2026-08-17: correcting a July import with June's file destroyed
 * July's transactions and replaced them with a second copy of June, and every existing guard
 * passed. The counts were equal, so the fewer-rows guard stayed silent.
 *
 * Two statements of the SAME month always overlap, however their dates are read, so a no-overlap
 * answer is structurally rare and means the user handed back a different statement.
 *
 * ## The same rule as the collision candidate query, deliberately restated
 *
 * `server/import/collision.ts` expresses overlap as a Prisma `where`
 * (`periodStart <= incoming.to AND periodEnd >= incoming.from`), which cannot be called from
 * anywhere else and cannot be unit tested on its boundary. This is that rule as a function. The
 * duplication is the lesser of the two available errors: the alternative is a second, differently
 * worded comparison written inline at the withhold site, which is how two parts of one flow start
 * disagreeing about the same days.
 *
 * ## Unknown is treated as OVERLAPPING, and the direction is argued rather than defaulted
 *
 * A batch with no recorded period holds no dated transaction, so there is nothing for the delete to
 * destroy and withholding would cost the user the thirteen-step tail to protect nothing. The
 * collision check makes the opposite choice for the same input — it excludes an undated candidate
 * rather than warning about it — and both are the same principle: **this mechanism only speaks when
 * it is certain**, and here speaking means refusing to delete.
 */
export interface ImportPeriod {
	/** An ISO date, either date-only (`2026-06-01`) or a full instant. Null when undated. */
	from: string | null;
	/** Inclusive. Null when undated. */
	to: string | null;
}

/**
 * Compared as date strings rather than as `Date` objects.
 *
 * ISO dates sort lexicographically, and the two sides of this comparison arrive in different
 * shapes: a batch's period comes back from Prisma as a `DateTime` serialised with a time part,
 * while a parsed run's is date-only. Taking ten characters puts both in one form without
 * constructing a `Date`, which is what a timezone can move a day backwards through.
 */
function day(value: string): string {
	return value.slice(0, 10);
}

/**
 * True when the two periods share at least one day, and true when either is unknown.
 *
 * Both bounds are INCLUSIVE, which is what makes a one-day statement overlap itself: the boundary
 * case is `a.to === b.from`, and that is one shared day rather than none.
 */
export function periodsOverlap(a: ImportPeriod, b: ImportPeriod): boolean {
	if (!a.from || !a.to || !b.from || !b.to) return true;
	return day(a.from) <= day(b.to) && day(b.from) <= day(a.to);
}
