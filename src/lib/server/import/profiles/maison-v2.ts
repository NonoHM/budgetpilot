import { isTransactionNature, isValidIsoDate, validateTransaction } from '$lib/domain/transaction';
import type { TransactionNature } from '$lib/domain/transaction';
import { MAX_SPLITS_PER_TRANSACTION, MIN_SPLITS_PER_TRANSACTION } from '$lib/domain/allocation';
import type {
	CsvImportResult,
	CsvProfileParseInput,
	ImportedSplitPart,
	ImportedTransaction,
	ImportedTransactionType
} from '../types';
import type { CsvRefusal, CsvRefusalFact } from '../refusals';
import { addRefusal, buildSummary, emptyResult, normalizeDate, toRecord } from '../utils/csv';
import { parseAmountCents } from '../utils/money';
import {
	buildDeduplicationGroupKey,
	buildDeduplicationKey,
	hashFingerprint,
	refusalCellValue,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '../utils/safety';
import { createOccurrenceCounter } from '../occurrence';
import { foldExactHeader } from '../utils/encoding';

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
	const normalizedHeaders = headers.map(foldExactHeader);
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

export function parseMaisonV2Rows({ rows, warnings }: CsvProfileParseInput): CsvImportResult {
	const headers = rows[0].cells.map(foldExactHeader);

	if (!matchesMaisonV2Header(headers)) {
		return emptyResult(
			[{ code: 'header-not-recognized', profile: 'maison' }],
			warnings,
			'maison',
			// The rows the file has, like its three sibling profiles. A zero here was the same false
			// figure the row cap carried: a claim about the file rather than about the refusal.
			rows.length - 1
		);
	}

	const refusals: CsvRefusal[] = [];

	// Grouped in file order, so the first line of a group is the one a refusal is reported against —
	// the line the user's eye lands on when they open the file at the reported number.
	const groups = new Map<string, AllocationLine[]>();
	const groupOrder: string[] = [];
	// Lines refused before they could join a group. Counted here rather than derived from
	// `invalidRows` afterwards, so the summary's arithmetic is a tally rather than a guess.
	let ungroupableLines = 0;

	rows.slice(1).forEach((parsedRow) => {
		const parsed = parseAllocationLine(parsedRow.cells, headers, parsedRow.line, refusals);
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
	// One counter per parse, never shared between files: see occurrence.ts.
	const nextOccurrence = createOccurrenceCounter();
	// Kept at zero and still reported: within one file nothing is a duplicate any more, and
	// saying so in the summary is what stops a reader inferring the counter was forgotten.
	const duplicateRows = 0;
	let totalDebitCents = 0;
	let totalCreditCents = 0;
	const validDates: string[] = [];

	for (const key of groupOrder) {
		const group = (groups.get(key) as AllocationLine[]).slice().sort((a, b) => a.index - b.index);
		const line = group[0].line;

		const shape = validateGroupShape(group);
		if (shape) {
			addRefusal(refusals, { kind: 'row', line }, shape.fact, shape.field);
			continue;
		}

		const { date, label, totalCents, type, parentCategory } = group[0];
		// The ordinal is what makes two identical rows two transactions rather than one. The
		// in-file skip that used to sit here collapsed them and counted the second as a
		// duplicate, so a file carrying the same row twice imported one of them.
		// `dedupeGroup` rather than `group`: this file's `group` is the allocation group, a
		// different thing entirely, and one of them shadowing the other would read as the same
		// concept.
		const dedupeGroup = { date, label, amountCents: totalCents, type };
		const fingerprint = buildDeduplicationKey({
			...dedupeGroup,
			occurrence: nextOccurrence(buildDeduplicationGroupKey(dedupeGroup))
		});

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
			addRefusal(
				refusals,
				{ kind: 'row', line },
				{
					code: 'transaction-invalid',
					violations: validation.violations
				}
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
		warnings,
		invalidRows: refusals,
		summary: buildSummary({
			profile: 'maison',
			// TRANSACTIONS, not physical lines: a file of five répartitions is five things the user
			// asked to import, and a row count of twelve against five valid ones would read as seven
			// failures. Lines refused before a group could form have no group to be counted as, so
			// they are added back individually and the three tallies reconcile.
			totalRows: groupOrder.length + ungroupableLines,
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

function parseAllocationLine(
	row: string[],
	headers: string[],
	line: number,
	refusals: CsvRefusal[]
): AllocationLine | null {
	if (row.length !== headers.length) {
		addRefusal(
			refusals,
			{ kind: 'row', line },
			{ code: 'bad-column-count', expected: headers.length, actual: row.length },
			'colonnes'
		);
		return null;
	}

	const record = toRecord(headers, row);

	const date = normalizeDate(record.date ?? '');
	if (!isValidIsoDate(date)) {
		addRefusal(
			refusals,
			{ kind: 'row', line },
			{ code: 'invalid-date', column: 'date', value: refusalCellValue(record.date ?? '') },
			'date'
		);
		return null;
	}

	const label = sanitizeImportedText(record.libelle ?? '');

	const category = resolveV2Category(record.categorie ?? '');
	if (!category.ok) {
		addRefusal(refusals, { kind: 'row', line }, { code: 'category-too-long' }, 'category');
		return null;
	}

	// Falls back to the allocation's own category when the column is blank, which is what a
	// hand-written file looks like. For an unsplit line the two are the same value anyway; for a
	// split one this is the only way to answer at all, and taking the first part is what the column
	// exists to avoid — so a blank cell degrades visibly rather than silently.
	const parentRaw = (record.categorie_parent ?? '').trim();
	const parentCategory = parentRaw ? resolveV2Category(parentRaw) : category;
	if (!parentCategory.ok) {
		addRefusal(refusals, { kind: 'row', line }, { code: 'category-too-long' }, 'category');
		return null;
	}

	const amountCents = parseSignedAmount(record.montant ?? '');
	if (amountCents === null) {
		addRefusal(
			refusals,
			{ kind: 'row', line },
			{ code: 'invalid-amount', column: 'montant' },
			'amount'
		);
		return null;
	}
	const totalCents = parseSignedAmount(record.montant_total ?? '');
	if (totalCents === null) {
		addRefusal(
			refusals,
			{ kind: 'row', line },
			{ code: 'invalid-total-amount', column: 'montant_total' },
			'amount'
		);
		return null;
	}

	const type: ImportedTransactionType = amountCents >= 0 ? 'income' : 'expense';
	const rawType = (record.type ?? '').trim().toLowerCase();
	if (rawType !== type) {
		addRefusal(refusals, { kind: 'row', line }, { code: 'type-amount-mismatch' }, 'type');
		return null;
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
			return null;
		}
		natureManual = rawNature;
	}

	const part = PART_PATTERN.exec((record.part ?? '').trim());
	if (!part) {
		addRefusal(refusals, { kind: 'row', line }, { code: 'split-column-unreadable' }, 'part');
		return null;
	}
	const index = Number(part[1]);
	const count = Number(part[2]);
	if (index < 1 || count < 1 || index > count || count > MAX_SPLITS_PER_TRANSACTION) {
		addRefusal(refusals, { kind: 'row', line }, { code: 'split-out-of-bounds' }, 'part');
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

/** `null` when the group is sound; otherwise the single fact a user is shown for it. */
function validateGroupShape(
	group: AllocationLine[]
): { fact: CsvRefusalFact; field: string } | null {
	const count = group[0].count;
	if (group.some((part) => part.count !== count)) {
		return { fact: { code: 'split-inconsistent' }, field: 'part' };
	}
	// Two directions, two facts, and the pair is ORDERED. Found by break-checking: deleting the
	// length test left the file still refused — by the index test below, since a missing line also
	// shrinks the set — but under the fact `split-duplicate-positions`, which is simply not what
	// happened. And the index test alone cannot see a group with one line too MANY whose indices
	// happen to repeat (1, 2, 2 against a stated 2), because the set is then exactly the right size.
	// So each check earns its place only with the other in front of it: once the count is known to
	// match, a short set can mean nothing but a duplicate.
	if (group.length < count) {
		return { fact: { code: 'split-incomplete' }, field: 'part' };
	}
	if (group.length > count) {
		return { fact: { code: 'split-too-many-lines' }, field: 'part' };
	}
	if (new Set(group.map((part) => part.index)).size !== count) {
		return { fact: { code: 'split-duplicate-positions' }, field: 'part' };
	}
	if (new Set(group.map((part) => part.parentCategory)).size !== 1) {
		return { fact: { code: 'split-parent-category-inconsistent' }, field: 'category' };
	}
	// OD-5: no part may carry the sentinel — money allocated to « à classer » is money that is
	// categorised and uncategorised at once, and a répartie transaction is excluded from the one
	// screen built to find uncategorised money. The PARENT may hold it (that is an ordinary row in
	// the pile), which is why this is asymmetric and why it is checked here rather than on the line.
	// `replaceSplits` refuses it too; without this the refusal would arrive with no line number,
	// after the parent row had already been inserted.
	if (group.length > 1 && group.some((part) => part.category === UNCLASSIFIED_CATEGORY)) {
		return { fact: { code: 'split-reserved-category-on-part' }, field: 'category' };
	}

	// BOTH OF THE NEXT TWO BRANCHES ARE UNREACHABLE TODAY, and they are left in place on purpose:
	// see #303. `parseSignedAmount` is the only source of `amountCents` and `totalCents`, it folds
	// its zero check into its `null` return, and both call sites (:255, :265) refuse a `null` before
	// the line can join a group. So no group can contain a zero, and a zero amount is reported to
	// the user as « montant invalide » rather than as the zero it is. That sentence is false, and
	// `maison` v1 does say the right thing for the same input, which is the divergence #303 tracks.
	// Deleting these would treat the symptom: the fix is upstream, in `parseSignedAmount`, and it
	// changes a user-visible string, which is why it is not in the refusal-contract PR.
	const total = group[0].totalCents;
	if (total === 0) return { fact: { code: 'zero-amount', column: 'montant' }, field: 'amount' };
	if (group.some((part) => part.amountCents === 0)) {
		return { fact: { code: 'zero-amount', column: 'montant' }, field: 'amount' };
	}
	// Same sign as the parent, for the same reason `replaceSplits` refuses the opposite one: a part
	// pointing the other way is a refund or a transfer, not an allocation, and no per-category total
	// can interpret it. Checked here too so the refusal carries a line number.
	if (group.some((part) => part.amountCents > 0 !== total > 0)) {
		return { fact: { code: 'split-sign-opposite' }, field: 'amount' };
	}
	if (group.reduce((sum, part) => sum + part.amountCents, 0) !== total) {
		return { fact: { code: 'split-sum-mismatch' }, field: 'amount' };
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

function resolveV2Category(rawValue: string): { ok: true; value: string } | { ok: false } {
	const sanitized = sanitizeImportedText(rawValue);
	if (!sanitized) return { ok: true, value: UNCLASSIFIED_CATEGORY };
	if (sanitized.length > MAX_CATEGORY_LENGTH) return { ok: false };
	// Accepted rather than refused, exactly as in v1 and for the same reason: it is what the export
	// writes for every row in the « à classer » pile.
	return { ok: true, value: sanitized };
}
