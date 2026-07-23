import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';
import { forEachTransactionBatch } from '$lib/server/transactions/batch';
import { normalizeForMatch } from '$lib/server/matching/normalize';
import {
	isSafeRegexPattern as isSafeRegexPatternShared,
	safeRegexTest
} from '$lib/server/matching/regex';
import {
	type TransactionKind,
	type TransactionNature,
	isTransactionNature
} from '$lib/domain/transaction';

export interface CategorizationRuleInput {
	id?: string;
	pattern: string;
	targetCategory: string;
	targetNature?: TransactionNature | null;
	type?: TransactionKind | 'any' | null;
	active?: boolean;
}

export interface CategorizationInput {
	label: string;
	category: string;
	type: TransactionKind;
}

export interface CategorizationResult {
	category: string;
	type: TransactionKind;
	targetNature?: TransactionNature | null;
	ruleId?: string;
}

export interface CategoryRuleInput {
	name: string;
	matchText: string;
	targetCategory: string;
	targetNature?: string;
	enabled?: boolean;
	isRegex?: boolean;
}

export interface CategoryRuleMatchInput {
	label: string;
	manualCategory?: string | null;
}

export interface NormalizedCategoryRule {
	name: string;
	matchText: string;
	targetCategory: string;
	targetNature: TransactionNature | null;
	enabled: boolean;
	isRegex: boolean;
}

export interface CategoryRuleValidationResult {
	ok: false;
	error: string;
}

export interface CategoryRulePreviewItem {
	transactionId: string;
	labelPreview: string;
	currentCategory: string;
	targetCategory: string;
	targetNature: TransactionNature | null;
	ruleName: string;
}

export interface CategoryRulePreview {
	count: number;
	examples: CategoryRulePreviewItem[];
}

const MAX_RULE_FIELD_LENGTH = 80;
const PREVIEW_LIMIT = 5;

export function applyCategorizationRules(
	transaction: CategorizationInput,
	rules: CategorizationRuleInput[] = []
): CategorizationResult {
	let result: CategorizationResult = {
		category: transaction.category,
		type: transaction.type
	};

	for (const rule of rules) {
		if (rule.active === false) continue;
		if (!isValidRule(rule)) continue;
		if (rule.type && rule.type !== 'any' && rule.type !== result.type) continue;
		if (!normalizedContains(transaction.label, rule.pattern)) continue;

		result = {
			...result,
			category: rule.targetCategory.trim(),
			targetNature: rule.targetNature ?? null,
			ruleId: rule.id
		};
	}

	return result;
}

export function isValidRule(rule: CategorizationRuleInput): boolean {
	const pattern = rule.pattern.trim();
	const targetCategory = rule.targetCategory.trim();
	const type = rule.type ?? 'any';

	return (
		pattern.length >= 2 &&
		pattern.length <= 80 &&
		targetCategory.length >= 1 &&
		targetCategory.length <= 60 &&
		(type === 'income' || type === 'expense' || type === 'any')
	);
}

export function parseCategoryRuleInput(
	input: CategoryRuleInput
): { ok: true; value: NormalizedCategoryRule } | CategoryRuleValidationResult {
	const name = normalizeRuleField(input.name);
	const matchText = normalizeRuleField(input.matchText);
	const targetCategory = normalizeRuleField(input.targetCategory);
	const rawTargetNature = (input.targetNature ?? '').trim();
	const targetNature = parseRuleTargetNature(rawTargetNature);
	const isRegex = input.isRegex ?? false;

	if (
		!isValidRuleField(name) ||
		!isValidRuleField(matchText) ||
		!isValidRuleField(targetCategory) ||
		(rawTargetNature !== '' && targetNature === null)
	) {
		return {
			ok: false,
			error: m.rules_error_invalid_input()
		};
	}

	if (isRegex && !isSafeRegexPattern(matchText)) {
		return {
			ok: false,
			error: m.rules_error_invalid_regex()
		};
	}

	return {
		ok: true,
		value: {
			name,
			matchText,
			targetCategory,
			targetNature,
			enabled: input.enabled ?? true,
			isRegex
		}
	};
}

export function isSafeRegexPattern(pattern: string): boolean {
	return isSafeRegexPatternShared(pattern, MAX_RULE_FIELD_LENGTH);
}

export function findMatchingCategoryRule<
	TRule extends {
		id?: string;
		name: string;
		matchText: string;
		targetCategory: string;
		targetNature?: TransactionNature | null;
		enabled: boolean;
		isRegex?: boolean;
	}
>(transaction: CategoryRuleMatchInput, rules: TRule[]): TRule | null {
	if (transaction.manualCategory) return null;

	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (ruleMatchesLabel(transaction.label, rule)) return rule;
	}

	return null;
}

