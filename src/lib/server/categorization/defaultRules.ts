import { prisma } from '$lib/server/db';
import { DEFAULT_CATEGORIES } from '$lib/server/categories/defaults';
import { displayNameForDefaultRule, loadDefaultRuleCatalog } from './default-rules/catalog';

/**
 * Seeds the predefined categorization rules for a user, exactly once.
 * Same lock logic as ensureDefaultCategoriesSeeded: atomic claim on
 * `User.defaultRulesSeededAt` (flag separate from defaultsSeededAt — the two catalogs can
 * evolve independently). Once set, definitive no-op: a rule seeded then deleted
 * by the user never reappears.
 *
 * NEVER applies the created rules to existing transactions — only the
 * "Apply rules" button (applyCategoryRules) triggers a recategorization, exactly
 * like for a manually created rule.
 */
export async function ensureDefaultRulesSeeded(userId: string): Promise<boolean> {
	const claim = await prisma.user.updateMany({
		where: { id: userId, defaultRulesSeededAt: null },
		data: { defaultRulesSeededAt: new Date() }
	});
	if (claim.count !== 1) return false;

	await createMissingDefaultRules(userId);
	return true;
}

/**
 * Recreates the MISSING predefined rules for a user, without depending on the
 * `defaultRulesSeededAt` flag. Idempotent, never touches a rule already present (whether it's
 * still "defaultRuleKey"-linked or became custom after editing). Used by the
 * "Restore suggested rules" button on /rules.
 */
export async function restoreMissingDefaultRules(userId: string): Promise<number> {
	return createMissingDefaultRules(userId);
}

const categoryNameByKey = new Map(DEFAULT_CATEGORIES.map((c) => [c.key, c.name]));

async function createMissingDefaultRules(userId: string): Promise<number> {
	const catalog = loadDefaultRuleCatalog();
	if (catalog.length === 0) return 0;

	const existingRules = await prisma.categoryRule.findMany({
		where: { userId, defaultRuleKey: { not: null } },
		select: { defaultRuleKey: true }
	});
	const existingKeys = new Set(existingRules.map((r) => r.defaultRuleKey));

	const rulesToCreate = catalog
		.filter((entry) => !existingKeys.has(entry.key))
		.map((entry) => ({
			userId,
			name: displayNameForDefaultRule(entry),
			matchText: entry.match,
			targetCategory: categoryNameByKey.get(entry.targetCategoryKey) ?? entry.targetCategoryKey,
			targetNature: entry.targetNature,
			isRegex: entry.isRegex,
			enabled: true,
			defaultRuleKey: entry.key
		}));

	if (rulesToCreate.length === 0) return 0;

	// Created sequentially (not createMany) to guarantee a strictly increasing createdAt
	// in catalog order — the seeding order drives the matching priority
	// (findMatchingCategoryRule stops at the first matching rule, sorted by createdAt).
	for (const rule of rulesToCreate) {
		await prisma.categoryRule.create({ data: rule });
	}

	return rulesToCreate.length;
}
