/**
 * The structural bound on a restored backup, before `JSON.parse` runs: the fix for #276.
 *
 * WHY THE EXISTING GUARD PROTECTS NOTHING ON THIS PATH, which is the whole shape of the defect.
 * `backupExportSchema` is strict and genuinely good (30000 fuzzed payloads, 0 throws, 24725
 * refusals, unknown keys rejected at every level). It runs AFTER `JSON.parse`. #276 measured 20 MB
 * of `[{},{},...]` costing **801 MB of RSS** inside that parse, and the payload is then refused
 * microseconds later for the trivial reason that it has no `formatVersion`. Every byte of the cost
 * is paid before the first check runs, so the strength of the validator is not evidence about this
 * defect. **A guard that runs after the allocation that matters is not a guard for that allocation.**
 *
 * WHY THE BYTE CAP IS NOT THE THING TO LOWER, and this is the measurement that moved the fix off the
 * axis the issue names. At the same 20 MB:
 *
 *   - a LEGITIMATE export of 40,559 transactions costs 132 MB and parses in 97 ms;
 *   - `[{},{},...]` costs 801 MB and 830 ms.
 *
 * Bytes cannot separate those two, so lowering the cap charges every real user for an attack they
 * are not performing: at 2 MB the pathological payload still costs 173 MB, while a user with more
 * than about 4,000 transactions can no longer restore at all. What DOES separate them is structural
 * density, and by a factor of nineteen: **28.0 bytes per value against 1.5.** That is stable across
 * sizes (27.9, 27.9, 28.0, 28.0, 28.0 from 5,000 to 100,000 transactions), because a backup's record
 * shape is fixed.
 *
 * SO THE BOUND IS ON THE COUNT OF VALUES, measured by a linear scan before the parse. 28.5 ms over a
 * 20 MB payload, against the parse's own 97 ms.
 *
 * WHERE THE NUMBERS COME FROM. The floor the bound must clear is not a guess: **an export this
 * application produces cannot exceed 888,888 values at the 20 MB byte cap**, because every record
 * carries a 25-character cuid id, so the densest thing the exporter can emit is a category with a
 * one-character name at 22.5 bytes per value. A real full-size export measures 714,505. The
 * application must be able to restore anything it can export, so the bound sits above the arithmetic
 * ceiling rather than above the realistic figure.
 *
 * AND THE AXIS THAT BINDS IS MEMORY, checked rather than assumed, because the sibling limit in
 * `import/zipBounds.ts` binds on TIME and applying its rule here would have been wrong. Measured on
 * the pathological shape, which is the worst cost per value:
 *
 *   1,000,000 values ->  54 MB /  41 ms      2,000,000 -> 107 MB /  87 ms
 *   3,000,000 values -> 190 MB / 155 ms      4,000,000 -> 214 MB / 177 ms
 *   6,000,000 values -> 380 MB / 304 ms     13,333,329 -> 702 MB / 756 ms
 *
 * Even completely unbounded the parse blocks for 756 ms, inside the one-second line the xlsx ceiling
 * is set by. Time never binds here; memory does. Two limits that look like siblings, one method,
 * opposite axes, and nothing announces the difference in advance.
 *
 * WHAT THIS DOES NOT COVER, stated because a bound on structure is silent about content. A payload
 * of ONE enormous string has one value and passes untouched: 20 MB of string costs 20 MB and 8 ms,
 * 20 MB of escaped surrogate pairs costs 7 MB and 24 ms. Those are bounded by `BACKUP_MAX_BYTES`
 * alone and are cheap enough that this is a statement rather than a gap. The two bounds are
 * complementary: bytes bound string-shaped payloads, values bound structure-shaped ones.
 *
 * It is also per REQUEST. Nothing serialises restores (#283).
 */

/** How many separate JSON values a backup may contain. Measured, see above. */
export const BACKUP_DEFAULT_MAX_JSON_NODES = 2_000_000;

/**
 * The value above which a configured bound is REFUSED at boot rather than clamped.
 *
 * Same reasoning as `XLSX_MAX_UNCOMPRESSED_CEILING_MB`: a security limit an operator can raise is a
 * limit an operator can remove, and the way this one dies is not a decision to disable it but one
 * restore failing and someone raising the number until it stops. Refused rather than clamped so that
 * a bound you set is the bound that runs, since a clamp honours the limit while discarding the
 * intent and leaves the restore failing for a reason the operator's own configuration says should
 * not apply.
 *
 * 4,000,000 is where the worst case reaches 214 MB, the same memory line the CSV limit is proposed
 * against in #284. There IS a backstop behind this one, unlike the CSV case: `BACKUP_MAX_BYTES`
 * caps the input at 20 MB, so even with this bound removed entirely the ceiling is 702 MB rather
 * than unbounded. That is why the ceiling can be twice the default rather than equal to it.
 */
