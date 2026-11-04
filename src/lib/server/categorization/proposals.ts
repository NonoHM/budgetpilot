import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { isRuleTargetLive, toCategoryNameKeys } from '$lib/server/categories/references';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';
import { logReferenceRefused } from '$lib/server/logging/authz';
import {
	buildCategoryNatureMap,
	getEffectiveCategory,
	getEffectiveTransactionNature,
	isUncategorizedByCategory,
	EFFECTIVE_CATEGORY_SELECT
} from '$lib/server/transactions/nature';
import { resolveTransactionType } from '$lib/server/transactions/totals';
import { normalizeId, resolveUncategorizedCategoryId } from '$lib/server/transactions/where';
import { isTransactionNature, type TransactionNature } from '$lib/domain/transaction';
import { suggestFromHistory, type HistoryIndex } from '$lib/domain/historySuggestion';
import { findMatchingCategoryRule } from './rules';
import { loadMemberHistory } from './history';

export type Proposal = {
	category: string;
	nature: TransactionNature | null;
	source: 'rule' | 'history';
};

type ProposalRule = {
	id?: string;
	name: string;
	matchText: string;
	targetCategory: string;
	targetNature?: TransactionNature | null;
	enabled: boolean;
};

/** Everything `computeSuggestion` reads besides the row, loaded the same way for the page and the accept. */
export type ProposalContext = {
	rules: ProposalRule[];
	history: HistoryIndex;
	mappingMap: Map<string, TransactionNature>;
};

/**
 * The member's live rules in the order `applyCategoryRules` reads them, `id` breaking a
 * `createdAt` tie: the page and the accept must find the same first match, or an accept reports
 * « changed since » for a row nobody changed (note pass 1230-note-1).
 *
 * #161: a rule whose target no longer resolves to a Category is paused, and proposing it would be
 * a promise `applyCategoryRules` refuses to keep.
 */
export async function loadProposalRules(
	userId: string,
	categories: Array<{ name: string }>
): Promise<ProposalRule[]> {
	const candidateRules = await prisma.categoryRule.findMany({
		where: { userId, enabled: true },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
		select: {
			id: true,
			name: true,
			matchText: true,
			targetCategory: true,
			targetNature: true,
			isRegex: true,
			enabled: true
		}
	});
	const categoryNameKeys = toCategoryNameKeys(categories);
	return candidateRules.filter((rule) => isRuleTargetLive(rule.targetCategory, categoryNameKeys));
}

/**
 * The one place a category is proposed for a row, for the list, the selected row and the accept.
 *
 * Only on a row with no pin at all and no parts, that is to classify by nature, or by category
 * (the pile) when the member set no nature by hand. The pile clause is #1014's: no seed maps the
 * sentinel, so a pile row with no manual nature falls back to spending or income by kind, and a
 * gate on nature alone proposed nothing on such a row. `acceptSuggestion` refuses a proposal on a
 * row pinned since, which is the same « no pin » condition.
 *
 * The member's rules first, then their own history. A history proposal carries no nature: the
 * category's mapping decides it, as it does for a category the member picks by hand.
 */
export function computeSuggestion(
	transaction: {
		label: string;
		manualCategory: string | null;
		natureManual: TransactionNature | null;
		category: { name: string } | null;
		splits: readonly unknown[];
	},
	nature: TransactionNature,
	rules: ProposalRule[],
	history: HistoryIndex,
	mappingMap: Map<string, TransactionNature>
): Proposal | null {
	// `=== null`, the accept's own predicate: an empty pin a restore can write is a pin for both.
	// A split row is classified by its parts, and the accept refuses it.
	if (transaction.manualCategory !== null || transaction.splits.length > 0) return null;
	// The pile clause only where the member set no nature by hand: accepting writes the
	// proposal's nature, which would replace theirs (code pass 1, B 7a).
	const inPile = transaction.natureManual === null && isUncategorizedByCategory(transaction);
	if (nature !== 'uncategorized' && !inPile) return null;
	const matched = findMatchingCategoryRule(transaction, rules);
	if (matched) {
		const cat = matched.targetCategory;
		return {
			category: cat,
			nature: matched.targetNature ?? mappingMap.get(cat) ?? null,
			source: 'rule'
		};
	}
	const fromHistory = suggestFromHistory(history, transaction.label);
	return fromHistory ? { category: fromHistory, nature: null, source: 'history' } : null;
}

/** One « Accept all » posts at most one page of the list, which is this many rows. */
export const MAX_ACCEPT_ALL_ROWS = 25;

/** What the page showed on one row, as it posts it back. */
export type ShownProposal = { id: string; category: string; nature: TransactionNature | null };

/**
 * One row an accept changed, enough to undo it exactly: the pin was « none » before (the proposal
 * gate), so the record carries what was written, who it was written as, and the nature replaced.
 */
export type AcceptedRow = {
	id: string;
	category: string;
	by: 'acceptedSuggestion' | 'member';
	nature: TransactionNature | null;
	previousNature: TransactionNature | null;
};

const MAX_CATEGORY_LENGTH = 60;

function isNatureOrNull(value: unknown): value is TransactionNature | null {
	return value === null || (typeof value === 'string' && isTransactionNature(value));
}

function isCategoryText(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_CATEGORY_LENGTH;
}

/**
 * A list of at most one page, each id once, every field from a closed shape. `null` for anything
 * else, so the action refuses the request whole rather than acting on a part of it.
 */
function parseList<T extends { id: string }>(
	raw: string,
	isEntry: (value: Record<string, unknown>) => boolean
): T[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ACCEPT_ALL_ROWS)
		return null;
	const ids = new Set<string>();
	for (const entry of parsed) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
		const record = entry as Record<string, unknown>;
		if (typeof record.id !== 'string' || normalizeId(record.id) !== record.id || ids.has(record.id))
			return null;
		if (!isEntry(record)) return null;
		ids.add(record.id);
	}
	return parsed as T[];
}

