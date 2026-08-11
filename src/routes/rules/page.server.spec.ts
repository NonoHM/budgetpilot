import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
	type Rule = {
		id: string;
		userId: string;
		name: string;
		matchText: string;
		targetCategory: string;
		enabled: boolean;
		createdAt: Date;
		updatedAt: Date;
	};
	const rules: Rule[] = [
		{
			id: 'rule-user-a',
			userId: 'user-a',
			name: 'Patreon',
			matchText: 'Patreon',
			targetCategory: 'Abonnements',
			enabled: true,
			createdAt: new Date('2026-06-01T00:00:00.000Z'),
			updatedAt: new Date('2026-06-01T00:00:00.000Z')
		},
		{
			id: 'rule-user-b',
			userId: 'user-b',
			name: 'Other',
			matchText: 'Other',
			targetCategory: 'Autre',
			enabled: true,
			createdAt: new Date('2026-06-01T00:00:00.000Z'),
			updatedAt: new Date('2026-06-01T00:00:00.000Z')
		}
	];
	const mappings = [
		{
			id: 'mapping-user-a',
			userId: 'user-a',
			categoryName: 'Alimentation',
			nature: 'spending',
			createdAt: new Date('2026-06-01T00:00:00.000Z'),
			updatedAt: new Date('2026-06-01T00:00:00.000Z')
		},
		{
			id: 'mapping-user-b',
			userId: 'user-b',
			categoryName: 'Transfert',
			nature: 'transfer',
			createdAt: new Date('2026-06-01T00:00:00.000Z'),
			updatedAt: new Date('2026-06-01T00:00:00.000Z')
		}
	];

	// #161: whether a rule's target still resolves to one of these decides whether it is paused, so
	// the fixture has to carry them. "Abonnements" is spelled differently from the rule that targets
	// it on purpose, because the resolution folds through `computeNameKey` and a fixture that agreed
	// character for character would pass under a raw comparison too.
	const categories: Array<{ userId: string; name: string; defaultKey: string | null }> = [
		{ userId: 'user-a', name: 'abonnements', defaultKey: null },
		{ userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
		{ userId: 'user-b', name: 'Autre', defaultKey: null }
	];

	return {
		rules,
		categories,
		prisma: {
			category: {
				findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
					categories
						.filter((category) => category.userId === where.userId)
						.map((category) => ({ name: category.name, defaultKey: category.defaultKey }))
				)
			},
			categoryRule: {
				findMany: vi.fn(async ({ where }) => rules.filter((rule) => rule.userId === where.userId)),
				create: vi.fn(async ({ data }) => {
					const rule = {
						id: `rule-${rules.length + 1}`,
						createdAt: new Date(),
						updatedAt: new Date(),
						...data
					};
					rules.push(rule);
					return rule;
				}),
				updateMany: vi.fn(async ({ where, data }) => {
					const rule = rules.find((item) => item.id === where.id && item.userId === where.userId);
					if (!rule) return { count: 0 };
					Object.assign(rule, data);
					return { count: 1 };
				}),
				deleteMany: vi.fn(async ({ where }) => {
					const index = rules.findIndex(
						(item) => item.id === where.id && item.userId === where.userId
					);
					if (index === -1) return { count: 0 };
					rules.splice(index, 1);
					return { count: 1 };
				})
			},
			categoryNatureMapping: {
				findMany: vi.fn(async ({ where }) =>
					mappings.filter((mapping) => mapping.userId === where.userId)
				),
				upsert: vi.fn(async ({ where, create, update }) => {
					const existing = mappings.find(
						(mapping) =>
							mapping.userId === where.userId_categoryName.userId &&
							mapping.categoryName === where.userId_categoryName.categoryName
					);
					if (existing) {
						Object.assign(existing, update);
						return existing;
					}
					const mapping = {
						id: `mapping-${mappings.length + 1}`,
						createdAt: new Date(),
						updatedAt: new Date(),
						...create
					};
					mappings.push(mapping);
					return mapping;
				}),
				deleteMany: vi.fn(async ({ where }) => {
					const index = mappings.findIndex(
						(mapping) => mapping.id === where.id && mapping.userId === where.userId
					);
					if (index === -1) return { count: 0 };
					mappings.splice(index, 1);
					return { count: 1 };
				})
			},
			transaction: {
				findMany: vi.fn(async () => []),
				updateMany: vi.fn(async () => ({ count: 0 }))
			}
		}
	};
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { actions, load } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

interface RulesPageData {
	rules: Array<{ id: string; paused: boolean }>;
}

