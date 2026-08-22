import type { ImportedTransactionType } from '../types';
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

/**
 * The duplicate-detection key for an imported transaction.
 *
 * `accountScope` SEPARATES TWO ACCOUNTS THAT HOLD THE SAME TRANSACTION, and nothing else.
 *
 * It exists for bank sync, where it carries a provider account identifier
 * (`enablebanking:<accountId>`). Two accounts at one provider can genuinely hold a transaction with
 * the same date, label, amount and category, and without this they would deduplicate against each
 * other and one would silently vanish.
 *
 * **It must be stable for the life of the account, and it must never be anything per file.** It was
 * called `account`, and the three CSV profiles passed the uploaded FILE'S NAME into it, so the same
 * statement re-downloaded as `releve (1).csv` imported a second time. The parameter was meant to
 * separate accounts and the filename was the value at hand: a placeholder acquiring a meaning
 * nobody assigned it.
 *
 * The filename was also measurably doing nothing useful. Within one file every row carries the same
 * name, so it could never tell two identical rows apart, and both key shapes collapsed them
 * identically. Its only effect was across files, and its only effect there was that duplicate.
 *
 * The CSV profiles now pass nothing. The rename is what stops a filename coming back: `account`
 * invited any account-ish string, `accountScope` does not read like somewhere to put a file.
 */
export interface DeduplicationGroup {
	date: string;
	label: string;
	/** Signed or not: the magnitude is taken here, and the direction lives in `type`. */
	amountCents: number;
	type: ImportedTransactionType;
}

/**
 * The four fields two transactions must share to be candidates for being the same transaction.
 *
 * This is a GROUP key, not an identity: several genuinely different transactions can share it,
 * and separating them is what the occurrence ordinal does. It is exported so a caller assigns
 * ordinals over exactly the string the final key is built from. Recomputing that expression at
 * the call site is how the two would quietly stop agreeing, which is the shape this repository
 * has already paid for in an oracle that retyped the rule it audited.
 */
export function buildDeduplicationGroupKey(input: DeduplicationGroup): string {
	const label = input.label.trim().toLowerCase().replace(/\s+/g, ' ');
	return [input.date, label, Math.abs(input.amountCents), input.type].join('|');
}

/**
 * The duplicate-detection key for an imported transaction. Version 2.
 *
 * ## What it contains, and the one rule behind it
 *
 * `date | folded label | magnitude | type | occurrence | accountScope`
 *
 * **Only the fields every source guarantees, plus values derived from them.** Nothing optional,
 * nothing that depends on which columns a file happened to carry.
 *
 * ## What v1 contained, and why each part left
 *
 * **`category` left.** It was the fifth field on `generic` and on both bank connectors. If the key
 * depended on which columns were mapped, then correcting a mapping would change every fingerprint
 * and re-import the user's entire history as new transactions. Correction is the whole point of
 * the column mapping path, and **a key that changes when the user fixes a mistake is not a key.**
 * The same argument one step down excludes it generally: a file carrying a category this month and
 * not next month produces two keys for one transaction. On the two bank connectors it was the
 * constant `UNCLASSIFIED_CATEGORY` and contributed nothing at all.
 *
 * **`reference` left, for the same reason with a sharper edge.** It occupied the fifth field on
 * `revolut` (as `type:product`) and on `banque-populaire` (as the statement's own reference), so
 * two profiles were keying on a value the file may or may not carry. Measured before the change:
 * `2026-08-01|tesco|1230|expense|card_payment:current|` against
 * `2026-06-24|carrefour|2490|expense|REF1|`. A bank that stops emitting its reference column, or
 * emits it blank for one row, produced a different key for a transaction already imported.
 *
 * **The filename left in #317**, and `accountScope` stays, unchanged and for its own reason: it
 * SEPARATES TWO ACCOUNTS THAT HOLD THE SAME TRANSACTION, and nothing else. It carries a provider
 * account identifier (`enablebanking:<accountId>`) on the bank-sync path. Two accounts at one
 * provider can genuinely hold a transaction with the same date, label, amount and direction, and
 * without this they would deduplicate against each other and one would silently vanish. **It must
 * be stable for the life of the account and must never be anything per file**: it was called
 * `account`, three CSV profiles passed the uploaded file's name into it, and the same statement
 * re-downloaded as `releve (1).csv` imported twice.
 *
 * ## What `occurrence` buys, and what it costs
 *
 * Two coffees at the same price on the same day at the same merchant are ordinary, and v1 merged
 * them: measured, every profile reported `validRows: 1, duplicateRows: 1` on a file carrying the
 * row twice. **A silently dropped transaction is the worse failure direction**, because a
 * duplicate is visible on the screen and a missing row is not.
 *
 * Its cost, stated: a bank that reorders rows within one day can shift an ordinal and produce one
 * duplicate. That is the visible direction, chosen deliberately. See `occurrence.ts` for why the
 * ordinal is scoped to the collision group rather than to the file.
 *
 * ## Migration: this is v2, and old rows keep old keys
 *
 * A statement imported both before and after this change duplicates once, in the visible
 * direction. Backfill was rejected as impossible rather than expensive: `dedupeKey` is stored raw
 * for traceability, but old keys carry no ordinal and, on three profiles, cannot be separated from
 * the filename that used to be embedded in them.
 *
 * Profile-conditional dedupe (a new rule for mapped imports only) was rejected for what it does to
 * readers: it makes the contract depend on which import wrote a row, so "why did this duplicate"
 * needs archaeology. **Two contracts pretending to be one.** A versioned key is one contract with
 * a stated history.
 */
export function buildDeduplicationKey(
	input: DeduplicationGroup & {
		/** Index within the collision group, in source order. See `assignOccurrences`. */
		occurrence: number;
		accountScope?: string;
	}
): string {
	const scope = input.accountScope?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
	return [buildDeduplicationGroupKey(input), input.occurrence, scope].join('|');
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
