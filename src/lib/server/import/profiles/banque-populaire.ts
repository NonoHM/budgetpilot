import { validateTransaction } from '$lib/domain/transaction';
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
	emptyResult,
	isIgnorableBankingRow,
	normalizeFirstValidDate,
	normalizeHeaderCells,
	resolveValidationField,
	toRecord
} from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildCsvFields,
	buildDeduplicationKey,
	buildNotes,
	firstPresent,
	hashFingerprint,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';

export const BANQUE_POPULAIRE_HEADERS = [
	'Date de comptabilisation',
	'Libelle simplifie',
	'Libelle operation',
	'Reference',
	'Informations complementaires',
	'Type operation',
	'Categorie',
	'Sous categorie',
	'Debit',
	'Credit',
	'Date operation',
	'Date de valeur',
	'Pointage operation'
];

export function matchesBanquePopulaireHeader(headers: string[]): boolean {
	const normalizedHeaders = normalizeHeaderCells(headers);
	return (
		normalizedHeaders.length === BANQUE_POPULAIRE_HEADERS.length &&
		normalizedHeaders.every((header, index) => header.trim() === BANQUE_POPULAIRE_HEADERS[index])
	);
}

export function parseBanquePopulaireRows({
	rows,
	errors,
	warnings,
	sourceName,
	categorizationRules
}: CsvProfileParseInput): CsvImportResult {
	const headers = normalizeHeaderCells(rows[0].cells);
	if (!matchesBanquePopulaireHeader(headers)) {
		return emptyResult(
			['En-tête Banque Populaire non reconnu'],
			warnings,
			'banque-populaire',
			rows.length - 1
		);
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
			if (isIgnorableBankingRow(row)) {
				addInvalidRow(errors, invalidRows, line, 'ligne ignorée: footer bancaire', 'line');
				return;
			}

			addInvalidRow(errors, invalidRows, line, 'nombre de colonnes incorrect', 'colonnes');
			return;
		}

		const record = toRecord(headers, row);
		const date = normalizeFirstValidDate(
			record['Date operation'],
			record['Date de comptabilisation'],
			record['Date de valeur']
		);
		const label = sanitizeImportedText(
			firstPresent(
				record['Libelle simplifie'],
				record['Libelle operation'],
				record['Type operation']
			) || 'Opération Banque Populaire'
		);
		const banquePopulaireCategory = sanitizeImportedText(
			firstPresent(record.Categorie, record['Sous categorie']) || 'Autre'
		);
		const subcategory = sanitizeImportedText(record['Sous categorie'] ?? '');
		const reference = sanitizeImportedText(record.Reference ?? '');
		const notes = buildNotes([
			record['Libelle operation'],
			record['Informations complementaires'],
			record.Reference,
			record['Type operation'],
			record['Pointage operation'],
			subcategory ? `Sous-catégorie: ${subcategory}` : ''
		]);
		const amount = parseBanquePopulaireAmount(record.Debit ?? '', record.Credit ?? '');

		if (amount.ok && amount.warning === 'negative-credit') {
			warnings.push(`Ligne ${line}: crédit négatif`);
		}

		if (!amount.ok) {
			addInvalidRow(errors, invalidRows, line, amount.reason, amount.field);
			return;
		}

		const fingerprint = buildDeduplicationKey({
			date,
			label,
			amountCents: amount.amountCents,
			type: amount.type,
			reference,
			account: sourceName
		});
		if (seenFingerprints.has(fingerprint)) {
			errors.push(`Ligne ${line}: doublon détecté`);
			duplicateRows += 1;
			return;
		}
		seenFingerprints.add(fingerprint);
		const categorization = applyCategorizationRules(
			{ label, category: banquePopulaireCategory, type: amount.type },
			categorizationRules
		);
		// The bank operation type (BP's "Categorie" field) is never a business category:
		// it's applied only if a rule explicitly mapped it, otherwise it stays "to classify".
		const category = categorization.ruleId ? categorization.category : UNCLASSIFIED_CATEGORY;

		const transaction: ImportedTransaction = {
			id: `csv-${hashFingerprint(fingerprint)}`,
			date,
			label,
			amountCents: amount.amountCents,
			category,
			source: 'csv',
			metadata: {
				reference,
				notes,
				type: amount.type,
				bankOperationType: banquePopulaireCategory,
				banquePopulaireCategory,
				subcategory: subcategory || undefined,
				deduplicationKey: fingerprint,
				csvFields: buildCsvFields(record, BANQUE_POPULAIRE_HEADERS)
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

		if (amount.type === 'expense') totalDebitCents += amount.amountCents;
		if (amount.type === 'income') totalCreditCents += amount.amountCents;
		validDates.push(date);
		transactions.push(transaction);
	});

	return {
		transactions,
		errors,
		warnings,
		invalidRows,
		summary: buildSummary({
			profile: 'banque-populaire',
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

type BanquePopulaireAmountResult =
	| {
			ok: true;
			amountCents: number;
			type: ImportedTransactionType;
			warning?: 'negative-credit';
	  }
	| {
			ok: false;
			reason: string;
			field: string;
	  };

function parseBanquePopulaireAmount(debit: string, credit: string): BanquePopulaireAmountResult {
	const hasDebit = debit.trim() !== '';
	const hasCredit = credit.trim() !== '';
	if (!hasDebit && !hasCredit)
		return { ok: false, reason: 'débit et crédit vides', field: 'Debit/Credit' };
	if (hasDebit && hasCredit)
		return { ok: false, reason: 'débit et crédit remplis en même temps', field: 'Debit/Credit' };

	const parsedAmount = parseAmountCents(hasDebit ? debit : credit);
	if (parsedAmount === null)
		return { ok: false, reason: 'montant invalide', field: hasDebit ? 'Debit' : 'Credit' };
	if (parsedAmount === 0)
		return { ok: false, reason: 'montant à zéro refusé', field: hasDebit ? 'Debit' : 'Credit' };

	if (hasDebit) {
		return { ok: true, amountCents: Math.abs(parsedAmount), type: 'expense' };
	}

	return {
		ok: true,
		amountCents: Math.abs(parsedAmount),
		type: 'income',
		warning: parsedAmount < 0 ? 'negative-credit' : undefined
	};
}
