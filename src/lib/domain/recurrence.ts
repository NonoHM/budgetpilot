export function normalizeRecurringLabel(label: string): string {
	return label
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\b\d+\b/g, '')
		.replace(/[^a-z]+/g, ' ')
		.trim();
}

/**
 * Longest label a `RecurringStreamAction` row stores. Must equal `MAX_PORTABLE_STRING` in
 * `server/backup/schema.ts` (MySQL's `varchar(191)`), which a spec in the upcoming-bills service
 * asserts — it lives here rather than there because the DOMAIN matcher needs it too, and this
 * module may not import from `server/`.
 */
export const STORED_LABEL_MAX_CHARS = 191;

/**
 * The label exactly as the action write path stores it.
 *
 * Counts UTF-16 code units, not code points, even though MySQL's `varchar(191)` counts code
 * points: the backup validator bounds the same column with zod's `.max(191)`, which counts code
 * units, so a 191-code-point label of astral characters (`.length` 382) would be written happily
 * and then refused on the way back in — the "your own export is unrestorable" failure these caps
 * exist to prevent. The UTF-16 bound is the stricter of the two and satisfies both.
 *
 * The surrogate check is the reason this is a function rather than a `.slice`: cutting at 191
 * units can land in the middle of a pair and leave a lone high surrogate, i.e. a malformed string.
 * One character short is better.
 */
export function truncateStoredLabel(label: string): string {
	if (label.length <= STORED_LABEL_MAX_CHARS) return label;

	const sliced = label.slice(0, STORED_LABEL_MAX_CHARS);
	const lastUnit = sliced.charCodeAt(sliced.length - 1);
	const endsOnLoneHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
	return endsOnLoneHighSurrogate ? sliced.slice(0, -1) : sliced;
}

/**
 * The normalized form of a label as it is STORED — truncation first, then normalization.
 *
 * Both sides of the stream-identity fallback must call this. The write path stores
 * `normalizeRecurringLabel(truncated)`, so a matcher normalizing the FULL label produces a
 * different string for any label past the cap, and the user's decision silently stops applying to
 * their own stream the moment its anchors age out of the lookback window.
 */
export function normalizeStoredRecurringLabel(label: string): string {
	return normalizeRecurringLabel(truncateStoredLabel(label));
}

export function getAmountTolerance(amountCents: number): number {
	return Math.max(100, Math.round(amountCents * 0.05));
}

export function getSimilarAmountGroups<T extends { amountCents: number }>(
	transactions: T[]
): T[][] {
	const groups: T[][] = [];

	for (const transaction of [...transactions].sort(
		(left, right) => Math.abs(left.amountCents) - Math.abs(right.amountCents)
	)) {
		const amountCents = Math.abs(transaction.amountCents);
		const targetGroup = groups.find((group) => {
			const referenceAmount = Math.abs(group[0].amountCents);
			return Math.abs(referenceAmount - amountCents) <= getAmountTolerance(referenceAmount);
		});

		if (targetGroup) {
			targetGroup.push(transaction);
		} else {
			groups.push([transaction]);
		}
	}

	return groups;
}