function ruleMatchesLabel(label: string, rule: { matchText: string; isRegex?: boolean }): boolean {
	if (!rule.isRegex) return normalizedContains(label, rule.matchText);
	return safeRegexTest(rule.matchText, 'i', label);
}

export async function previewCategoryRules(userId: string): Promise<CategoryRulePreview> {
	const rules = await prisma.categoryRule.findMany({
		where: { userId, enabled: true },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
		select: {
			id: true,
			name: true,
			matchText: true,
			targetCategory: true,
			targetNature: true,
			enabled: true,
			isRegex: true
		}
	});
	if (rules.length === 0) return { count: 0, examples: [] };

	let count = 0;
	const examples: CategoryRulePreviewItem[] = [];
	// Batched scan (see forEachTransactionBatch): matching needs JS (accent-insensitive/regex),
	// so it can't be pushed into SQL, but memory stays bounded to one batch at a time instead of
	// the full "manualCategory: null" history. Batches are processed in date-desc order, so the
	// first PREVIEW_LIMIT matches found are still the most recent ones — same result as before.
	await forEachTransactionBatch(
		{ userId, manualCategory: null },
		{ id: true, label: true, manualCategory: true, category: { select: { name: true } } },
		(rows) => {
			for (const transaction of rows) {
				const rule = findMatchingCategoryRule(transaction, rules);
				if (!rule) continue;
				count += 1;
				if (examples.length < PREVIEW_LIMIT) {
					examples.push({
						transactionId: transaction.id,
						labelPreview: anonymizeRulePreview(transaction.label),
						currentCategory: transaction.category.name,
						targetCategory: rule.targetCategory,
						targetNature: rule.targetNature ?? null,
						ruleName: rule.name
					});
				}
			}
		}
	);

	return { count, examples };
}

export async function applyCategoryRules(
	userId: string,
	options: { transactionIds?: string[]; categoryId?: string } = {}
): Promise<number> {
	const rules = await prisma.categoryRule.findMany({
		where: { userId, enabled: true },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
		select: {
			id: true,
			name: true,
			matchText: true,
			targetCategory: true,
			targetNature: true,
			enabled: true,
			isRegex: true
		}
	});
	if (rules.length === 0) return 0;

	const groups = new Map<
		string,
		{ targetCategory: string; targetNature: TransactionNature | null; ids: string[] }
	>();
	// Batched scan (see forEachTransactionBatch): same rationale as previewCategoryRules — rule
	// matching needs JS, but memory stays bounded to one batch instead of the full candidate set.
	await forEachTransactionBatch(
		{
			userId,
			manualCategory: null,
			...(options.transactionIds ? { id: { in: options.transactionIds } } : {}),
			...(options.categoryId ? { categoryId: options.categoryId } : {})
		},
		{ id: true, label: true, manualCategory: true, natureManual: true },
		(rows) => {
			for (const transaction of rows) {
				const rule = findMatchingCategoryRule(transaction, rules);
				if (!rule) continue;

				const targetNature = rule.targetNature ?? null;
				const key = JSON.stringify([rule.targetCategory, targetNature]);
				const group = groups.get(key);
				if (group) {
					group.ids.push(transaction.id);
				} else {
					groups.set(key, {
						targetCategory: rule.targetCategory,
						targetNature,
						ids: [transaction.id]
					});
				}
			}
		}
	);

	let updated = 0;
	for (const { targetCategory, targetNature, ids } of groups.values()) {
		const result = await prisma.transaction.updateMany({
			where: {
				id: { in: ids },
				userId,
				manualCategory: null,
				...(targetNature ? { natureManual: null } : {})
			},
			data: {
				manualCategory: targetCategory,
				...(targetNature ? { natureManual: targetNature } : {})
			}
		});
		updated += result.count;
	}

	return updated;
}

function normalizeRuleField(value: string): string {
	return value
		.trim()
		.replace(/\s+/g, ' ')
		.slice(0, MAX_RULE_FIELD_LENGTH + 1);
}

function parseRuleTargetNature(value: string): TransactionNature | null {
	const normalized = value.trim();
	if (!normalized) return null;
	return isTransactionNature(normalized) ? normalized : null;
}

function isValidRuleField(value: string): boolean {
	return value.length > 0 && value.length <= MAX_RULE_FIELD_LENGTH && !/[<>\p{Cc}]/u.test(value);
}

function normalizedContains(value: string, matchText: string): boolean {
	return normalizeForMatch(value).includes(normalizeForMatch(matchText));
}

function anonymizeRulePreview(value: string): string {
	return normalizeRuleField(value)
		.replace(
			/\b(?:REF[A-Z0-9]{3,}|[A-Z0-9]*\d[A-Z0-9]{6,})\b/gi,
			(match) => `${match.slice(0, 3)}...`
		)
		.replace(/\b\d{8,}\b/g, (match) => `${match.slice(0, 4)}...`)
		.slice(0, 48);
}
