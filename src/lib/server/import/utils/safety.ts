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
export function buildDeduplicationKey(input: {
	date: string;
	label: string;
	amountCents: number;
	type: ImportedTransactionType;
	category?: string;
	reference?: string;
	accountScope?: string;
}): string {
	const label = input.label.trim().toLowerCase().replace(/\s+/g, ' ');
	const category = input.category?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
	const reference = input.reference?.trim() ?? '';
	const scope = input.accountScope?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';

	if (reference) {
		return [input.date, label, input.amountCents, input.type, reference, scope].join('|');
	}

	return [input.date, label, input.amountCents, input.type, category, scope].join('|');
}

export function buildMaisonDeduplicationKey(input: {
	date: string;
	amountCents: number;
	label: string;
}): string {
	const label = input.label.trim().toLowerCase().replace(/\s+/g, ' ');
	return [input.date, input.amountCents, label].join('|');
}

export function hashFingerprint(value: string): string {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
	}
	return hash.toString(16);
}
