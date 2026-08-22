import { normalizeForMatch } from '$lib/domain/normalize';

/**
 * Rebuilding a transaction's deduplication key from the row itself.
 *
 * ## Why this exists, and why it is a module rather than a script
 *
 * Three callers need the same answer: the boot-time recompute that carries existing rows to a new
 * key version, the backup restore (a key written by another instance names an account that does
 * not exist here, so copying it verbatim leaves rows that deduplicate against nothing), and the
 * re-bucketing that #372 performs, which moves rows to a different `Account` and therefore changes
 * a key field. **The third caller has to be known while this is being written**: known in advance
 * it is one module with an entry point, discovered afterwards it is a script inside a migration
 * that a later chantier rewrites, and the rewrite is where two copies of the folding rule stop
 * agreeing.
 *
 * ## The one thing that made this possible, and it was not free
 *
 * The record said a backfill was impossible (`utils/safety.ts`, of the v1 to v2 change). It was
 * impossible FROM THE OLD KEY, whose embedded filename could not be separated out again. Nobody
 * asked whether the ROW was sufficient. It is, with one correction the design note did not carry:
 * the ordinal is not derived from a column, so the row is sufficient only once the ordinal is
 * assigned over the rows that are STORED rather than over the rows a parser reached.
 * MEASURED (`occurrenceGap.db-smoke.ts`): three identical rows whose middle one is refused after
 * its fingerprint is built store ordinals {0, 2}, and a dense recompute would renumber the
 * survivor. That is why key construction moved to the write path.
 *
 * ## Why two shapes, permanently
 *
 * A provider that supplies a stable per-account reference gets a key built from it; everything
 * else gets a content fingerprint. This is not a transitional state. Nothing in camt.053 is both
 * mandatory and identifying: the `Refs` block is `[0..1]` and every child of it is `[0..1]`, and
 * the two fields that state a uniqueness scope state it against a "pre-agreed period" rather than
 * an account. So no identifier can be depended on everywhere, and the fallback is structural.
 *
 * ## The delimiter, stated because it was previously true by luck
 *
 * Fields are joined with `|`, and a LABEL MAY CONTAIN ONE: `sanitizeImportedText` collapses
 * whitespace and neutralises a leading formula character, and never touches a pipe, so `SARL A|B`
 * is an ordinary merchant name. The join is unambiguous anyway, because the fields AFTER the label
 * are delimiter-free by their own grammar (a magnitude is digits, a type is `income` or `expense`,
 * an ordinal is digits, an account scope is empty or an identifier), so the boundaries are
 * recoverable from the right and the label absorbs whatever is left. **Any field added after the
 * label must keep that property.** The old field-count assertion could not see this: it split on
 * the delimiter and counted, which measures whether the fixture contains one.
 */

/** Everything the key needs, all of it readable from a stored row plus its account. */
export interface KeyableRow {
	/** Any stable per-row handle. Keys come back on the returned map under this value. */
	id: string;
	/** `Transaction.source`. Decides the fold, and nothing else. */
	source: string;
	/** `Account.id` the row lives on. Not yet in the key; the version bump puts it there. */
	accountId: string;
	/** ISO `YYYY-MM-DD`, which is the stored `DateTime` truncated. */
	date: string;
	/** The label AS STORED. The fold is applied here, never by the caller. */
	label: string;
	/** Signed or not: the magnitude is taken and the direction lives in `type`. */
	amountCents: number;
	type: 'income' | 'expense' | null;
	/** Not yet in the key; the version bump puts it there. */
	currency: string;
	/** Not yet in the key; the version bump puts it there. */
	exponent: number;
	/** `Account.providerAccountId`, null on every CSV bucket. */
	providerAccountId: string | null;
	/** The provider's per-account entry reference, from `metadataJson.reference`. */
	entryReference: string | null;
	/**
	 * Whether this row is keyed at all. False for a manually entered transaction, whose
	 * `dedupeKey` is NULL and must stay NULL.
	 */
	keyed: boolean;
}

/**
 * The label as the row's own source folded it before keying, and the asymmetry is real.
 *
 * `enablebanking.ts` feeds `normalizeForMatch(label)` into its group while STORING the raw label;
 * the five CSV profiles and the mock connector pass one variable to both. So the recompute has to
 * branch on `source`, and a fixture drawn from CSV alone measures an identity: on this property it
 * cannot fail. Measured: `Supérette Générale` folds to `superette generale` on the connector and
 * `supérette générale` everywhere else.
 *
 * `normalizeForMatch` is CALLED rather than reproduced. Retyping an accent table here would make
 * this function assert its own copy.
 */
