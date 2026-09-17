import { isTransactionNature, validateTransaction } from '$lib/domain/transaction';
import type { TransactionNature } from '$lib/domain/transaction';
import type {
	CsvImportResult,
	CsvProfileParseInput,
	ImportedTransaction,
	ImportedTransactionType
} from '../types';
import type { CsvRefusal } from '../refusals';
import { addRefusal, buildSummary, emptyResult, readDateCell, toRecord } from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildPreviewRowId,
	refusalCellValue,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';
import { foldExactHeader } from '../utils/encoding';

/** The single column every version of this format writes its date in. */
export const MAISON_DATE_COLUMN = 'date';

const MAISON_HEADERS = [
	MAISON_DATE_COLUMN,
	'libelle',
	'categorie',
	'montant',
	'type',
	'nature',
	'source_bancaire'
];
const MAX_CATEGORY_LENGTH = 80;

export function matchesMaisonHeader(headers: string[]): boolean {
	const normalizedHeaders = headers.map(foldExactHeader);
	return (
		normalizedHeaders.length === MAISON_HEADERS.length &&
		normalizedHeaders.every((header, index) => header === MAISON_HEADERS[index])
	);
}

/**
 * Where this file's dates are, as indices. See `CsvProfileParser.dateColumns`.
 *
 * Resolved by NAME against the file's own header rather than returned as a constant index, even
 * though the match is exact ordered equality and the answer is therefore always the same. A
 * constant would be correct today and silently wrong the first time a column is inserted before
 * it, which is precisely how a version of this format is added.
 */
export function maisonDateColumns(headers: string[]): number[] {
	const index = headers.map(foldExactHeader).indexOf(MAISON_DATE_COLUMN);
	return index >= 0 ? [index] : [];
}

export function parseMaisonRows({
	rows,
	warnings,
	dateOrder
}: CsvProfileParseInput): CsvImportResult {
	const headers = rows[0].cells.map(foldExactHeader);
	if (!matchesMaisonHeader(headers)) {
		return emptyResult(
			[{ code: 'header-not-recognized', profile: 'maison' }],
			warnings,
			'maison',
			rows.length - 1
		);
	}

	const transactions: ImportedTransaction[] = [];
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
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'bad-column-count', expected: headers.length, actual: row.length },
				'colonnes'
			);
			return;
		}

		const record = toRecord(headers, row);

		const date = readDateCell(record.date ?? '', dateOrder);
		if (date === null) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'invalid-date', column: 'date', value: refusalCellValue(record.date ?? '') },
				'date'
			);
			return;
		}

		const label = sanitizeImportedText(record.libelle ?? '');

		const categoryResult = resolveMaisonCategory(record.categorie ?? '');
		if (!categoryResult.ok) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'category-too-long' }, 'category');
			return;
		}
		const category = categoryResult.value;

		const rawAmount = (record.montant ?? '').trim().replace(/^'/, '');
		const amountCents = parseAmountCents(rawAmount);
		if (amountCents === null) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'invalid-amount', column: 'montant' },
				'amount'
			);
			return;
		}
		if (amountCents === 0) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'zero-amount', column: 'montant' },
				'amount'
			);
			return;
		}

		const derivedType: ImportedTransactionType = amountCents >= 0 ? 'income' : 'expense';
		const rawType = (record.type ?? '').trim().toLowerCase();
		if (rawType !== derivedType) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'type-amount-mismatch' }, 'type');
			return;
		}

		const rawNature = (record.nature ?? '').trim();
		let natureManual: TransactionNature | null = null;
		if (rawNature) {
			if (!isTransactionNature(rawNature)) {
				addRefusal(
					refusals,
					{ kind: 'row', line },
					{ code: 'invalid-nature', value: refusalCellValue(rawNature) },
					'nature'
				);
				return;
			}
			natureManual = rawNature;
		}

		// The ordinal is what makes two identical rows two transactions rather than one. The
		// in-file skip that used to sit here collapsed them and counted the second as a
		// duplicate, so a file carrying the same row twice imported one of them.
		const transaction: ImportedTransaction = {
			id: buildPreviewRowId('csv', line, date, label, amountCents),
			date,
			label,
			amountCents,
			category,
			source: 'csv',
			metadata: {
				reference: '',
				notes: label,
				type: derivedType,
				natureManual: natureManual ?? undefined
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

		if (derivedType === 'expense') totalDebitCents += Math.abs(amountCents);
		if (derivedType === 'income') totalCreditCents += Math.abs(amountCents);
		validDates.push(date);
		transactions.push(transaction);
	});

	return {
		transactions,
		warnings,
		invalidRows: refusals,
		summary: buildSummary({
			profile: 'maison',
			totalRows: rows.length - 1,
			validRows: transactions.length,
			invalidRows: refusals.length,
			fileLevelRefusals: 0,
			duplicateRows,
			totalDebitCents,
			totalCreditCents,
			dates: validDates
		})
	};
}

function resolveMaisonCategory(rawValue: string): { ok: true; value: string } | { ok: false } {
	const sanitized = sanitizeImportedText(rawValue);
	if (!sanitized) return { ok: true, value: UNCLASSIFIED_CATEGORY };
	if (sanitized.length > MAX_CATEGORY_LENGTH) return { ok: false };
	// The literal sentinel is ACCEPTED, not refused, and the reason is the round trip: the export
	// writes `getEffectiveCategory`, which is exactly this string for every row in the « à classer »
	// pile. Refusing it made `docs/getting-started.md`'s "an export re-imports cleanly" false for
	// the commonest kind of row in a fresh install. An empty cell already resolves here, so this
	// widens nothing a third-party file could not already reach. There is deliberately no branch
	// for it: the value is returned unchanged like any other, and a `=== UNCLASSIFIED_CATEGORY`
	// test that returns the same string either way would be a protection that protects nothing.
	return { ok: true, value: sanitized };
}
