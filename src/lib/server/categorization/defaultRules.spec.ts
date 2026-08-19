import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		user: {
			updateMany: vi.fn()
		},
		categoryRule: {
			findMany: vi.fn(),
			create: vi.fn()
		}
	}
}));

const fakeCatalog = vi.hoisted(() => [
	{ key: 'k1', match: 'aaa', isRegex: false, targetCategoryKey: 'food', targetNature: null },
	{ key: 'k2', match: 'bbb', isRegex: false, targetCategoryKey: 'transport', targetNature: null },
	{ key: 'k3', match: 'ccc', isRegex: false, targetCategoryKey: 'dining', targetNature: null }
]);

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
// Partial: the catalogue CONTENT is faked so these tests own their fixture, but
// `displayNameForDefaultRule` is the real one. Faking it too would let the name written to the
// database and the name asserted here come from the same place, which is the shape of a test that
// cannot fail.
vi.mock('./default-rules/catalog', async (importOriginal) => ({
	...(await importOriginal<typeof import('./default-rules/catalog')>()),
	loadDefaultRuleCatalog: () => fakeCatalog
}));

const { ensureDefaultRulesSeeded, restoreMissingDefaultRules } = await import('./defaultRules');

describe('ensureDefaultRulesSeeded', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("compte neuf → retourne true et crée les règles manquantes dans l'ordre du catalogue", async () => {
		expect.assertions(5);

		db.prisma.user.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.categoryRule.findMany.mockResolvedValue([]);
		db.prisma.categoryRule.create.mockResolvedValue({});

		const result = await ensureDefaultRulesSeeded('user-new');

		expect(result).toBe(true);
		expect(db.prisma.categoryRule.create).toHaveBeenCalledTimes(3);
		expect(db.prisma.categoryRule.create.mock.calls[0][0].data.defaultRuleKey).toBe('k1');
		expect(db.prisma.categoryRule.create.mock.calls[1][0].data.defaultRuleKey).toBe('k2');
		expect(db.prisma.categoryRule.create.mock.calls[2][0].data.defaultRuleKey).toBe('k3');
	});

	it("2e appel (updateMany → count:0) → retourne false et n'appelle aucun create", async () => {
		expect.assertions(2);

		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		const result = await ensureDefaultRulesSeeded('user-already-seeded');

		expect(result).toBe(false);
		expect(db.prisma.categoryRule.create).not.toHaveBeenCalled();
	});

	it('résout targetCategory via la clé de catégorie (nom FR canonique), pas la clé brute', async () => {
		expect.assertions(1);

		db.prisma.user.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.categoryRule.findMany.mockResolvedValue([]);
		db.prisma.categoryRule.create.mockResolvedValue({});

		await ensureDefaultRulesSeeded('user-new');

		expect(db.prisma.categoryRule.create.mock.calls[0][0].data.targetCategory).toBe('Alimentation');
	});
});

describe('restoreMissingDefaultRules', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("ne recrée pas une règle déjà présente (par defaultRuleKey), qu'elle vienne du catalogue ou pas", async () => {
		expect.assertions(2);

		db.prisma.categoryRule.findMany.mockResolvedValue([
			{ defaultRuleKey: 'k1' },
			{ defaultRuleKey: 'k3' }
		]);
		db.prisma.categoryRule.create.mockResolvedValue({});

		const created = await restoreMissingDefaultRules('user-1');

		expect(created).toBe(1);
		expect(db.prisma.categoryRule.create.mock.calls[0][0].data.defaultRuleKey).toBe('k2');
	});

	it('ne fait aucun appel create si tout le catalogue est déjà présent', async () => {
		expect.assertions(2);

		db.prisma.categoryRule.findMany.mockResolvedValue([
			{ defaultRuleKey: 'k1' },
			{ defaultRuleKey: 'k2' },
			{ defaultRuleKey: 'k3' }
		]);

		const created = await restoreMissingDefaultRules('user-1');

		expect(created).toBe(0);
		expect(db.prisma.categoryRule.create).not.toHaveBeenCalled();
	});
});