export const BACKUP_MAX_JSON_NODES_CEILING = 4_000_000;

/**
 * The most any export this application can produce at the 20 MB byte cap. Not a limit: the figure a
 * configured value is compared against, so that setting the bound below what the exporter can emit
 * is reported at boot rather than discovered as a restore that refuses a file the app itself wrote.
 */
export const LARGEST_EXPORTABLE_JSON_NODES = 888_888;

export const BACKUP_MAX_JSON_NODES_ENV = 'BACKUP_MAX_JSON_NODES';

/**
 * Counts the JSON values `text` will materialise, by counting the characters that can begin one.
 *
 * COUNTED OVER THE RAW BYTES, STRING CONTENTS INCLUDED, and that is deliberate rather than sloppy: a
 * comma inside a transaction label is counted as if it were a separator, so the figure can only ever
 * be an OVER-count. An over-count is the safe direction (it refuses slightly sooner), and it removes
 * the need for a string-aware scanner, which would be a second parser written by hand on the one
 * path where an attacker chooses the input. The 714,505 measured for a real full-size export already
 * includes that over-count, so the headroom is computed against the pessimistic figure.
 */
export function countJsonNodes(text: string): number {
	let count = 1;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		// `,` `{` `[`: every JSON value except the outermost is preceded by one of these.
		if (code === 44 || code === 123 || code === 91) count += 1;
	}
	return count;
}

/**
 * Reads the configured bound, or throws. Read per call rather than cached at import, matching
 * `SESSION_TTL_DAYS` and the xlsx bound. It THROWS on a bad value where `SESSION_TTL_DAYS` falls
 * back, because a fallback would mean the bound in force is not the bound the operator configured.
 */
export function resolveBackupMaxJsonNodes(): number {
	const raw = process.env[BACKUP_MAX_JSON_NODES_ENV];
	if (raw === undefined || raw.trim() === '') return BACKUP_DEFAULT_MAX_JSON_NODES;

	const nodes = Number(raw);
	if (!Number.isInteger(nodes) || nodes < 1) {
		throw new Error(
			`${BACKUP_MAX_JSON_NODES_ENV} must be a whole number of at least 1 (got ${JSON.stringify(raw)}). It bounds how many separate values a restored backup may contain. The default is ${BACKUP_DEFAULT_MAX_JSON_NODES}.`
		);
	}

	if (nodes > BACKUP_MAX_JSON_NODES_CEILING) {
		throw new Error(
			`${BACKUP_MAX_JSON_NODES_ENV}=${nodes} is above the hard ceiling of ${BACKUP_MAX_JSON_NODES_CEILING}. This is a denial-of-service limit (#276): a backup carrying ${BACKUP_MAX_JSON_NODES_CEILING} values already costs about 214 MB of memory to parse, and the cost is paid before any validation runs. The value is refused rather than clamped so that a bound you set is the bound that runs. The number and the measurements that chose it are in src/lib/server/backup/parseBounds.ts.`
		);
	}

	return nodes;
}

/**
 * Boot check, called from `hooks.server.ts`. Refuses to start on an out-of-range value, and reports
 * any departure from the default, in both directions.
 *
 * The lowered direction matters more here than it does for the xlsx bound, because below
 * `LARGEST_EXPORTABLE_JSON_NODES` the application refuses to restore files it produced itself, and
 * the user meets that as "my backup is corrupted" rather than as a configuration problem.
 */
export function assertBackupBoundConfigured(): void {
	const nodes = resolveBackupMaxJsonNodes();
	if (nodes === BACKUP_DEFAULT_MAX_JSON_NODES) return;

	console.warn(
		`[budgetpilot] ${BACKUP_MAX_JSON_NODES_ENV}=${nodes} differs from the default of ${BACKUP_DEFAULT_MAX_JSON_NODES}. It bounds how many separate values a restored backup may contain, and it exists so that one upload cannot exhaust this machine's memory before validation runs (#276).`
	);

	if (nodes > BACKUP_DEFAULT_MAX_JSON_NODES) {
		console.warn(
			`[budgetpilot] ${BACKUP_MAX_JSON_NODES_ENV} is RAISED above the default, so one restore may cost more memory than this instance was measured for. At the ${BACKUP_MAX_JSON_NODES_CEILING} ceiling the measured cost is about 214 MB per restore, against 107 MB at the default.`
		);
	} else if (nodes < LARGEST_EXPORTABLE_JSON_NODES) {
		console.warn(
			`[budgetpilot] ${BACKUP_MAX_JSON_NODES_ENV} is LOWERED below ${LARGEST_EXPORTABLE_JSON_NODES}, the most this application can itself export at the ${20_000_000} byte upload cap. Backups produced by this instance may now be refused on restore, and the user is told the file is corrupted rather than that a limit was lowered.`
		);
	}
}
