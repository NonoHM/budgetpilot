import { normalizeMojibakeText } from './encoding';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { guardFormulaLead } from '$lib/server/csv/formulaGuard';

export { UNCLASSIFIED_CATEGORY };

/**
 * Control characters with no legitimate meaning in an imported statement, once the five that
 * already have defined, tested handling are excluded: `\t` `\n` `\v` `\f` `\r` (U+0009, U+000A,
 * U+000B, U+000C, U+000D) are collapsed into an ordinary space by the whitespace pass below, same
 * as any other run of `\s`. What is left is exactly Unicode's `Cc` (control) category minus those
 * five — U+0000 through U+0008, U+000E through U+001F, and the C1 controls U+007F through
 * U+009F — spelled as literal ranges rather than `\p{Cc}`. Cc is a fixed, closed block (it is tied
 * to the ASCII/Latin-1 control codes, not to a table a Unicode version can extend), so unlike
 * `formulaGuard.ts`'s `\p{Cf}` this class cannot drift under a Node upgrade and needs no pinned
 * count to catch it if it did.
 *
 * #652: a NUL surviving into a stored `Transaction.label` throws `SQLSTATE 22021` on PostgreSQL
 * (`invalid byte sequence for encoding "UTF8": 0x00`) from inside the per-row write loop in
 * `server/import/persist.ts`, which has no enclosing transaction to roll back — rows written
 * before the throw stay committed while the batch's `importedRows` counter, written once after
 * the loop, never advances past zero. SQLite and MariaDB store the byte and never throw. Measured
 * with a planted positive on all three engines: `controlCharacterPartialCommit.db-smoke.ts`.
 *
 * None of these characters can be a real amount sign, a real separator, or a real part of a
 * French bank's own encoding the way `-39,90`'s leading `-` can — `guardFormulaLead`'s "prefix,
 * never strip" rule protects exactly that possibility for `=+-@` and stays untouched. This one
 * carries no such content: stripping it is closer to the `\s+` collapse two lines below, or to
 * `normalizeMojibakeText`'s own silent repair of a different kind of damaged byte, than to
 * altering a value a bank statement could legitimately hold.
 */
// Two literals rather than one derived with `new RegExp(source, 'g')`: `injection-sinks.spec.ts`
// (ASVS v5.0.0-1.2.9) refuses a RegExp built from a string, and a shared `g` flag would also be
// unsafe to reuse for `.test()` below — a global regex carries `lastIndex` across calls, which
// `.test()` on the same instance would then read and corrupt.
//
// Same convention as `server/auth.ts`'s `CONTROL_CHAR_PATTERN`, guarding the identical class of
// bug (a control character reaching a Postgres text parameter) on a different column.
// eslint-disable-next-line no-control-regex -- matching control characters is the point here
const STRANDED_CONTROL_CHARACTER = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point here
const STRANDED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;

/**
 * Whether IMPORTED text carries a control character `sanitizeImportedText` is about to strip.
 *
 * Exported so a caller that can still refuse the ROW this text came from — a CSV profile
 * parser, before it calls `sanitizeImportedText` — reports it as an ordinary invalid row instead
 * of silently accepting an altered label. `sanitizeImportedText` itself has no such channel: most
 * of its other callers (restore metadata, column-mapping names, bank-connector text) have no
 * per-row refusal concept to report through, which is why the strip below is the universal
 * fallback and this predicate is the opt-in refusal for the one caller that has somewhere to
 * report to. Tested against the RAW value, before mojibake normalisation or the whitespace
 * collapse: neither one can introduce or remove a `Cc` character, so the verdict is identical
 * either way and this reads the value a caller already has in hand.
 */
export function hasStrandedControlCharacter(value: string): boolean {
	return STRANDED_CONTROL_CHARACTER.test(value);
}

export function sanitizeImportedText(value: string): string {
	const withoutControlCharacters = normalizeMojibakeText(value).replace(
		STRANDED_CONTROL_CHARACTERS,
		''
	);
	const sanitized = withoutControlCharacters.trim().replace(/\s+/g, ' ');
	return guardFormulaLead(sanitized);
}

/**
 * How much of a cell a refusal fact may carry back to the browser.
 *
 * Every field this bounds holds a short token by construction: a nature, an ISO currency code,
 * a transaction state. 64 characters is far more than any of them needs and far less than a
 * cell can hold.
 */
const MAX_REFUSAL_CELL_LENGTH = 64;

/**
 * A cell value on its way into a refusal fact, and therefore on its way to the browser.
 *
 * `sanitizeImportedText` normalises mojibake, collapses whitespace and neutralises a leading
 * formula character, but it puts NO BOUND on length, which did not matter while these values
 * stayed on the server. A refusal fact is different: it is serialised into the page's data on
 * every failed import, so an unbounded cell means a user's own upload can put an arbitrary
 * blob there, limited only by the file size cap.
 *
 * So the rule for a fact payload is stricter than for stored text: sanitise AND bound. Use this
 * for anything lifted from a cell, never `sanitizeImportedText` alone.
 */
export function refusalCellValue(value: string): string {
	const sanitized = sanitizeImportedText(value);
	return sanitized.length > MAX_REFUSAL_CELL_LENGTH
		? `${sanitized.slice(0, MAX_REFUSAL_CELL_LENGTH)}...`
		: sanitized;
}

export function buildNotes(values: Array<string | undefined>): string {
	return values
		.map((value) => sanitizeImportedText(value ?? ''))
		.filter(Boolean)
		.join(' | ');
}

export function buildCsvFields(
	record: Record<string, string>,
	fields: string[]
): Record<string, string> {
	return Object.fromEntries(
		fields
			.map((field) => [field, normalizeMetadataField(field, record[field] ?? '')] as const)
			.filter(([, value]) => value !== '')
	);
}

function normalizeMetadataField(field: string, value: string): string {
	const normalized = normalizeMojibakeText(value).trim().replace(/\s+/g, ' ');
	if (['Debit', 'Credit', 'amount', 'Montant', 'Frais', 'Solde'].includes(field)) return normalized;
	return sanitizeImportedText(normalized);
}

export function firstPresent(...values: Array<string | undefined>): string {
	return values.find((value) => value?.trim())?.trim() ?? '';
}

export function hashFingerprint(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
	}
	return hash.toString(16);
}

/**
 * The id a parsed row carries through the preview, before anything is stored.
 *
 * **Not a deduplication key and never used as one.** It exists for two small reasons:
 * `validateTransaction` refuses a row with an empty id, and the preview has to tell two rows apart
 * on screen. Nothing persists it, and nothing outside the parser reads it.
 *
 * It used to be derived from the deduplication key, which the parser no longer builds: the key
 * carries the `Account.id` a row lands on, and on the CSV path that account is only resolved after
 * the profile has been detected, which is after the parse. See `dedupeRecompute.ts`.
 *
 * The source position is the first field, so two byte-identical rows in one file still get two ids.
 * Uniqueness is within one parse and nothing more.
 */
export function buildPreviewRowId(
	prefix: string,
	position: number,
	...fields: Array<string | number>
): string {
	return `${prefix}-${hashFingerprint([position, ...fields].join('|'))}`;
}
