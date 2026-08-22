import { normalizeMojibakeText } from './encoding';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';

export { UNCLASSIFIED_CATEGORY };

const DANGEROUS_TEXT_PATTERN = /^[=+\-@\t\r]/;

export function sanitizeImportedText(value: string): string {
	const sanitized = normalizeMojibakeText(value).trim().replace(/\s+/g, ' ');
	return DANGEROUS_TEXT_PATTERN.test(sanitized) ? `'${sanitized}` : sanitized;
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
