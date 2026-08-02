import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	TRANSACTION_NATURES,
	type TransactionNature,
	isTransactionNature
} from '$lib/domain/transaction';
import { resolveTransactionType } from '$lib/server/transactions/totals';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';
import {
	findMatchingCategoryRule,
	applyCategoryRules,
	parseCategoryRuleInput
} from '$lib/server/categorization/rules';
import {
	buildCategoryNatureMap,
	getEffectiveCategory,
	getEffectiveTransactionNature
} from '$lib/server/transactions/nature';
import {
	buildTransactionWhere,
	normalizeId,
	normalizeIdList,
	normalizeSearch,
	parseTransactionDateRange,
	parseTransactionFilter,
	resolveUncategorizedCategoryId
} from '$lib/server/transactions/where';
import {
	collectTransactionsMatchingQuery,
	isValidRegexQuery,
	parseQueryMode
} from '$lib/server/transactions/search';
import {
	anonymizeDetailText,
	anonymizeReference,
	truncateText
} from '$lib/server/transactions/anonymize';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 25;
const MAX_MANUAL_CATEGORY_LENGTH = 60;
const MAX_MANUAL_NATURE_LENGTH = 32;
// Defensive cap on the Focus mode stack (see forEachTransactionBatch/rawForClassify removal in
// CLAUDE.md technical debt): ids only, so memory cost is negligible even at the cap, but an
// unbounded findMany on a pathological "everything uncategorized" history is still avoided.
const FOCUS_STACK_CAP = 5000;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const page = parsePositiveInteger(url.searchParams.get('page')) ?? 1;
	const query = normalizeSearch(url.searchParams.get('q'));
	const qMode = parseQueryMode(url.searchParams.get('qMode'));
	const type = parseTransactionFilter(url.searchParams.get('type'));
	const category = normalizeSearch(url.searchParams.get('category'));
	const fromParam = url.searchParams.get('from');
	const toParam = url.searchParams.get('to');
	const { range: dateRange, error: dateRangeError } = parseTransactionDateRange(fromParam, toParam);
	// Raw values (not dateRange.fromDate/toDate) so the "Du"/"Au" inputs keep showing exactly
	// what the user typed when the pair is incomplete/invalid, instead of clearing on error.
	const fromDisplay = (fromParam ?? '').trim();
	const toDisplay = (toParam ?? '').trim();
	const importBatchId = normalizeId(url.searchParams.get('importBatch'));
	const selectedId = normalizeId(url.searchParams.get('selected'));
	// Explicit id whitelist. Deliberately NOT applied to `uncategorizedPileWhere` below: the
	// "à classer" pile is global by design (see its comment), not a view of the current filters.
	const ids = normalizeIdList(url.searchParams.get('ids'));

	const [categories, mappings, selectedTransaction, rules, uncategorizedCategoryId] =
		await Promise.all([
			prisma.category.findMany({
				where: { userId: user.id },
				orderBy: { name: 'asc' },
				select: { name: true, defaultKey: true }
			}),
			prisma.categoryNatureMapping.findMany({
				where: { userId: user.id },
				orderBy: { categoryName: 'asc' },
				select: { categoryName: true, nature: true }
			}),
			selectedId
				? prisma.transaction.findFirst({
						where: { id: selectedId, userId: user.id },
						select: {
							id: true,
							date: true,
							label: true,
							amountCents: true,
							type: true,
							source: true,
							notes: true,
							bankOperationType: true,
							manualCategory: true,
							natureManual: true,
							dedupeKey: true,
							metadataJson: true,
							createdAt: true,
							updatedAt: true,
							category: { select: { name: true } },
							account: {
								select: {
									name: true,
									source: true,
									netWorthAccount: { select: { name: true } }
								}
							},
							importBatch: {
								select: { id: true, fileName: true, source: true, rowCount: true, createdAt: true }
							}
						}
					})
				: Promise.resolve(null),
			prisma.categoryRule.findMany({
				where: { userId: user.id, enabled: true },
				orderBy: { createdAt: 'asc' },
				select: {
					id: true,
					name: true,
					matchText: true,
					targetCategory: true,
					targetNature: true,
					isRegex: true,
					enabled: true
				}
			}),
			resolveUncategorizedCategoryId(user.id)
		]);

	const mappingMap = buildCategoryNatureMap(mappings);

	// "To classify" pile: independent of the current tab/filters (see classifyStackIds comment
	// below) — always the global uncategorized-by-category set, computed in SQL instead of
	// scanning every transaction into memory (see CLAUDE.md technical debt on rawForClassify).
	const uncategorizedPileWhere = buildTransactionWhere({
		userId: user.id,
		type: 'classify',
		category: '',
		importBatchId: '',
		uncategorizedCategoryId
	});

	const [uncategorizedCount, classifyStackRows] = await Promise.all([
		prisma.transaction.count({ where: uncategorizedPileWhere }),
		prisma.transaction.findMany({
			where: uncategorizedPileWhere,
			select: { id: true, label: true, manualCategory: true },
			orderBy: [{ date: 'desc' }, { id: 'desc' }],
			take: FOCUS_STACK_CAP
		})
	]);
	const classifyStackIds = classifyStackRows.map((t) => t.id);
	// Matching needs JS (accent-insensitive/regex), so it can't be pushed into SQL — but it's
	// scoped to the already-fetched, FOCUS_STACK_CAP-bounded stack (not a separate unbounded scan
	// over the whole pile): the "accept all" button only ever acts on that same stack anyway.
	const classifiableCount = classifyStackRows.filter(
		(row) =>
			findMatchingCategoryRule({ label: row.label, manualCategory: row.manualCategory }, rules) !==
			null
	).length;

	let selectedSuggestion: {
		category: string;
		nature: TransactionNature | null;
		source: 'rule';
	} | null = null;
	if (selectedTransaction && type === 'classify') {
		const selCat = selectedTransaction.manualCategory ?? selectedTransaction.category.name;
		const selNat = getEffectiveTransactionNature(
			{
				amountCents: selectedTransaction.amountCents,
				type: resolveTransactionType(selectedTransaction),
				category: selCat,
				natureManual: selectedTransaction.natureManual
			},
			mappingMap
		);
		if (selNat.nature === 'uncategorized') {
			selectedSuggestion = computeSuggestion(
				{ label: selectedTransaction.label, manualCategory: selectedTransaction.manualCategory },
				rules,
				mappingMap
			);
		}
	}

	const where = buildTransactionWhere({
		userId: user.id,
		type,
		category,
		from: dateRange?.from,
		to: dateRange?.to,
		importBatchId,
		uncategorizedCategoryId,
		ids
	});

	const transactionSelect = {
		id: true,
		date: true,
		label: true,
		amountCents: true,
		type: true,
		source: true,
		manualCategory: true,
		natureManual: true,
		category: { select: { name: true } }
	} as const;

	interface TransactionListRow {
		id: string;
		date: Date;
		label: string;
		amountCents: number;
		type: string | null;
		source: string;
		manualCategory: string | null;
		natureManual: TransactionNature | null;
		category: { name: string };
	}

	const queryError = Boolean(query) && qMode === 'regex' && !isValidRegexQuery(query);

	let totalTransactions: number;
	let safePage: number;
	let totalPages: number;
	let transactions: TransactionListRow[];

	if (queryError || dateRangeError) {
		totalTransactions = 0;
		totalPages = 1;
		safePage = 1;
		transactions = [];
	} else if (!query) {
		totalTransactions = await prisma.transaction.count({ where });
		totalPages = Math.max(1, Math.ceil(totalTransactions / PAGE_SIZE));
		safePage = Math.min(page, totalPages);
		transactions = await prisma.transaction.findMany({
			where,
			select: transactionSelect,
			orderBy: { date: 'desc' },
			skip: (safePage - 1) * PAGE_SIZE,
			take: PAGE_SIZE
		});
	} else {
		const filtered = await collectTransactionsMatchingQuery(where, transactionSelect, query, qMode);
		totalTransactions = filtered.length;
		totalPages = Math.max(1, Math.ceil(totalTransactions / PAGE_SIZE));
		safePage = Math.min(page, totalPages);
		transactions = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
	}

	return {
		transactions: transactions.map((t) => mapTransactionListItem(t, mappingMap, rules)),
		selectedTransaction: selectedTransaction
			? mapTransactionDetail(selectedTransaction, mappingMap)
			: null,
		selectedSuggestion,
		categoryOptions: buildCategoryOptions(categories),
		categories,
		natureOptions: TRANSACTION_NATURES,
		filters: {
			q: query,
			qMode,
			type,
			category,
			from: fromDisplay,
			to: toDisplay,
			importBatchId,
			// Re-serialized from the PARSED list, never echoed from the raw param: what the page
			// carries forward through pagination is exactly what the query ran on.
			//
			// This DELIBERATELY collapses the absent-vs-empty distinction the load itself preserves
			// (`null` = no filter, `[]` = match nothing) into one `''`. Sound only because `[]`
			// returns zero rows, and with zero rows there is no pagination control and no row link
			// to carry anything forward — the two cases have no observable difference here. A
			// future consumer of `filters.ids` that runs when the list is empty must not assume it.
			ids: ids ? ids.join(',') : ''
		},
		queryError,
		dateRangeError,
		pagination: {
			page: safePage,
			pageSize: PAGE_SIZE,
			totalTransactions,
			totalPages,
			hasPrevious: safePage > 1,
			hasNext: safePage < totalPages
		},
		uncategorizedCount,
		classifiableCount,
		// Always exposed (not gated by `type === 'classify'` like `selectedSuggestion`): the
		// "Mode focus" button lives in the banner shown on every tab, so it needs the full stack
		// to jump to the first uncategorized id regardless of the tab the user is currently on.
		classifyStackIds
	};
};

