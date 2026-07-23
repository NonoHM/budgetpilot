import type { ImportedTransactionType } from '../types';
import { normalizeMojibakeText } from './encoding';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';

export { UNCLASSIFIED_CATEGORY };

const DANGEROUS_TEXT_PATTERN = /^[=+\-@\t\r]/;

export function sanitizeImportedText(value: string): string {
	const sanitized = normalizeMojibakeText(value).trim().replace(/\s+/g, ' ');
	return DANGEROUS_TEXT_PATTERN.test(sanitized) ? `'${sanitized}` : sanitized;
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

export function buildDeduplicationKey(input: {
	date: string;
	label: string;
	amountCents: number;
	type: ImportedTransactionType;
	category?: string;
	reference?: string;
	account?: string;
}): string {
	const label = input.label.trim().toLowerCase().replace(/\s+/g, ' ');
	const category = input.category?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
	const account = input.account?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
	const reference = input.reference?.trim() ?? '';

	if (reference) {
		return [input.date, label, input.amountCents, input.type, reference, account].join('|');
	}

	return [input.date, label, input.amountCents, input.type, category, account].join('|');
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
