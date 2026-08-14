import { isValidIsoDate, validateTransaction } from '$lib/domain/transaction';
import { applyCategorizationRules } from '$lib/server/categorization/rules';
import type {
	CsvImportResult,
	CsvProfileParseInput,
	ImportedTransaction,
	ImportedTransactionType
} from '../types';
import type { CsvRefusal } from '../refusals';
import {
	addRefusal,
	buildSummary,
	emptyResult,
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

/**
 * Revolut's ten columns, in the spellings this profile accepts.
 *
 * The French name stays CANONICAL: `normalizeRevolutRecord` rewrites whichever spelling the
 * file used back to it, so everything downstream reads `record['Date de fin']` unchanged and
 * this widening touches the matcher and nothing else.
 *
 * **The English spellings are not a nicety.** Revolut is the one international bank this
 * application claims to support, and before this it only worked if the user happened to
 * download their statement from a French locale account. An English export was refused with
 * nine `Colonne non autorisée` lines.
 *
 * Confirmed against parsers that read real files rather than against a guess: `tarioch/
 * beancounttools` lists these ten names in this order, and `mlaitinen/ofxstatement-revolut`
 * tests `line[c["State"]] != "COMPLETED"`.
 */
const REVOLUT_COLUMNS: Array<{ canonical: string; spellings: string[] }> = [
	{ canonical: 'Type', spellings: ['Type'] },
	{ canonical: 'Produit', spellings: ['Produit', 'Product'] },
	{ canonical: 'Date de début', spellings: ['Date de début', 'Started Date'] },
	{ canonical: 'Date de fin', spellings: ['Date de fin', 'Completed Date'] },
	{ canonical: 'Description', spellings: ['Description'] },
	{ canonical: 'Montant', spellings: ['Montant', 'Amount'] },
	{ canonical: 'Frais', spellings: ['Frais', 'Fee'] },
	{ canonical: 'Devise', spellings: ['Devise', 'Currency'] },
	{ canonical: 'État', spellings: ['État', 'State'] },
	{ canonical: 'Solde', spellings: ['Solde', 'Balance'] }
];

export const REVOLUT_HEADERS = REVOLUT_COLUMNS.map((column) => column.canonical);

/** Every accepted spelling, folded, to the canonical name it stands for. */
const SPELLING_TO_CANONICAL = new Map(
	REVOLUT_COLUMNS.flatMap((column) =>
		column.spellings.map((spelling) => [normalizeComparableHeader(spelling), column.canonical])
	)
);

const REVOLUT_METADATA_FIELDS = [
	'Type',
	'Produit',
	'Date de début',
	'Date de fin',
	'Frais',
	'Devise',
	'État',
	'Solde'
];

/**
 * ORDER IS NO LONGER LOAD BEARING, and that is a deliberate second change.
 *
 * The issue that prompted this warned that a matcher keyed on exact ordered equality will keep
 * breaking, because Revolut has changed its export across regions and over time. Nothing
 * downstream ever depended on the order: `normalizeRevolutRecord` builds a record by NAME and
 * every read is `record['Date de fin']` and friends. Only this function imposed it.
 *
 * The ten names are required to be present exactly once each, so a file is still refused if it
 * is missing a column, carries a duplicate, or has a different count.
 *
 * WHAT THIS STILL DOES NOT ACCEPT, stated so the fix is not read as more than it is: Revolut's
 * NINE column, semicolon separated `amount_debit` / `amount_credit` variant is a different
 * format, not a reordering, and it needs a stated sign rule. It is out of scope here.
 */
export function matchesRevolutHeader(headers: string[]): boolean {
	const normalizedHeaders = normalizeHeaderCells(headers).map(normalizeComparableHeader);
	if (normalizedHeaders.length !== REVOLUT_COLUMNS.length) return false;
	const canonicals = new Set(
		normalizedHeaders
			.map((header) => SPELLING_TO_CANONICAL.get(header))
			.filter((canonical): canonical is string => canonical !== undefined)
	);
	// Ten headers that resolve to ten DISTINCT canonical names. The count check above plus this
	// one together rule out a duplicate (which would shrink the set) and an unknown column
	// (which `filter` drops, also shrinking it), so no third clause is needed.
	return canonicals.size === REVOLUT_COLUMNS.length;
}

export function parseRevolutRows({
	rows,
	warnings,
	categorizationRules
}: CsvProfileParseInput): CsvImportResult {
	const headers = normalizeHeaderCells(rows[0].cells);
	if (!matchesRevolutHeader(headers)) {
		return emptyResult(
			[{ code: 'header-not-recognized', profile: 'Revolut' }],
			warnings,
			'revolut',
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
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'bad-column-count', expected: headers.length, actual: row.length },
				'colonnes'
			);
			return;
		}

		const record = normalizeRevolutRecord(toRecord(headers, row));
		const state = sanitizeImportedText(record['État'] ?? '');
		const currency = sanitizeImportedText(record.Devise ?? '');

		if (!isCompletedState(state)) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'state-not-completed', state: refusalCellValue(state) },
				'État'
			);
			return;
		}

		if (currency !== 'EUR') {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'unsupported-currency', currency: refusalCellValue(currency) },
				'Devise'
			);
			return;
		}

		const date = normalizeFirstValidDate(record['Date de fin'], record['Date de début']);
		if (!isValidIsoDate(date)) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'invalid-date', column: 'Date de fin' },
				'Date de fin'
			);
			return;
		}

		const amountCents = parseAmountCents(record.Montant ?? '');
		if (amountCents === null) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'invalid-amount', column: 'Montant' },
				'Montant'
			);
			return;
		}

		if (amountCents === 0) {
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{ code: 'zero-amount', column: 'Montant' },
				'Montant'
			);
			return;
		}

		const feeCents = firstPresent(record.Frais) ? parseAmountCents(record.Frais ?? '') : null;
		if (feeCents === null && firstPresent(record.Frais)) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'invalid-fee' }, 'Frais');
			return;
		}

		const balanceCents = firstPresent(record.Solde) ? parseAmountCents(record.Solde ?? '') : null;
		if (balanceCents === null && firstPresent(record.Solde)) {
			addRefusal(refusals, { kind: 'row', line }, { code: 'invalid-balance' }, 'Solde');
			return;
		}

		const label = sanitizeImportedText(record.Description || 'Opération Revolut');
		const revolutType = sanitizeImportedText(record.Type ?? '');
		const product = sanitizeImportedText(record.Produit ?? '');
		const category = sanitizeImportedText(revolutType || 'Revolut');
		const type: ImportedTransactionType = amountCents >= 0 ? 'income' : 'expense';
		const absAmountCents = Math.abs(amountCents);
		// The ordinal is what makes two identical rows two transactions rather than one. The
		// in-file skip that used to sit here collapsed them and counted the second as a
		// duplicate, so a file carrying the same row twice imported one of them.
		const group = { date, label, amountCents: absAmountCents, type };
		const fingerprint = buildDeduplicationKey({
			...group,
			occurrence: nextOccurrence(buildDeduplicationGroupKey(group))
		});
		const categorization = applyCategorizationRules({ label, category, type }, categorizationRules);
		// The Revolut operation type (the "Type" field) is never a business category:
		// it's applied only if a rule explicitly mapped it, otherwise it stays "to classify".
		const effectiveCategory = categorization.ruleId
			? categorization.category
			: UNCLASSIFIED_CATEGORY;
		const notes = buildNotes([
			record.Type,
			record.Produit,
			feeCents ? `Frais: ${record.Frais}` : ''
		]);

		const transaction: ImportedTransaction = {
			id: `csv-${hashFingerprint(fingerprint)}`,
			date,
			label,
			amountCents: absAmountCents,
			category: effectiveCategory,
			source: 'csv',
			metadata: {
				reference: '',
				notes,
				type,
				bankOperationType: revolutType || undefined,
				revolutType: revolutType || undefined,
				revolutProduct: product || undefined,
				revolutCurrency: currency,
				revolutState: state,
				revolutFeeCents: feeCents ?? undefined,
				revolutBalanceCents: balanceCents ?? undefined,
				deduplicationKey: fingerprint,
				csvFields: buildCsvFields(record, REVOLUT_METADATA_FIELDS)
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

		if (type === 'expense') totalDebitCents += absAmountCents;
		if (type === 'income') totalCreditCents += absAmountCents;
		validDates.push(date);
		transactions.push(transaction);
	});

	return {
		transactions,
		warnings,
		invalidRows: refusals,
		summary: buildSummary({
			profile: 'revolut',
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

function normalizeComparableHeader(value: string): string {
	return value
		.trim()
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase();
}

function normalizeRevolutRecord(record: Record<string, string>): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		// Any accepted spelling, French or English, becomes the canonical French key, so every
		// read below this line is unchanged by the widening.
		const canonical = SPELLING_TO_CANONICAL.get(normalizeComparableHeader(key));
		normalized[canonical ?? key] = value;
	}
	return normalized;
}

/**
 * The header is only half the defect.
 *
 * An English export writes `COMPLETED` in the State column, so a file whose header now matches
 * would still have had every row refused as `état Revolut non terminé`. The two halves fail
 * independently and are therefore break checked independently.
 *
 * An allow list of two values, not a pattern: anything else is still refused, which is the
 * point of the column. `normalizeComparableHeader` folds case and diacritics, so `Terminé`,
 * `TERMINE`, `Completed` and `COMPLETED` all land here.
 */
const COMPLETED_STATES = new Set(['termine', 'completed']);

function isCompletedState(value: string): boolean {
	return COMPLETED_STATES.has(normalizeComparableHeader(value));
}