function computeSuggestion(
	transaction: { label: string; manualCategory: string | null },
	rules: Array<{
		id?: string;
		name: string;
		matchText: string;
		targetCategory: string;
		targetNature?: TransactionNature | null;
		enabled: boolean;
	}>,
	mappingMap: Map<string, TransactionNature>
): { category: string; nature: TransactionNature | null; source: 'rule' } | null {
	const matched = findMatchingCategoryRule(transaction, rules);
	if (!matched) return null;
	const cat = matched.targetCategory;
	const nature = matched.targetNature ?? mappingMap.get(cat) ?? null;
	return { category: cat, nature, source: 'rule' };
}

function buildCategoryOptions(categories: Array<{ name: string }>): string[] {
	return categories.map((c) => c.name).sort((left, right) => left.localeCompare(right, 'fr'));
}

export const actions: Actions = {
	saveManualCategory: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const transactionId = normalizeId(getFormValue(formData, 'transactionId'));
		const categoryResult = parseManualCategory(getFormValue(formData, 'manualCategory'));

		if (!transactionId)
			return fail(400, { manualCategoryError: m.transactions_error_invalid_transaction() });
		if (!categoryResult.ok) return fail(400, { manualCategoryError: categoryResult.error });

		if (categoryResult.value) {
			const cat = await prisma.category.findFirst({
				where: { userId: user.id, nameKey: computeNameKey(categoryResult.value) }
			});
			if (!cat) return fail(400, { manualCategoryError: m.categories_error_invalid() });
		}

		const result = await prisma.transaction.updateMany({
			where: { id: transactionId, userId: user.id },
			data: manualCategoryUpdate(categoryResult.value)
		});

		if (result.count === 0)
			return fail(404, { manualCategoryError: m.transactions_error_transaction_not_found() });
		return { manualCategorySuccess: true };
	},

	saveManualNature: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const transactionId = normalizeId(getFormValue(formData, 'transactionId'));
		const natureResult = parseManualNature(getFormValue(formData, 'manualNature'));

		if (!transactionId)
			return fail(400, { manualNatureError: m.transactions_error_invalid_transaction() });
		if (!natureResult.ok) return fail(400, { manualNatureError: natureResult.error });

		const result = await prisma.transaction.updateMany({
			where: { id: transactionId, userId: user.id },
			data: { natureManual: natureResult.value }
		});
		if (result.count === 0)
			return fail(404, { manualNatureError: m.transactions_error_transaction_not_found() });
		return { manualNatureSuccess: true };
	},

	acceptSuggestion: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const transactionId = normalizeId(getFormValue(formData, 'transactionId'));
		const rawCategory = getFormValue(formData, 'category');
		const rawNature = getFormValue(formData, 'nature');

		if (!transactionId)
			return fail(400, { acceptError: m.transactions_error_invalid_transaction() });

		const categoryResult = parseManualCategory(rawCategory);
		if (!categoryResult.ok) return fail(400, { acceptError: categoryResult.error });
		if (!categoryResult.value)
			return fail(400, { acceptError: m.transactions_error_category_required() });

		const cat = await prisma.category.findFirst({
			where: { userId: user.id, nameKey: computeNameKey(categoryResult.value) }
		});
		if (!cat) return fail(400, { acceptError: m.categories_error_invalid() });

		const natureResult = rawNature.trim()
			? parseManualNature(rawNature)
			: { ok: true as const, value: null };
		if (!natureResult.ok) return fail(400, { acceptError: natureResult.error });

		const result = await prisma.transaction.updateMany({
			where: { id: transactionId, userId: user.id },
			data: {
				...manualCategoryUpdate(categoryResult.value),
				natureManual: natureResult.value
			}
		});
		if (result.count === 0)
			return fail(404, { acceptError: m.transactions_error_transaction_not_found() });
		return { acceptSuccess: true };
	},

	classifyAll: async ({ locals }) => {
		const user = requireUser(locals.user);
		// Scopes applyCategoryRules to the "à classer" pile directly by categoryId (its own
		// `manualCategory: null` filter already excludes the other classify-pile branch —
		// manualCategory === UNCLASSIFIED_CATEGORY — same as before this refactor) instead of
		// pre-loading every pile id into memory just to pass them back as `id: { in: [...] }`.
		const uncategorizedCategoryId = await resolveUncategorizedCategoryId(user.id);
		// Fail-closed like buildTransactionWhere's own sentinel (where.ts): an unresolved category
		// must degrade to "match nothing", never to "no categoryId filter at all" (which would
		// widen the scope to every manualCategory:null transaction, not just the pile).
		const updated = await applyCategoryRules(user.id, {
			categoryId: uncategorizedCategoryId ?? '__none__'
		});
		return { classifyAllSuccess: true, updated };
	},

	deleteTransaction: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const transactionId = normalizeId(getFormValue(formData, 'transactionId'));

		if (!transactionId)
			return fail(400, { deleteError: m.transactions_error_invalid_transaction() });

		const result = await prisma.transaction.deleteMany({
			where: { id: transactionId, userId: user.id }
		});

		if (result.count === 0)
			return fail(404, { deleteError: m.transactions_error_transaction_not_found() });
		return { deleteSuccess: true };
	},

	createRule: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const parsed = parseCategoryRuleInput({
			name: getFormValue(formData, 'name'),
			matchText: getFormValue(formData, 'matchText'),
			targetCategory: getFormValue(formData, 'targetCategory'),
			targetNature: getFormValue(formData, 'targetNature'),
			enabled: true
		});

		if (!parsed.ok) return fail(400, { createRuleError: parsed.error });

		const createdRule = await prisma.categoryRule.create({
			data: { userId: user.id, ...parsed.value }
		});

		// Focus mode (optional, see createRuleInFocusMode in +page.svelte): as soon as a rule is
		// created, it automatically classifies ALL REMAINING items in the current session's frozen
		// pile that match it — wherever they are in the pile, not just the next consecutive ones
		// (two non-contiguous matches, e.g. positions 5 and 30 out of 43, are both applied; the
		// counter can therefore jump non-contiguously). ONLY against the rule that was just created —
		// never other already-active rules (those only apply on import or via "Apply rules"/
		// classifyAll, which remain the only mechanisms touching the full history). Reuses
		// findMatchingCategoryRule as-is, no new matching logic.
		const focusRemainingIds = formData
			.getAll('focusRemainingIds')
			.map((value) => normalizeId(String(value)))
			.filter((id): id is string => id.length > 0);

		if (focusRemainingIds.length === 0) return { createRuleSuccess: true };

		const candidates = await prisma.transaction.findMany({
			where: { userId: user.id, id: { in: focusRemainingIds }, manualCategory: null },
			select: { id: true, label: true, manualCategory: true }
		});
		const candidateById = new Map(candidates.map((t) => [t.id, t]));

		const autoAppliedIds: string[] = [];
		for (const id of focusRemainingIds) {
			const candidate = candidateById.get(id);
			if (!candidate) continue;
			if (!findMatchingCategoryRule(candidate, [createdRule])) continue;
			autoAppliedIds.push(id);
		}

		if (autoAppliedIds.length > 0) {
			await prisma.transaction.updateMany({
				where: { id: { in: autoAppliedIds }, userId: user.id, manualCategory: null },
				data: {
					...manualCategoryUpdate(createdRule.targetCategory),
					...(createdRule.targetNature ? { natureManual: createdRule.targetNature } : {})
				}
			});
		}

		return { createRuleSuccess: true, autoAppliedIds };
	}
};

