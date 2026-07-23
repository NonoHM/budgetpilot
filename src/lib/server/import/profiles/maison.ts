import { isTransactionNature, validateTransaction } from '$lib/domain/transaction';
import type { TransactionNature } from '$lib/domain/transaction';
import type {
	CsvImportResult,
	CsvInvalidRow,
	CsvProfileParseInput,
	ImportedTransaction,
	ImportedTransactionType
} from '../types';
import {
	addInvalidRow,
	buildSummary,
	isSafeIsoDate,
	normalizeDate,
	resolveValidationField,
	toRecord
} from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildMaisonDeduplicationKey,
	hashFingerprint,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';

const MAISON_HEADERS = [
	'date',
	'libelle',
	'categorie',
	'montant',
	'type',
	'nature',
	'source_bancaire'
];
const MAX_CATEGORY_LENGTH = 80;

export function matchesMaisonHeader(headers: string[]): boolean {
	const normalizedHeaders = headers.map((header) => header.trim().toLowerCase());
	return (
		normalizedHeaders.length === MAISON_HEADERS.length &&
		normalizedHeaders.every((header, index) => header === MAISON_HEADERS[index])
	);
}

export function parseMaisonRows({ rows, errors, warnings }: CsvProfileParseInput): CsvImportResult {
	const headers = rows[0].cells.map((header) => header.trim().toLowerCase());
	if (!matchesMaisonHeader(headers)) {
		errors.push('En-tête maison non reconnu');
		return {
			transactions: [],
			errors,
			warnings,
			invalidRows: errors.map((reason, index) => ({ line: index + 1, reason })),
			summary: buildSummary({
				profile: 'maison',
				totalRows: rows.length - 1,
				validRows: 0,
				invalidRows: errors.length,
				duplicateRows: 0,
				totalDebitCents: 0,
				totalCreditCents: 0,
				dates: []
			})
		};
	}

	const transactions: ImportedTransaction[] = [];
	const seenFingerprints = new Set<string>();
	const invalidRows: CsvInvalidRow[] = [];
	let duplicateRows = 0;
	let totalDebitCents = 0;
	let totalCreditCents = 0;
	const validDates: string[] = [];

	rows.slice(1).forEach((parsedRow) => {
		const row = parsedRow.cells;
		const line = parsedRow.line;
		if (row.length !== headers.length) {
			addInvalidRow(errors, invalidRows, line, 'nombre de colonnes incorrect', 'colonnes');
			return;
		}

		const record = toRecord(headers, row);

		const date = normalizeDate(record.date ?? '');
		if (!isSafeIsoDate(date)) {
			addInvalidRow(errors, invalidRows, line, 'date invalide', 'date');
			return;
		}

		const label = sanitizeImportedText(record.libelle ?? '');

		const categoryResult = resolveMaisonCategory(record.categorie ?? '');
		if (!categoryResult.ok) {
			addInvalidRow(errors, invalidRows, line, categoryResult.reason, 'category');
			return;
		}
		const category = categoryResult.value;

		const rawAmount = (record.montant ?? '').trim().replace(/^'/, '');
		const amountCents = parseAmountCents(rawAmount);
		if (amountCents === null) {
			addInvalidRow(errors, invalidRows, line, 'montant invalide', 'amount');
			return;
		}
		if (amountCents === 0) {
			addInvalidRow(errors, invalidRows, line, 'montant à zéro refusé', 'amount');
			return;
		}

		const derivedType: ImportedTransactionType = amountCents >= 0 ? 'income' : 'expense';
		const rawType = (record.type ?? '').trim().toLowerCase();
		if (rawType !== derivedType) {
			addInvalidRow(errors, invalidRows, line, 'type et signe du montant incohérents', 'type');
			return;
		}

		const rawNature = (record.nature ?? '').trim();
		let natureManual: TransactionNature | null = null;
		if (rawNature) {
			if (!isTransactionNature(rawNature)) {
				addInvalidRow(errors, invalidRows, line, 'nature invalide', 'nature');
				return;
			}
			natureManual = rawNature;
		}

		const fingerprint = buildMaisonDeduplicationKey({
			date,
			amountCents: Math.abs(amountCents),
			label
		});
		if (seenFingerprints.has(fingerprint)) {
			errors.push(`Ligne ${line}: doublon détecté`);
			duplicateRows += 1;
			return;
		}
		seenFingerprints.add(fingerprint);

		const transaction: ImportedTransaction = {
			id: `csv-${hashFingerprint(fingerprint)}`,
			date,
			label,
			amountCents,
			category,
			source: 'csv',
			metadata: {
				reference: '',
				notes: label,
				type: derivedType,
				natureManual: natureManual ?? undefined,
				deduplicationKey: fingerprint
			}
		};
		const validation = validateTransaction(transaction);
		if (!validation.ok) {
			addInvalidRow(
				errors,
				invalidRows,
				line,
				validation.errors.join(', '),
				resolveValidationField(validation.errors)
			);
			return;
		}

		if (derivedType === 'expense') totalDebitCents += Math.abs(amountCents);
		if (derivedType === 'income') totalCreditCents += Math.abs(amountCents);
		validDates.push(date);
		transactions.push(transaction);
	});

	return {
		transactions,
		errors,
		warnings,
		invalidRows,
		summary: buildSummary({
			profile: 'maison',
			totalRows: rows.length - 1,
			validRows: transactions.length,
			invalidRows: invalidRows.length,
			duplicateRows,
			totalDebitCents,
			totalCreditCents,
			dates: validDates
		})
	};
}

function resolveMaisonCategory(
	rawValue: string
): { ok: true; value: string } | { ok: false; reason: string } {
	const sanitized = sanitizeImportedText(rawValue);
	if (!sanitized) return { ok: true, value: UNCLASSIFIED_CATEGORY };
	if (sanitized.length > MAX_CATEGORY_LENGTH) return { ok: false, reason: 'catégorie trop longue' };
	if (sanitized === UNCLASSIFIED_CATEGORY)
		return { ok: false, reason: 'catégorie réservée refusée' };
	return { ok: true, value: sanitized };
}
