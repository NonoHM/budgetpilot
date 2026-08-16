import { isValidIsoDate, validateTransaction } from '$lib/domain/transaction';
import { applyCategorizationRules } from '$lib/server/categorization/rules';
import type {
	CsvImportResult,
	CsvProfileParseInput,
	ImportedTransaction,
	ImportedTransactionType
} from '../types';
import type { CsvRefusal, CsvRefusalFact } from '../refusals';
import {
	addRefusal,
	buildSummary,
	emptyResult,
	isIgnorableBankingRow,
	normalizeFirstValidDate,
	normalizeHeaderCells,
	toRecord
} from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildCsvFields,
	buildDeduplicationGroupKey,
	buildDeduplicationKey,
	buildNotes,
	firstPresent,
	hashFingerprint,
	refusalCellValue,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';
import { createOccurrenceCounter } from '../occurrence';

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
	warnings,
	categorizationRules
}: CsvProfileParseInput): CsvImportResult {
	const headers = normalizeHeaderCells(rows[0].cells);
	if (!matchesBanquePopulaireHeader(headers)) {
		return emptyResult(
			[{ code: 'header-not-recognized', profile: 'Banque Populaire' }],
			warnings,
			'banque-populaire',
			rows.length - 1
		);
	}

	const transactions: ImportedTransaction[] = [];
	// One counter per parse, never shared between files: see occurrence.ts.
	const nextOccurrence = createOccurrenceCounter();
	const refusals: CsvRefusal[] = [];
	// Kept at zero and still reported: within one file nothing is a duplicate any more, and
	// saying so in the summary is what stops a reader inferring the counter was forgotten.
	const duplicateRows = 0;
	let totalDebitCents = 0;
	let totalCreditCents = 0;
	const validDates: string[] = [];

	rows.slice(1).forEach((parsedRow) => {
		const row = parsedRow.cells;
		const line = parsedRow.line;
		if (row.length !== headers.length) {
			if (isIgnorableBankingRow(row)) {
				addRefusal(refusals, { kind: 'row', line }, { code: 'footer-ignored' }, 'line');
				return;
			}

			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'bad-column-count', expected: headers.length, actual: row.length },
				'colonnes'
			);
			return;
		}

		const record = toRecord(headers, row);
		const date = normalizeFirstValidDate(
			record['Date operation'],
			record['Date de comptabilisation'],
			record['Date de valeur']
		);
		/**
		 * The date, checked HERE rather than left to `validateTransaction` at the bottom.
		 *
		 * It used to fall through. `normalizeFirstValidDate` returns its best effort whatever
		 * happens, so an unreadable date reached the validator and came back as
		 * `transaction-invalid` carrying `invalid-iso-date` — a violation with no column, no
		 * field and no expected form, rendered as « date ISO invalide ». The other three profiles
		 * all guarded their date and emitted `invalid-date`, so this profile alone said something
		 * different for the same event, and it is the profile whose files can least afford it:
		 * a Banque Populaire statement splits money across two columns, so a run that imports
		 * nothing also trips the split guard at the route, which suppresses the designation
		 * offer. Every other rescue is legitimately unavailable and the sentence is all there is.
		 *
		 * Measured through the route at 1280 before this guard: eight rows, eight identical
		 * « date ISO invalide », the « Champ » column empty, and no next action on the screen.
		 */
		if (!isValidIsoDate(date)) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{
					code: 'invalid-date',
					column: 'Date operation',
					// The value the fallback last tried, in its own order, so the sentence shows
					// the cell that was read rather than one of the two columns it skipped.
					value: refusalCellValue(
						firstPresent(
							record['Date operation'],
							record['Date de comptabilisation'],
							record['Date de valeur']
						)
					)
				},
				'Date operation'
			);
			return;
		}
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
			addRefusal(refusals, { kind: 'row', line }, amount.fact, amount.field);
			return;
		}

		// The ordinal is what makes two identical rows two transactions rather than one. The
		// in-file skip that used to sit here collapsed them and counted the second as a
		// duplicate, so a file carrying the same row twice imported one of them.
		const group = { date, label, amountCents: amount.amountCents, type: amount.type };
		const fingerprint = buildDeduplicationKey({
			...group,
			occurrence: nextOccurrence(buildDeduplicationGroupKey(group))
		});
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
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{
					code: 'transaction-invalid',
					violations: validation.violations
				}
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
		warnings,
		invalidRows: refusals,
		summary: buildSummary({
			profile: 'banque-populaire',
			totalRows: rows.length - 1,
			validRows: transactions.length,
			invalidRows: refusals.length,
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
			fact: CsvRefusalFact;
			field: string;
	  };

function parseBanquePopulaireAmount(debit: string, credit: string): BanquePopulaireAmountResult {
	const hasDebit = debit.trim() !== '';
	const hasCredit = credit.trim() !== '';
	if (!hasDebit && !hasCredit)
		return { ok: false, fact: { code: 'debit-credit-empty' }, field: 'Debit/Credit' };
	if (hasDebit && hasCredit)
		return { ok: false, fact: { code: 'debit-credit-both' }, field: 'Debit/Credit' };

	const parsedAmount = parseAmountCents(hasDebit ? debit : credit);
	if (parsedAmount === null)
		return {
			ok: false,
			fact: { code: 'invalid-amount', column: hasDebit ? 'Debit' : 'Credit' },
			field: hasDebit ? 'Debit' : 'Credit'
		};
	if (parsedAmount === 0)
		return {
			ok: false,
			fact: { code: 'zero-amount', column: hasDebit ? 'Debit' : 'Credit' },
			field: hasDebit ? 'Debit' : 'Credit'
		};

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
