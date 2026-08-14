/**
 * Counts how many times each collision group has already been seen, in source order.
 *
 * ## What it is for
 *
 * Two genuinely distinct transactions can share a date, a label, an amount and a direction: two
 * coffees at the same price on the same day at the same merchant is ordinary, and so is a
 * transport fare taken twice. Without something to tell them apart, a deduplication key built
 * from those four fields merges them, and the second is dropped with nothing to report it.
 * Measured on the five profiles before this existed: a file carrying one row twice reported
 * `validRows: 1, duplicateRows: 1` on every profile that accepted it.
 *
 * **A silently dropped transaction is the worse failure direction**, because a duplicate is
 * visible on the screen and a missing row is not.
 *
 * ## Why a counter rather than a function over the whole list
 *
 * Every caller streams: the five CSV profiles walk rows in order and validate each one as they
 * go, and both bank connectors build transactions in a loop. None of them holds the finished list
 * before it needs the key, so an array-shaped helper would have forced a two-pass rewrite at
 * seven call sites, or worse, a placeholder identity at validation time that a later pass
 * overwrites. The counter fits the code that exists.
 *
 * ## Why the group and not the file
 *
 * Scoping the ordinal to the collision group is what survives overlapping statements. Import
 * January, then January-to-February: each January group's membership is unchanged, so its
 * ordinals hold and those rows deduplicate against the first import. A file-wide ordinal would
 * shift every row after the first new one, and the whole overlap would import again as new
 * transactions.
 *
 * ## The cost, stated rather than discovered
 *
 * A bank that reorders rows within one day can shift an ordinal and produce one duplicate. That
 * is the VISIBLE direction, chosen deliberately over the invisible one above.
 *
 * ## One counter per source, never shared
 *
 * A counter is per file, or per provider fetch. Sharing one across two files would number the
 * second file's rows as continuations of the first, so the same statement uploaded twice would
 * key differently the second time and import again. Create it where the source is created.
 */
export function createOccurrenceCounter(): (groupKey: string) => number {
	const seenPerGroup = new Map<string, number>();

	return (groupKey: string) => {
		const seen = seenPerGroup.get(groupKey) ?? 0;
		seenPerGroup.set(groupKey, seen + 1);
		return seen;
	};
}