export function parseShownProposals(raw: string): ShownProposal[] | null {
	return parseList<ShownProposal>(
		raw,
		(r) => Object.keys(r).length === 3 && isCategoryText(r.category) && isNatureOrNull(r.nature)
	);
}

export function parseUndoRecord(raw: string): AcceptedRow[] | null {
	return parseList<AcceptedRow>(
		raw,
		(r) =>
			Object.keys(r).length === 5 &&
			isCategoryText(r.category) &&
			(r.by === 'acceptedSuggestion' || r.by === 'member') &&
			isNatureOrNull(r.nature) &&
			isNatureOrNull(r.previousNature)
	);
}

class NotFound extends Error {}

export type AcceptAllResult =
	{ ok: true; accepted: AcceptedRow[]; changedSince: number } | { ok: false; reason: 'not-found' };

/**
 * « Accept all » over the proposals the page showed (#1230). The server recomputes each row's
 * proposal and writes it only where it is still the one shown, category key and nature: the page
 * names rows, never what to write (AISVS 1.0 C9.2.1: the member approved what they saw). Every id
 * resolves under `userId` in the same where; one that does not refuses the whole list, nothing
 * written. All writes are one transaction (ASVS v5.0.0-2.3.3), and each repeats the state it read,
 * so a row changed meanwhile is skipped and counted rather than overwritten.
 */
export async function acceptShownProposals(
	userId: string,
	shown: ShownProposal[]
): Promise<AcceptAllResult> {
	const categories = await prisma.category.findMany({
		where: { userId },
		select: { id: true, name: true }
	});
	const [rules, uncategorizedCategoryId, mappings] = await Promise.all([
		loadProposalRules(userId, categories),
		resolveUncategorizedCategoryId(userId),
		prisma.categoryNatureMapping.findMany({
			where: { userId },
			select: { categoryName: true, nature: true }
		})
	]);
	const history = await loadMemberHistory(userId, categories, uncategorizedCategoryId);
	const mappingMap = buildCategoryNatureMap(mappings);

	try {
		return await prisma.$transaction(async (tx) => {
			const rows = await tx.transaction.findMany({
				where: { userId, id: { in: shown.map((row) => row.id) } },
				select: {
					id: true,
					label: true,
					amountCents: true,
					type: true,
					natureManual: true,
					...EFFECTIVE_CATEGORY_SELECT
				}
			});
			if (rows.length !== shown.length) throw new NotFound();
			const byId = new Map(rows.map((row) => [row.id, row]));

			const accepted: AcceptedRow[] = [];
			for (const { id, category, nature } of shown) {
				const row = byId.get(id)!;
				const effective = getEffectiveTransactionNature(
					{
						amountCents: row.amountCents,
						type: resolveTransactionType(row),
						category: getEffectiveCategory(row),
						natureManual: row.natureManual
					},
					mappingMap
				);
				const proposal = computeSuggestion(row, effective.nature, rules, history, mappingMap);
				if (
					!proposal ||
					computeNameKey(proposal.category) !== computeNameKey(category) ||
					proposal.nature !== nature
				)
					continue;
				const written = await tx.transaction.updateMany({
					where: {
						id,
						userId,
						manualCategory: null,
						splits: { none: {} },
						natureManual: row.natureManual
					},
					data: {
						...manualCategoryUpdate(proposal.category, 'acceptedSuggestion'),
						natureManual: proposal.nature
					}
				});
				if (written.count === 1)
					accepted.push({
						id,
						category: proposal.category,
						by: 'acceptedSuggestion',
						nature: proposal.nature,
						previousNature: row.natureManual
					});
			}
			return { ok: true as const, accepted, changedSince: shown.length - accepted.length };
		});
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		logReferenceRefused(userId, 'transaction');
		return { ok: false, reason: 'not-found' };
	}
}

export type UndoResult =
	{ ok: true; undone: number; changedSince: number } | { ok: false; reason: 'not-found' };

/**
 * Restores exactly what an accept replaced, on exactly the rows it changed: no pin, and the nature
 * it read. A row is restored only while it still holds what the accept wrote (the category key,
 * that author stamped for that key, that nature) and has no parts, so a choice the member made
 * since, or a split the member's own editor would refuse to recategorise, is left and counted.
 * Idempotent: a second undo finds no row as written. Ownership as the accept: one foreign id
 * refuses the whole record. A forged record grants nothing `saveManualCategory` and
 * `saveManualNature` do not already allow on the member's own rows.
 */
export async function undoAcceptedRows(userId: string, record: AcceptedRow[]): Promise<UndoResult> {
	try {
		return await prisma.$transaction(async (tx) => {
			const owned = await tx.transaction.count({
				where: { userId, id: { in: record.map((row) => row.id) } }
			});
			if (owned !== record.length) throw new NotFound();
			let undone = 0;
			for (const row of record) {
				const key = computeNameKey(row.category);
				const restored = await tx.transaction.updateMany({
					where: {
						id: row.id,
						userId,
						manualCategoryKey: key,
						manualCategorySource: row.by,
						manualCategorySourceKey: key,
						natureManual: row.nature,
						splits: { none: {} }
					},
					data: { ...manualCategoryUpdate(null, null), natureManual: row.previousNature }
				});
				undone += restored.count;
			}
			return { ok: true as const, undone, changedSince: record.length - undone };
		});
	} catch (error) {
		if (!(error instanceof NotFound)) throw error;
		logReferenceRefused(userId, 'transaction');
		return { ok: false, reason: 'not-found' };
	}
}
