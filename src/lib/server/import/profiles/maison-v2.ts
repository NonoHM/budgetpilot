import { isTransactionNature, isValidIsoDate, validateTransaction } from '$lib/domain/transaction';
import type { TransactionNature } from '$lib/domain/transaction';
import { MAX_SPLITS_PER_TRANSACTION, MIN_SPLITS_PER_TRANSACTION } from '$lib/domain/allocation';
import type {
	CsvImportResult,
	CsvInvalidRow,
	CsvProfileParseInput,
	ImportedSplitPart,
	ImportedTransaction,
	ImportedTransactionType
} from '../types';
import {
	addInvalidRow,
	buildSummary,
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

/**
 * « maison » version 2 — the export's own format once a transaction can be répartie (OD-2, option b).
 *
 * **This is a second profile, not an edit to the first.** `maison.ts` still recognises the seven-
 * column header byte for byte, because a file a user exported before this shipped is already on
 * their disk and an export format is a CONTRACT, not an output. Any column added later inherits the
 * same rule: add a version, never change the shape an installed file already has.
 *
 * The file states one line per ALLOCATION, so a répartition is N lines that must be put back
 * together. Three columns make that possible, and each is load-bearing:
 *
 *  - `montant_total` completes the grouping key (date, libellé, montant_total) and is the sum the
 *    parts are checked against.
 *  - `part` is `i/n`: `n` is how a TRUNCATED group is told from a complete one — without it, two of
 *    three lines would import as a perfectly plausible two-part répartition summing to the wrong
 *    total — and `i` restores `position`, which decides which part carries the rounding cent and is
 *    therefore visible to the user rather than an implementation detail.
 *  - `categorie_parent` is the parent's own category, which appears in NO line otherwise: a
 *    correctly-split transaction has a zero remainder, so `allocationsOf` emits only the parts.
 *
 * Everything a group is refused for is refused BEFORE any transaction is produced, so a hand-edited
 * file cannot reach `replaceSplits` with a répartition that does not sum. That service re-checks it
 * anyway — it is the single write path and must not trust a caller — but the refusal a user reads
 * belongs here, with a line number.
 */
export const MAISON_V2_HEADER =
	'date;libelle;categorie;montant;type;nature;source_bancaire;montant_total;part;categorie_parent';

const MAISON_V2_HEADERS = MAISON_V2_HEADER.split(';');
const MAX_CATEGORY_LENGTH = 80;
const PART_PATTERN = /^(\d{1,3})\/(\d{1,3})$/;

export function matchesMaisonV2Header(headers: string[]): boolean {
	const normalizedHeaders = headers.map((header) => header.trim().toLowerCase());
	return (
		normalizedHeaders.length === MAISON_V2_HEADERS.length &&
		normalizedHeaders.every((header, index) => header === MAISON_V2_HEADERS[index])
	);
}

/** One parsed line, before the lines of a répartition are put back together. */
interface AllocationLine {
	line: number;
	date: string;
	label: string;
	category: string;
	parentCategory: string;
	amountCents: number;
	totalCents: number;
	type: ImportedTransactionType;
	natureManual: TransactionNature | null;
	index: number;
	count: number;
}

export function parseMaisonV2Rows({
	rows,
	errors,
	warnings
}: CsvProfileParseInput): CsvImportResult {
	const headers = rows[0].cells.map((header) => header.trim().toLowerCase());
	const invalidRows: CsvInvalidRow[] = [];

	if (!matchesMaisonV2Header(headers)) {
		errors.push('En-tête maison non reconnu');
		return emptyV2Result(errors, warnings);
	}

	// Grouped in file order, so the first line of a group is the one a refusal is reported against —
	// the line the user's eye lands on when they open the file at the reported number.
	const groups = new Map<string, AllocationLine[]>();
	const groupOrder: string[] = [];
	// Lines refused before they could join a group. Counted here rather than derived from
	// `invalidRows` afterwards, so the summary's arithmetic is a tally rather than a guess.
	let ungroupableLines = 0;

	rows.slice(1).forEach((parsedRow) => {
		const parsed = parseAllocationLine(
			parsedRow.cells,
			headers,
			parsedRow.line,
			errors,
			invalidRows
		);
		if (!parsed) {
			ungroupableLines += 1;
			return;
		}

		const key = `${parsed.date}|${parsed.label.toLowerCase()}|${parsed.totalCents}`;
		const existing = groups.get(key);
		if (existing) {
			existing.push(parsed);
			return;
		}
		groups.set(key, [parsed]);
		groupOrder.push(key);
	});

	const transactions: ImportedTransaction[] = [];
	const seenFingerprints = new Set<string>();
	let duplicateRows = 0;
	let totalDebitCents = 0;
	let totalCreditCents = 0;
	const validDates: string[] = [];

	for (const key of groupOrder) {
		const group = (groups.get(key) as AllocationLine[]).slice().sort((a, b) => a.index - b.index);
		const line = group[0].line;

		const shape = validateGroupShape(group);
		if (shape) {
			addInvalidRow(errors, invalidRows, line, shape.reason, shape.field);
			continue;
		}

		const { date, label, totalCents, type, parentCategory } = group[0];
		const fingerprint = buildMaisonDeduplicationKey({
			date,
			amountCents: Math.abs(totalCents),
			label
		});
		if (seenFingerprints.has(fingerprint)) {
			errors.push(`Ligne ${line}: doublon détecté`);
			duplicateRows += 1;
			continue;
		}
		seenFingerprints.add(fingerprint);

		// A nature the whole group agrees on is the parent's override reproduced; a group that
		// disagrees is OD-4 working as designed, and there is no honest single value to store.
		const natures = new Set(group.map((part) => part.natureManual));
		const natureManual = natures.size === 1 ? group[0].natureManual : null;

		const transaction: ImportedTransaction = {
			id: `csv-${hashFingerprint(fingerprint)}`,
			date,
			label,
			amountCents: totalCents,
			category: parentCategory,
			source: 'csv',
			metadata: {
				reference: '',
				notes: label,
				type,
				natureManual: natureManual ?? undefined,
				deduplicationKey: fingerprint
			}
		};
		if (group.length >= MIN_SPLITS_PER_TRANSACTION) {
			transaction.splitParts = group.map<ImportedSplitPart>((part) => ({
				category: part.category,
				amountCents: part.amountCents
			}));
		}

		const validation = validateTransaction(transaction);
		if (!validation.ok) {
			addInvalidRow(
				errors,
				invalidRows,
				line,
				validation.errors.join(', '),
				resolveValidationField(validation.errors)
			);
			continue;
		}

		// The PARENT's total, once — a per-line sum would report a split transaction's money twice.
		if (type === 'expense') totalDebitCents += Math.abs(totalCents);
		if (type === 'income') totalCreditCents += Math.abs(totalCents);
		validDates.push(date);
		transactions.push(transaction);
	}

	return {
		transactions,
		errors,
		warnings,
		invalidRows,
		summary: buildSummary({
			profile: 'maison',
			// TRANSACTIONS, not physical lines: a file of five répartitions is five things the user
			// asked to import, and a row count of twelve against five valid ones would read as seven
			// failures. Lines refused before a group could form have no group to be counted as, so
			// they are added back individually and the three tallies reconcile.
			totalRows: groupOrder.length + ungroupableLines,
			validRows: transactions.length,
			invalidRows: invalidRows.length,
			duplicateRows,
			totalDebitCents,
			totalCreditCents,
			dates: validDates
		})
	};
}

function parseAllocationLine(
	row: string[],
	headers: string[],
	line: number,
	errors: string[],
	invalidRows: CsvInvalidRow[]
): AllocationLine | null {
	if (row.length !== headers.length) {
		addInvalidRow(errors, invalidRows, line, 'nombre de colonnes incorrect', 'colonnes');
		return null;
	}

	const record = toRecord(headers, row);

	const date = normalizeDate(record.date ?? '');
	if (!isValidIsoDate(date)) {
		addInvalidRow(errors, invalidRows, line, 'date invalide', 'date');
		return null;
	}

	const label = sanitizeImportedText(record.libelle ?? '');

	const category = resolveV2Category(record.categorie ?? '');
	if (!category.ok) {
		addInvalidRow(errors, invalidRows, line, category.reason, 'category');
		return null;
	}

	// Falls back to the allocation's own category when the column is blank, which is what a
	// hand-written file looks like. For an unsplit line the two are the same value anyway; for a
	// split one this is the only way to answer at all, and taking the first part is what the column
	// exists to avoid — so a blank cell degrades visibly rather than silently.
	const parentRaw = (record.categorie_parent ?? '').trim();
	const parentCategory = parentRaw ? resolveV2Category(parentRaw) : category;
	if (!parentCategory.ok) {
		addInvalidRow(errors, invalidRows, line, parentCategory.reason, 'category');
		return null;
	}

	const amountCents = parseSignedAmount(record.montant ?? '');
	if (amountCents === null) {
		addInvalidRow(errors, invalidRows, line, 'montant invalide', 'amount');
		return null;
	}
	const totalCents = parseSignedAmount(record.montant_total ?? '');
	if (totalCents === null) {
		addInvalidRow(errors, invalidRows, line, 'montant total invalide', 'amount');
		return null;
	}

	const type: ImportedTransactionType = amountCents >= 0 ? 'income' : 'expense';
	const rawType = (record.type ?? '').trim().toLowerCase();
	if (rawType !== type) {
		addInvalidRow(errors, invalidRows, line, 'type et signe du montant incohérents', 'type');
		return null;
	}

	const rawNature = (record.nature ?? '').trim();
	let natureManual: TransactionNature | null = null;
	if (rawNature) {
		if (!isTransactionNature(rawNature)) {
			addInvalidRow(errors, invalidRows, line, 'nature invalide', 'nature');
			return null;
		}
		natureManual = rawNature;
	}

	const part = PART_PATTERN.exec((record.part ?? '').trim());
	if (!part) {
		addInvalidRow(errors, invalidRows, line, 'colonne part illisible', 'part');
		return null;
	}
	const index = Number(part[1]);
	const count = Number(part[2]);
	if (index < 1 || count < 1 || index > count || count > MAX_SPLITS_PER_TRANSACTION) {
		addInvalidRow(errors, invalidRows, line, 'répartition hors bornes', 'part');
		return null;
	}

	return {
		line,
		date,
		label,
		category: category.value,
		parentCategory: parentCategory.value,
		amountCents,
		totalCents,
		type,
		natureManual,
		index,
		count
	};
}

/** `null` when the group is sound; otherwise the single reason a user is shown for it. */
function validateGroupShape(group: AllocationLine[]): { reason: string; field: string } | null {
	const count = group[0].count;
	if (group.some((part) => part.count !== count)) {
		return { reason: 'répartition incohérente entre les lignes', field: 'part' };
	}
	// Two directions, two sentences, and the pair is ORDERED. Found by break-checking: deleting the
	// length test left the file still refused — by the index test below, since a missing line also
	// shrinks the set — but under the reason « positions en double », which is simply not what
	// happened. And the index test alone cannot see a group with one line too MANY whose indices
	// happen to repeat (1, 2, 2 against a stated 2), because the set is then exactly the right size.
	// So each check earns its place only with the other in front of it: once the count is known to
	// match, a short set can mean nothing but a duplicate.
	if (group.length < count) {
		return { reason: 'répartition incomplète', field: 'part' };
	}
	if (group.length > count) {
		return { reason: 'lignes de répartition en trop', field: 'part' };
	}
	if (new Set(group.map((part) => part.index)).size !== count) {
		return { reason: 'positions de répartition en double', field: 'part' };
	}
	if (new Set(group.map((part) => part.parentCategory)).size !== 1) {
		return { reason: 'catégorie parente incohérente entre les lignes', field: 'category' };
	}
	// OD-5: no part may carry the sentinel — money allocated to « à classer » is money that is
	// categorised and uncategorised at once, and a répartie transaction is excluded from the one
	// screen built to find uncategorised money. The PARENT may hold it (that is an ordinary row in
	// the pile), which is why this is asymmetric and why it is checked here rather than on the line.
	// `replaceSplits` refuses it too; without this the refusal would arrive with no line number,
	// after the parent row had already been inserted.
	if (group.length > 1 && group.some((part) => part.category === UNCLASSIFIED_CATEGORY)) {
		return { reason: 'catégorie réservée refusée sur une part', field: 'category' };
	}

	const total = group[0].totalCents;
	if (total === 0) return { reason: 'montant à zéro refusé', field: 'amount' };
	if (group.some((part) => part.amountCents === 0)) {
		return { reason: 'montant à zéro refusé', field: 'amount' };
	}
	// Same sign as the parent, for the same reason `replaceSplits` refuses the opposite one: a part
	// pointing the other way is a refund or a transfer, not an allocation, and no per-category total
	// can interpret it. Checked here too so the refusal carries a line number.
	if (group.some((part) => part.amountCents > 0 !== total > 0)) {
		return { reason: 'part de signe opposé au total', field: 'amount' };
	}
	if (group.reduce((sum, part) => sum + part.amountCents, 0) !== total) {
		return { reason: 'les parts ne totalisent pas le montant', field: 'amount' };
	}

	return null;
}

function parseSignedAmount(raw: string): number | null {
	// The export prefixes a leading apostrophe onto anything a spreadsheet would evaluate, which
	// every negative amount is. v1 strips it in the same place and for the same reason.
	const amountCents = parseAmountCents(raw.trim().replace(/^'/, ''));
	if (amountCents === null || amountCents === 0) return null;
	return amountCents;
}

function resolveV2Category(
	rawValue: string
): { ok: true; value: string } | { ok: false; reason: string } {
	const sanitized = sanitizeImportedText(rawValue);
	if (!sanitized) return { ok: true, value: UNCLASSIFIED_CATEGORY };
	if (sanitized.length > MAX_CATEGORY_LENGTH) return { ok: false, reason: 'catégorie trop longue' };
	// Accepted rather than refused, exactly as in v1 and for the same reason: it is what the export
	// writes for every row in the « à classer » pile.
	return { ok: true, value: sanitized };
}

function emptyV2Result(errors: string[], warnings: string[]): CsvImportResult {
	return {
		transactions: [],
		errors,
		warnings,
		invalidRows: errors.map((reason, index) => ({ line: index + 1, reason })),
		summary: buildSummary({
			profile: 'maison',
			totalRows: 0,
			validRows: 0,
			invalidRows: errors.length,
			duplicateRows: 0,
			totalDebitCents: 0,
			totalCreditCents: 0,
			dates: []
		})
	};
}