function mapTransactionListItem(
	transaction: {
		id: string;
		date: Date;
		label: string;
		amountCents: number;
		type: string | null;
		source: string;
		manualCategory: string | null;
		natureManual: TransactionNature | null;
		category: { name: string };
	},
	mappingMap: Map<string, TransactionNature>,
	rules: Array<{
		id?: string;
		name: string;
		matchText: string;
		targetCategory: string;
		targetNature?: TransactionNature | null;
		enabled: boolean;
	}>
) {
	const category = getEffectiveCategory(transaction);
	const nature = getEffectiveTransactionNature(
		{
			amountCents: transaction.amountCents,
			type: resolveTransactionType(transaction),
			category,
			natureManual: transaction.natureManual
		},
		mappingMap
	);
	const suggestion =
		nature.nature === 'uncategorized' ? computeSuggestion(transaction, rules, mappingMap) : null;

	return {
		id: transaction.id,
		date: transaction.date.toISOString().slice(0, 10),
		label: truncateText(transaction.label, 64),
		category,
		importedCategory: transaction.category.name,
		manualCategory: transaction.manualCategory,
		isManualCategory: transaction.manualCategory !== null,
		nature: nature.nature,
		natureSource: nature.source,
		manualNature: transaction.natureManual,
		amountCents: transaction.amountCents,
		type: resolveTransactionType(transaction),
		source: transaction.source,
		suggestion
	};
}

