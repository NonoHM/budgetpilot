import { isValidIsoDate, validateTransaction } from '$lib/domain/transaction';
import { applyCategorizationRules } from '$lib/server/categorization/rules';
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
	getDuplicateHeaders,
	normalizeDate,
	resolveValidationField,
	toRecord
} from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildCsvFields,
	buildDeduplicationKey,
	hashFingerprint,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';

const ALLOWED_HEADERS = new Set(['date', 'label', 'amount', 'category']);
const GENERIC_FIELDS = ['date', 'label', 'amount', 'category'];

export function matchesGenericHeader(): boolean {
	return true;
}

export function parseGenericRows({
	rows,
	errors,
	warnings,
	sourceName,
	categorizationRules
}: CsvProfileParseInput): CsvImportResult {
	const headers = rows[0].cells.map((header) => header.trim().toLowerCase());
	const duplicateHeaders = getDuplicateHeaders(headers);
	for (const header of duplicateHeaders) errors.push(`Colonne dupliquée: ${header}`);
	const unknownHeaders = headers.filter((header) => !ALLOWED_HEADERS.has(header));
	for (const header of unknownHeaders) errors.push(`Colonne non autorisée: ${header}`);

	for (const requiredHeader of ['date', 'label', 'amount']) {
		if (!headers.includes(requiredHeader))
			errors.push(`Colonne requise absente: ${requiredHeader}`);
	}

	if (errors.length > 0) {
		return {
			transactions: [],
			errors,
			warnings,
			invalidRows: errors.map((reason, index) => ({ line: index + 1, reason })),
			summary: buildSummary({
				profile: 'generic',
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
		const amountCents = parseAmountCents(record.amount ?? '');
		const date = normalizeDate(record.date ?? '');
		const label = sanitizeImportedText(record.label ?? '');
		const category = sanitizeImportedText(record.category || UNCLASSIFIED_CATEGORY);

		if (!isValidIsoDate(date)) {
			addInvalidRow(errors, invalidRows, line, 'date invalide', 'date');
			return;
		}

		if (amountCents === null) {
			addInvalidRow(errors, invalidRows, line, 'montant invalide', 'amount');
			return;
		}

		if (amountCents === 0) {
			addInvalidRow(errors, invalidRows, line, 'montant à zéro refusé', 'amount');
			return;
		}

		const type: ImportedTransactionType = amountCents >= 0 ? 'income' : 'expense';
		const fingerprint = buildDeduplicationKey({
			date,
			label,
			amountCents: Math.abs(amountCents),
			type,
			category,
			account: sourceName
		});
		if (seenFingerprints.has(fingerprint)) {
			errors.push(`Ligne ${line}: doublon détecté`);
			duplicateRows += 1;
			return;
		}
		seenFingerprints.add(fingerprint);
		const categorization = applyCategorizationRules({ label, category, type }, categorizationRules);

		const transaction: ImportedTransaction = {
			id: `csv-${hashFingerprint(fingerprint)}`,
			date,
			label,
			amountCents,
			category: categorization.category,
			source: 'csv',
			metadata: {
				reference: '',
				notes: label,
				type,
				deduplicationKey: fingerprint,
				csvFields: buildCsvFields(record, GENERIC_FIELDS)
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

		if (type === 'expense') totalDebitCents += Math.abs(amountCents);
		if (type === 'income') totalCreditCents += Math.abs(amountCents);
		validDates.push(date);
		transactions.push(transaction);
	});

	return {
		transactions,
		errors,
		warnings,
		invalidRows,
		summary: buildSummary({
			profile: 'generic',
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