export function foldLabelForSource(source: string, label: string): string {
	const normalized = source === 'enablebanking' ? normalizeForMatch(label) : label;
	return normalized.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The v2 account scope, reproduced exactly rather than tidied.
 *
 * `enablebanking.ts` passes `enablebanking:<providerAccountId>` and `mock.ts` passes the bare
 * `<providerAccountId>`, and `buildDeduplicationKey` then lowercases and collapses whatever it
 * received. Both asymmetries are faithfully reproduced here, because this phase exists so that
 * recomputing a stored key returns the key it replaces: tidying either one would re-key rows that
 * nothing asked to move. Both disappear at the version bump, which carries `Account.id` instead.
 */
function accountScopeOf(row: KeyableRow): string {
	if (!row.providerAccountId) return '';
	const scope =
		row.source === 'enablebanking'
			? `enablebanking:${row.providerAccountId}`
			: row.providerAccountId;
	return scope.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The group a row belongs to: everything its key carries except the ordinal.
 *
 * Returns null when the row is not keyed by content, which is a manual row (no fingerprint to
 * rebuild) or a row with no direction (nothing honest to put in the `type` field, so the key stays
 * NULL and the row is invisible to deduplication rather than wrongly matched).
 *
 * The ordinal is dense-numbered within THIS string, not within the four content fields alone. On
 * the bank path the counter is per provider fetch, so two accounts each holding one transaction
 * both numbered it 0, and numbering them 0 and 1 would not be a no-op.
 */
export function buildRowGroupKey(row: KeyableRow): string | null {
	const content = contentFieldsOf(row);
	return content === null ? null : `${content}|${accountScopeOf(row)}`;
}

/**
 * The four fields every source guarantees, joined. Null when the row cannot be keyed by content.
 *
 * Split out from `buildRowGroupKey` so the group and the final key are composed from ONE
 * expression rather than the key being recovered by re-splitting the group. Re-splitting would
 * work (the scope is delimiter-free, so a parse from the right is exact) and it would put a
 * delimiter assumption in a second place, which is where two copies of a rule stop agreeing.
 */
function contentFieldsOf(row: KeyableRow): string | null {
	if (!row.keyed || row.type === null) return null;
	return [
		row.date,
		foldLabelForSource(row.source, row.label),
		Math.abs(row.amountCents),
		row.type
	].join('|');
}

/**
 * The provider-reference key, or null when this row does not have one.
 *
 * Built from the row's OWN `source` rather than from a hardcoded provider name, which is what
 * makes it recomputable: the string a stored row must reproduce is the string its source produced.
 * The mock connector never reaches this branch because it emits no entry reference.
 */
export function buildProviderRowKey(row: KeyableRow): string | null {
	if (!row.keyed) return null;
	const reference = row.entryReference?.trim() ?? '';
	if (!row.providerAccountId || !reference) return null;
	return `${row.source}:${row.providerAccountId}:${reference}`;
}

/**
 * Every row's key, by id, with ordinals dense-numbered within each group in `rows` order.
 *
 * **The caller decides the order and gets a deterministic answer**, which is what makes a second
 * pass over an already-converged table write nothing.
 *
 * Dense numbering over a group's members is INJECTIVE, so two members cannot receive one key. That
 * is the whole collision argument, and it holds whatever key version each row arrived on. The
 * narrower argument (a v3 group is a v2 group plus a field, so groups only shrink) says nothing
 * about a v1 row, which has no ordinal at all, and v1 rows are most of what is stored on a real
 * install.
 */
export function assignDedupeKeys(rows: KeyableRow[]): Map<string, string | null> {
	const keys = new Map<string, string | null>();
	const seenPerGroup = new Map<string, number>();

	for (const row of rows) {
		const providerKey = buildProviderRowKey(row);
		if (providerKey) {
			keys.set(row.id, providerKey);
			continue;
		}

		const content = contentFieldsOf(row);
		if (content === null) {
			keys.set(row.id, null);
			continue;
		}

		// Numbered within the group, which is the key minus the ordinal. Under v2 the scope sits
		// AFTER the ordinal in the key and before it in the group, so the group is not a prefix
		// of the key here. The version bump moves the ordinal to the tail and makes it one, which
		// is what lets the group have a single expression that cannot drift from the key.
		const groupKey = buildRowGroupKey(row)!;
		const occurrence = seenPerGroup.get(groupKey) ?? 0;
		seenPerGroup.set(groupKey, occurrence + 1);
		keys.set(row.id, `${content}|${occurrence}|${accountScopeOf(row)}`);
	}

	return keys;
}