function mapTransactionDetail(
	transaction: {
		id: string;
		date: Date;
		label: string;
		amountCents: number;
		type: string | null;
		source: string;
		notes: string | null;
		bankOperationType: string | null;
		manualCategory: string | null;
		natureManual: TransactionNature | null;
		dedupeKey: string | null;
		metadataJson: string | null;
		createdAt: Date;
		updatedAt: Date;
		category: { name: string };
		account: {
			name: string;
			source: string;
			netWorthAccount: { name: string } | null;
		} | null;
		importBatch: {
			fileName: string | null;
			source: string;
			id: string;
			rowCount: number;
			createdAt: Date;
		} | null;
	},
	mappingMap: Map<string, TransactionNature>
) {
	const metadata = parseMetadata(transaction.metadataJson);
	const category = getEffectiveCategory(transaction);
	const nature = getEffectiveTransactionNature(
		{
			amountCents: transaction.amountCents,
			type: resolveTransactionType(transaction),
			category,
			natureManual: transaction.natureManual
		},
		mappingMap
	);

	return {
		id: transaction.id,
		date: transaction.date.toISOString().slice(0, 10),
		label: anonymizeDetailText(transaction.label),
		amountCents: transaction.amountCents,
		type: resolveTransactionType(transaction),
		category,
		importedCategory: transaction.category.name,
		manualCategory: transaction.manualCategory,
		isManualCategory: transaction.manualCategory !== null,
		nature: nature.nature,
		natureSource: nature.source,
		manualNature: transaction.natureManual,
		source: transaction.source,
		notes: transaction.notes ? anonymizeDetailText(transaction.notes) : null,
		reference: metadata.reference ? anonymizeReference(metadata.reference) : null,
		dedupeKey: transaction.dedupeKey ? anonymizeReference(transaction.dedupeKey) : null,
		createdAt: transaction.createdAt.toISOString(),
		updatedAt: transaction.updatedAt.toISOString(),
		account: transaction.account
			? {
					name: transaction.account.name,
					source: transaction.account.source,
					netWorthAccountName: transaction.account.netWorthAccount?.name ?? null
				}
			: null,
		importBatch: transaction.importBatch
			? {
					id: transaction.importBatch.id,
					fileName: transaction.importBatch.fileName,
					source: transaction.importBatch.source,
					rowCount: transaction.importBatch.rowCount,
					createdAt: transaction.importBatch.createdAt.toISOString()
				}
			: null,
		bankFields: getAllowedBankFields(metadata.csvFields),
		bankOperationType: transaction.bankOperationType,
		subcategory: metadata.subcategory
	};
}