describe('/rules', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('liste uniquement les règles du user courant', async () => {
		expect.assertions(2);

		const data = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/rules')
		} as Parameters<typeof load>[0])) as RulesPageData;

		expect(data.rules).toHaveLength(1);
		expect(data.rules[0].id).toBe('rule-user-a');
	});

	// #161. The page has to be able to SAY a rule is paused, which is the condition the whole fix
	// hangs on: a rule that silently stops firing turns a loud bug into a quiet one, and the user's
	// imports just stop being categorised with nothing on any screen to explain it. These assert
	// the flag the render reads; the render itself is covered end to end in e2e/rules-paused.
	async function loadRules(): Promise<RulesPageData['rules']> {
		const data = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/rules')
		} as Parameters<typeof load>[0])) as RulesPageData;
		return data.rules;
	}

	it('marks a rule live when its target resolves, folding case as the rename does', async () => {
		expect.assertions(2);

		// The rule targets "Abonnements"; the category is stored as "abonnements". They are the same
		// category, and `renameCategoryReferences` would repoint this rule, so the page must not
		// call it broken. Deleting the fold from isRuleTargetLive turns this red.
		const rules = await loadRules();

		expect(rules[0].id).toBe('rule-user-a');
		expect(rules[0].paused).toBe(false);
	});

	it('marks a rule paused when no category carries its target any more', async () => {
		expect.assertions(2);

		db.categories.splice(
			db.categories.findIndex((category) => category.name === 'abonnements'),
			1
		);

		const rules = await loadRules();

		expect(rules[0].id, 'the rule must survive as a row, not be deleted').toBe('rule-user-a');
		expect(rules[0].paused).toBe(true);

		db.categories.unshift({ userId: 'user-a', name: 'abonnements', defaultKey: null });
	});

	it('resumes a rule when a category under its target name comes back', async () => {
		expect.assertions(2);

		// The property a stored `disabledReason` column could not have had: nothing was written at
		// delete time, so nothing has to be un-written here, and no sentence on screen can outlive
		// the fact it describes.
		const index = db.categories.findIndex((category) => category.name === 'abonnements');
		db.categories.splice(index, 1);
		expect((await loadRules())[0].paused).toBe(true);

		db.categories.unshift({ userId: 'user-a', name: 'Abonnements', defaultKey: null });
		expect((await loadRules())[0].paused).toBe(false);

		db.categories.splice(
			db.categories.findIndex((category) => category.name === 'Abonnements'),
			1
		);
		db.categories.unshift({ userId: 'user-a', name: 'abonnements', defaultKey: null });
	});

	it('crée une règle sans accepter de userId client', async () => {
		expect.assertions(2);

		await runAction('create', {
			userId: 'user-b',
			name: 'Patreon',
			matchText: ' patreon ',
			targetCategory: ' Abonnements '
		});

		expect(db.prisma.categoryRule.create).toHaveBeenCalledWith({
			data: {
				userId: 'user-a',
				name: 'Patreon',
				matchText: 'patreon',
				targetCategory: 'Abonnements',
				targetNature: null,
				enabled: true,
				isRegex: false
			}
		});
		expect(db.rules.at(-1)?.userId).toBe('user-a');
	});

	it('ne modifie pas une règle d’un autre user', async () => {
		expect.assertions(2);

		const result = await runAction('toggle', {
			id: 'rule-user-b',
			enabled: 'false'
		});

		expect(result.status).toBe(404);
		expect(db.prisma.categoryRule.updateMany).toHaveBeenCalledWith({
			where: { id: 'rule-user-b', userId: 'user-a' },
			data: { enabled: false }
		});
	});

	it('supprime uniquement les règles du user courant', async () => {
		expect.assertions(2);

		const result = await runAction('delete', { id: 'rule-user-a' });

		expect(result).toEqual({ success: 'Règle supprimée.' });
		expect(db.rules.some((rule) => rule.id === 'rule-user-b')).toBe(true);
	});

	it('crée une règle en mode regex avec un pattern valide', async () => {
		expect.assertions(1);

		await runAction('create', {
			name: 'Cartes',
			matchText: '^CB\\d+$',
			targetCategory: 'Abonnements',
			isRegex: 'true'
		});

		expect(db.rules.at(-1)).toMatchObject({ isRegex: true, matchText: '^CB\\d+$' });
	});

	it('rejette un pattern regex invalide à la création', async () => {
		expect.assertions(2);

		const result = await runAction('create', {
			name: 'Invalide',
			matchText: '(',
			targetCategory: 'Abonnements',
			isRegex: 'true'
		});

		expect(result.status).toBe(400);
		expect(db.prisma.categoryRule.create).not.toHaveBeenCalled();
	});
});

async function runAction(name: keyof typeof actions, input: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return (await (
		actions[name] as (event: {
			locals: { user: typeof testUser };
			request: Request;
		}) => Promise<unknown>
	)({
		locals: { user: testUser },
		request: new Request('http://localhost/rules', { method: 'POST', body: formData })
	})) as { status?: number; success?: string };
}