function parseMetadata(value: string | null): {
	reference: string;
	subcategory: string;
	csvFields: Record<string, string>;
} {
	if (!value) return { reference: '', subcategory: '', csvFields: {} };

	try {
		const parsed = JSON.parse(value) as {
			reference?: unknown;
			subcategory?: unknown;
			csvFields?: unknown;
		};

		return {
			reference: typeof parsed.reference === 'string' ? parsed.reference : '',
			subcategory: typeof parsed.subcategory === 'string' ? parsed.subcategory : '',
			csvFields:
				parsed.csvFields && typeof parsed.csvFields === 'object'
					? Object.fromEntries(
							Object.entries(parsed.csvFields).filter(
								(entry): entry is [string, string] => typeof entry[1] === 'string'
							)
						)
					: {}
		};
	} catch {
		return { reference: '', subcategory: '', csvFields: {} };
	}
}

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

function parseManualCategory(
	value: string
): { ok: true; value: string | null } | { ok: false; error: string } {
	const normalized = value.trim().replace(/\s+/g, ' ');
	if (!normalized) return { ok: true, value: null };
	if (/[<>\p{Cc}]/u.test(normalized)) return { ok: false, error: m.categories_error_invalid() };
	if (normalized.length > MAX_MANUAL_CATEGORY_LENGTH) {
		return { ok: false, error: m.transactions_error_category_too_long() };
	}
	return { ok: true, value: normalized };
}

function parseManualNature(
	value: string
): { ok: true; value: TransactionNature | null } | { ok: false; error: string } {
	const normalized = value.trim().slice(0, MAX_MANUAL_NATURE_LENGTH);
	if (!normalized) return { ok: true, value: null };
	if (!isTransactionNature(normalized))
		return { ok: false, error: m.categories_error_invalid_nature() };
	return { ok: true, value: normalized };
}

function parsePositiveInteger(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return parsed > 0 ? parsed : null;
}

function getAllowedBankFields(csvFields: Record<string, string>) {
	const allowedLabels = [
		'Libelle simplifie',
		'Libelle operation',
		'Type operation',
		'Categorie',
		'Sous categorie',
		'Informations complementaires',
		'Date de comptabilisation',
		'Date operation',
		'Date de valeur',
		'Pointage operation'
	];

	return allowedLabels
		.map((label) => ({ label, value: csvFields[label] ?? '' }))
		.filter((field) => field.value !== '')
		.map((field) => ({ label: field.label, value: anonymizeDetailText(field.value) }));
}
