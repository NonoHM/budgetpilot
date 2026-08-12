import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { computeNameKey } from '$lib/server/naming/nameKey';
// Compared against the message FUNCTION, never a copied literal: a spec that retypes the sentence
// keeps passing while the catalogue says something else.
import * as m from '$lib/paraglide/messages';
import { buildTransactionWhere } from '$lib/server/transactions/where';

const db = vi.hoisted(() => {
	// Must stay aligned with UNCLASSIFIED_CATEGORY ($lib/domain/categories) — literal
	// required here because vi.hoisted() runs before module imports are ready.
	const UNCLASSIFIED_CATEGORY = 'uncategorized';

	// `defaultKey` stays on the fake's row shape, and stays POPULATED in the fixtures below, on
	// purpose. The column survives #162 as a tombstone, and between this change and the migration
	// that clears it every real row still holds its old value. A fixture carrying one is therefore
	// the un-migrated state, and every assertion here is evidence that the code ignores the column
	// rather than evidence that the column is empty.
	type Category = { id: string; userId: string; name: string; defaultKey: string | null };
	type NatureMapping = { id: string; userId: string; categoryName: string; nature: string };
	type Budget = { id: string; userId: string; categoryName: string; amountCents: number };
	type Rule = { id: string; userId: string; targetCategory: string };

	const categories: Category[] = [
		{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
		{ id: 'cat-non-classe', userId: 'user-a', name: UNCLASSIFIED_CATEGORY, defaultKey: null }
	];
	const mappings: NatureMapping[] = [
		{
			id: 'mapping-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			nature: 'spending'
		}
	];
	const budgets: Budget[] = [
		{
			id: 'budget-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			amountCents: 50_000
		}
	];

	// The two rule tables have no fold key, so `renameCategoryReferences` reads them and filters in
	// JS. Seeded in a DIFFERENT case from the category on purpose: a fake that matched raw text
	// would leave these behind, and the rename spec below is what says so.
	const categoryRules: Rule[] = [
		{ id: 'rule-alimentation', userId: 'user-a', targetCategory: 'alimentation' }
	];
	const categorizationRules: Rule[] = [
		{ id: 'legacy-rule-alimentation', userId: 'user-a', targetCategory: 'ALIMENTATION' }
	];

	/**
	 * The two rule tables are modelled identically, so they are built once.
	 *
	 * Both halves fail loudly on a filter they do not model rather than approximating one. A fake
	 * that silently ignores an unknown key WIDENS the set it is asked about, so the guard being
	 * added here would pass with the guard deleted — the mock change is part of the guard, and
	 * "the test passes" says nothing until the mock has been seen to fail without it.
	 */
	const ruleTableMock = (rows: Rule[]) => ({
		findMany: vi.fn(async ({ where }) => {
			const modelled = new Set(['userId']);
			const unknown = Object.keys(where ?? {}).filter((key) => !modelled.has(key));
			if (unknown.length > 0) {
				throw new Error(`rule.findMany: unmodelled filter ${unknown.join(', ')}`);
			}
			return rows.filter((rule) => rule.userId === where.userId);
		}),
		updateMany: vi.fn(async ({ where, data }) => {
			const modelled = new Set(['userId', 'id']);
			const unknown = Object.keys(where ?? {}).filter((key) => !modelled.has(key));
			if (unknown.length > 0) {
				throw new Error(`rule.updateMany: unmodelled filter ${unknown.join(', ')}`);
			}
			if (where.id && !Array.isArray(where.id.in)) {
				throw new Error('rule.updateMany: only `id: { in: [...] }` is modelled');
			}
			let count = 0;
			for (const rule of rows) {
				if (rule.userId !== where.userId) continue;
				if (where.id && !where.id.in.includes(rule.id)) continue;
				Object.assign(rule, data);
				count++;
			}
			return { count };
		})
	});

	// The one stored half of #162's rename prompt. Everything else about it is derived per request.
	const promptDismissal: { at: Date | null } = { at: null };

	const base = {
		categories,
		mappings,
		budgets,
		categoryRules,
		categorizationRules,
		promptDismissal,
		prisma: {
			categoryRule: ruleTableMock(categoryRules),
			categorizationRule: ruleTableMock(categorizationRules),
			category: {
				findFirst: vi.fn(
					async ({ where }) =>
						categories.find(
							(cat) =>
								cat.userId === where.userId &&
								(where.id
									? cat.id === where.id
									: computeNameKey(cat.name) === where.nameKey &&
										(!where.id?.not || cat.id !== where.id.not))
						) ?? null
				),
				findMany: vi.fn(async ({ where, select }) => {
					// Fails loudly rather than approximating: the uniqueness check reads the whole
					// list precisely because a displayed label cannot be expressed as a `where`, so a
					// fake that quietly ignored a conjunct it did not model would widen the set the
					// check is asked about and pass the very test that exists to refuse it.
					const modelled = new Set(['userId']);
					const unknown = Object.keys(where ?? {}).filter((key) => !modelled.has(key));
					if (unknown.length > 0) {
						throw new Error(`category.findMany: unmodelled filter ${unknown.join(', ')}`);
					}
					const rows = categories.filter((cat) => cat.userId === where.userId);
					// `load` asks for the relation count. Zero for every category, and consistent with
					// `transaction.count` above rather than invented: this file holds no transaction
					// fixture at all, so any other number would be a claim about rows that do not
					// exist. Tests about the transaction count itself belong where those rows do.
					if (!select?._count) return rows;
					return rows.map((cat) => ({ ...cat, _count: { transactions: 0 } }));
				}),
				create: vi.fn(async ({ data }) => {
					const created = { id: `cat-created-${categories.length}`, defaultKey: null, ...data };
					categories.push(created);
					return created;
				}),
				upsert: vi.fn(async ({ where, create }) => {
					// Keyed on the folded name, matching the unique constraint the real table now
					// carries: two spellings of one category resolve to the same row.
					const existing = categories.find(
						(cat) =>
							cat.userId === where.userId_nameKey.userId &&
							computeNameKey(cat.name) === where.userId_nameKey.nameKey
					);
					if (existing) return existing;
					const created = { defaultKey: null, ...create };
					categories.push(created);
					return created;
				}),
				delete: vi.fn(async ({ where }) => {
					const index = categories.findIndex((cat) => cat.id === where.id);
					const [removed] = categories.splice(index, 1);
					return removed;
				}),
				update: vi.fn(async ({ where, data }) => {
					const cat = categories.find((c) => c.id === where.id);
					if (cat) Object.assign(cat, data);
					return cat;
				})
			},
			user: {
				// #162's rename prompt. `load` reads the dismissal; `?/dismissRenamePrompt` writes it.
				//
				// Held in a mutable box rather than returned as a constant, so a test can drive the
				// dismiss action and then observe `load` going quiet, which is the whole behaviour.
				// Fails loudly on an unmodelled select for the same reason every other fake here does:
				// silently returning a row without the field would make the prompt look dismissed,
				// which is the direction that HIDES a regression rather than reporting one.
				findUnique: vi.fn(async ({ where, select }) => {
					if (where.id !== 'user-a') return null;
					if (!select?.categoryRenamePromptDismissedAt) {
						throw new Error('user.findUnique: only `categoryRenamePromptDismissedAt` is modelled');
					}
					return { categoryRenamePromptDismissedAt: promptDismissal.at };
				}),
				update: vi.fn(async ({ where, data }) => {
					if (where.id !== 'user-a') throw new Error('user.update: unmodelled user');
					if (!('categoryRenamePromptDismissedAt' in data)) {
						throw new Error('user.update: only `categoryRenamePromptDismissedAt` is modelled');
					}
					promptDismissal.at = data.categoryRenamePromptDismissedAt;
					return { id: where.id };
				})
			},
			transaction: {
				count: vi.fn(async () => 0),
				updateMany: vi.fn(async () => ({ count: 0 }))
			},
			transactionSplit: {
				// Defaults to "no part uses this category", which is every pre-existing test in this
				// file; the split cases override it per test.
				count: vi.fn(async () => 0)
			},
			categoryNatureMapping: {
				// Only `load` reads them; the actions above go through deleteMany/updateMany.
				findMany: vi.fn(async ({ where }) => {
					const modelled = new Set(['userId']);
					const unknown = Object.keys(where ?? {}).filter((key) => !modelled.has(key));
					if (unknown.length > 0) {
						throw new Error(
							`categoryNatureMapping.findMany: unmodelled filter ${unknown.join(', ')}`
						);
					}
					return mappings.filter((mapping) => mapping.userId === where.userId);
				}),
				deleteMany: vi.fn(async ({ where }) => {
					const before = mappings.length;
					for (let i = mappings.length - 1; i >= 0; i--) {
						if (
							mappings[i].userId === where.userId &&
							computeNameKey(mappings[i].categoryName) === where.categoryNameKey
						) {
							mappings.splice(i, 1);
						}
					}
					return { count: before - mappings.length };
				}),
				updateMany: vi.fn(async ({ where, data }) => {
					let count = 0;
					for (const mapping of mappings) {
						if (
							mapping.userId === where.userId &&
							computeNameKey(mapping.categoryName) === where.categoryNameKey
						) {
							Object.assign(mapping, data);
							count++;
						}
					}
					return { count };
				})
			},
			monthlyBudget: {
				deleteMany: vi.fn(async ({ where }) => {
					const before = budgets.length;
					for (let i = budgets.length - 1; i >= 0; i--) {
						if (
							budgets[i].userId === where.userId &&
							computeNameKey(budgets[i].categoryName) === where.categoryNameKey
						) {
							budgets.splice(i, 1);
						}
					}
					return { count: before - budgets.length };
				}),
				updateMany: vi.fn(async ({ where, data }) => {
					let count = 0;
					for (const budget of budgets) {
						if (
							budget.userId === where.userId &&
							computeNameKey(budget.categoryName) === where.categoryNameKey
						) {
							Object.assign(budget, data);
							count++;
						}
					}
					return { count };
				})
			},
			// Both call shapes. The array form is what deleteCategory still uses; the callback form
			// is what renameCategory needs, because it reads the keyless rule tables and filters in
			// JS inside the same transaction. Handing the callback `client` (not a fresh object) is
			// what makes writes through `tx` land in these same arrays — a `tx` that wrote somewhere
			// else would let every assertion below pass against untouched fixtures.
			$transaction: vi.fn(async (arg: unknown) =>
				typeof arg === 'function'
					? (arg as (tx: unknown) => Promise<unknown>)(client)
					: Promise.all(arg as unknown[])
			)
		}
	};

	const client = base.prisma;
	return base;
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

// Must stay aligned with UNCLASSIFIED_CATEGORY ($lib/domain/categories).
const UNCLASSIFIED_CATEGORY = 'uncategorized';

const { actions, load } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

describe('deleteCategory — orphelins CategoryNatureMapping / MonthlyBudget', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.categories.length = 0;
		db.categories.push(
			{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
			{ id: 'cat-non-classe', userId: 'user-a', name: UNCLASSIFIED_CATEGORY, defaultKey: null }
		);
		db.mappings.length = 0;
		db.mappings.push({
			id: 'mapping-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			nature: 'spending'
		});
		db.budgets.length = 0;
		db.budgets.push({
			id: 'budget-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			amountCents: 50_000
		});
	});

	it('supprime le CategoryNatureMapping orphelin à la suppression de la catégorie', async () => {
		expect.assertions(2);

		await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.prisma.categoryNatureMapping.deleteMany).toHaveBeenCalledWith({
			where: { userId: 'user-a', categoryNameKey: computeNameKey('Alimentation') }
		});
		expect(db.mappings).toHaveLength(0);
	});

	it('supprime le MonthlyBudget orphelin à la suppression de la catégorie', async () => {
		expect.assertions(2);

		await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.prisma.monthlyBudget.deleteMany).toHaveBeenCalledWith({
			where: { userId: 'user-a', categoryNameKey: computeNameKey('Alimentation') }
		});
		expect(db.budgets).toHaveLength(0);
	});

	it("ne plante pas si la catégorie n'a ni mapping ni budget associé", async () => {
		expect.assertions(3);
		db.categories.push({ id: 'cat-loisirs', userId: 'user-a', name: 'Loisirs', defaultKey: null });

		const result = await runAction('deleteCategory', { id: 'cat-loisirs' });

		expect(result.status).toBeUndefined();
		expect(db.mappings).toHaveLength(1); // mapping "Alimentation" intact
		expect(db.budgets).toHaveLength(1); // budget "Alimentation" intact
	});

	it("ne supprime pas le mapping d'un autre utilisateur portant le même categoryName", async () => {
		expect.assertions(2);
		db.mappings.push({
			id: 'mapping-alimentation-user-b',
			userId: 'user-b',
			categoryName: 'Alimentation',
			nature: 'spending'
		});

		await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.mappings).toHaveLength(1);
		expect(db.mappings[0]).toMatchObject({ userId: 'user-b', categoryName: 'Alimentation' });
	});

	it("ne supprime pas le budget d'un autre utilisateur portant le même categoryName", async () => {
		expect.assertions(2);
		db.budgets.push({
			id: 'budget-alimentation-user-b',
			userId: 'user-b',
			categoryName: 'Alimentation',
			amountCents: 12_000
		});

		await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.budgets).toHaveLength(1);
		expect(db.budgets[0]).toMatchObject({ userId: 'user-b', categoryName: 'Alimentation' });
	});

	// A category carrying parts CANNOT be repointed the way transactions are. `TransactionSplit`
	// deliberately does not cascade from `Category`, so the delete fails on the foreign key; and
	// the obvious repair — send the parts to "Non catégorisé" like the parent rows — is worse than
	// the crash. A part may never carry the sentinel (replaceSplits refuses it on input), and a
	// répartie transaction is excluded from the classify pile, so those cents would become money
	// that is uncategorised AND invisible on the one screen built to find uncategorised money.
	//
	// So the delete is refused, counted, and reversible by the user. See the divergence note in the
	// plan: §3.1 of the design says "identical treatment", written before §3.2 forbade the sentinel
	// on a part.
	it('refuses to delete a category that parts still carry, and names how many', async () => {
		expect.assertions(4);
		db.prisma.transactionSplit.count.mockResolvedValueOnce(3);

		const result = await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(result.status).toBe(400);
		expect(result.data?.error).toBe(m.categories_error_delete_used_by_splits_many({ count: 3 }));
		// Nothing at all happened: not the category, not the mapping, not the budget.
		expect(db.categories.some((cat) => cat.id === 'cat-alimentation')).toBe(true);
		expect(db.mappings).toHaveLength(1);
	});

	// An assertion about an ABSENCE, so it carries the condition that justifies it: a part stores a
	// categoryId and reads its name back through the relation, so a rename reaches every part for
	// free. If parts ever gain a denormalised category NAME — the obvious optimisation the day a
	// list render looks expensive — this test is what has to go red, because at that moment the
	// rename does need a second updateMany and forgetting it leaves parts showing the old name.
	it('needs no part write to rename a category, because parts reference it by id', async () => {
		expect.assertions(2);

		const result = await runAction('renameCategory', {
			id: 'cat-alimentation',
			newName: 'Courses'
		});

		expect(result.success).toBeTruthy();
		expect(db.prisma.transactionSplit.count).not.toHaveBeenCalled();
	});

	// The plan's own requirement: assert the DESTINATION, not that an href is a string. The claim is
	// that the link resolves to the transactions the count is about, and what makes that true is
	// OD-1 — so this test follows the link's own query string through the real predicate builder and
	// finds the parent whose PART carries the category. Written this way so that reverting OD-1
	// breaks it here, in the message that promises the link works.
	it('offers a link that really resolves to the transactions the count is about', async () => {
		expect.assertions(3);
		db.prisma.transactionSplit.count.mockResolvedValueOnce(2);

		const result = await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(result.data?.errorLink?.href).toBe('/transactions?category=Alimentation');
		expect(result.data?.errorLink?.label).toBe(m.categories_error_delete_used_by_splits_link());

		const url = new URL(result.data?.errorLink?.href ?? '', 'http://localhost');
		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'all',
			category: url.searchParams.get('category') ?? '',
			importBatchId: ''
		});
		expect(where.OR).toContainEqual({
			splits: {
				some: { category: { is: { userId: 'user-a', nameKey: computeNameKey('Alimentation') } } }
			}
		});
	});

	it('scopes the part count to the user own category row, never to the id alone', async () => {
		expect.assertions(1);
		db.prisma.transactionSplit.count.mockResolvedValueOnce(1);

		await runAction('deleteCategory', { id: 'cat-alimentation' });

		// The id is client-supplied. Counting on `categoryId` alone would answer a question about
		// another account's data — and here that answer decides whether an action is refused, so it
		// is an oracle an attacker could query.
		expect(db.prisma.transactionSplit.count).toHaveBeenCalledWith({
			where: { categoryId: 'cat-alimentation', category: { userId: 'user-a' } }
		});
	});

	it('réassigne les transactions à "Non catégorisé" en plus de nettoyer les orphelins', async () => {
		expect.assertions(3);
		db.prisma.transaction.count.mockResolvedValueOnce(3);

		const result = await runAction('deleteCategory', { id: 'cat-alimentation' });

		expect(db.prisma.transaction.updateMany).toHaveBeenNthCalledWith(1, {
			where: { categoryId: 'cat-alimentation', userId: 'user-a' },
			data: { categoryId: 'cat-non-classe' }
		});
		expect(result.success).toBeTruthy();
		expect(db.mappings).toHaveLength(0);
	});
});

describe('renameCategory — pas de régression sur le mapping', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.categories.length = 0;
		db.categories.push(
			{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
			{ id: 'cat-non-classe', userId: 'user-a', name: UNCLASSIFIED_CATEGORY, defaultKey: null }
		);
		db.mappings.length = 0;
		db.mappings.push({
			id: 'mapping-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			nature: 'spending'
		});
		db.budgets.length = 0;
		db.budgets.push({
			id: 'budget-alimentation',
			userId: 'user-a',
			categoryName: 'Alimentation',
			amountCents: 50_000
		});
		db.categoryRules.length = 0;
		db.categoryRules.push({
			id: 'rule-alimentation',
			userId: 'user-a',
			targetCategory: 'alimentation'
		});
		db.categorizationRules.length = 0;
		db.categorizationRules.push({
			id: 'legacy-rule-alimentation',
			userId: 'user-a',
			targetCategory: 'ALIMENTATION'
		});
	});

	it('fait suivre les cinq colonnes qui nomment la catégorie, quelle que soit leur casse', async () => {
		expect.assertions(5);

		await runAction('renameCategory', { id: 'cat-alimentation', newName: 'Courses' });

		// The measured defect: the budget stayed on "Alimentation" and /budgets tracked 0 spent.
		expect(db.budgets[0]).toMatchObject({
			categoryName: 'Courses',
			categoryNameKey: computeNameKey('Courses')
		});
		expect(db.mappings[0]).toMatchObject({ categoryName: 'Courses' });
		// The two keyless tables, both seeded in a different case: they follow only because the
		// rename folds through computeNameKey rather than matching the stored text.
		expect(db.categoryRules[0]).toMatchObject({ targetCategory: 'Courses' });
		expect(db.categorizationRules[0]).toMatchObject({ targetCategory: 'Courses' });
		// The second-order defect: applyCategoryRules writes targetCategory verbatim, so a rule
		// left behind keeps pinning a name no Category row holds onto NEW transactions.
		expect(db.prisma.transaction.updateMany).toHaveBeenCalledWith({
			where: { userId: 'user-a', manualCategoryKey: computeNameKey('Alimentation') },
			data: {
				manualCategory: 'Courses',
				manualCategoryKey: computeNameKey('Courses')
			}
		});
	});

	it("fait suivre le categoryName du mapping via updateMany (pas de suppression, pas d'orphelin)", async () => {
		expect.assertions(3);

		await runAction('renameCategory', { id: 'cat-alimentation', newName: 'Courses' });

		expect(db.prisma.categoryNatureMapping.deleteMany).not.toHaveBeenCalled();
		expect(db.prisma.categoryNatureMapping.updateMany).toHaveBeenCalledWith({
			where: { userId: 'user-a', categoryNameKey: computeNameKey('Alimentation') },
			data: { categoryName: 'Courses', categoryNameKey: computeNameKey('Courses') }
		});
		expect(db.mappings[0]).toMatchObject({ categoryName: 'Courses' });
	});
});

/**
 * The uniqueness check across locales.
 *
 * Every other describe in this file runs under the 'fr' pin from vitest.server.setup.ts, which
 * is also the locale in which this defect is invisible: in French the seeded default is stored
 * and displayed as "Alimentation", so the stored fold answers correctly and nothing is wrong.
 * Flipping the pin is therefore not a formatting detail here, it IS the condition under test —
 * the check has to be evaluated in the language the user is reading, and the previous one was
 * evaluated in the language the database was seeded in.
 */
describe('createCategory / renameCategory : le nom comparé est le nom stocké, dans toutes les langues (#162)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		overwriteGetLocale(() => 'en');
		db.categories.length = 0;
		db.categories.push(
			{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
			{ id: 'cat-non-classe', userId: 'user-a', name: UNCLASSIFIED_CATEGORY, defaultKey: null }
		);
	});

	afterEach(() => {
		// Restores the file-wide pin rather than leaving the last describe to run in English.
		overwriteGetLocale(() => 'fr');
	});

	it('ACCEPTE "Groceries" en anglais, là où c’était refusé avant #162', async () => {
		expect.assertions(2);

		// LE RENVERSEMENT, et c’est la moitié visible de l’option B. La ligne semée stockée
		// « Alimentation » s’affichait « Groceries », donc ce nom était pris sans qu’aucune ligne
		// ne le porte. Elle s’affiche désormais « Alimentation », « Groceries » est libre, et la
		// liste montrera deux lignes portant deux noms distincts au lieu de deux lignes que le
		// lecteur prend pour une seule.
		const result = await runAction('createCategory', { name: 'Groceries' });

		expect(result.status).toBeUndefined();
		expect(db.prisma.category.create).toHaveBeenCalled();
	});

	it('refuse le nom stocké, plié sur la casse, et nomme la ligne qui bloque', async () => {
		expect.assertions(3);

		const result = await runAction('createCategory', { name: 'ALIMENTATION' });

		expect(result.status).toBe(400);
		expect(db.prisma.category.create).not.toHaveBeenCalled();
		// Le refus nomme la ligne telle qu’elle est stockée, qui est exactement ce que
		// l’utilisateur a sous les yeux. Assertion sur la RAISON et pas seulement sur le refus :
		// deux gardes en série sont indiscernables d’une seule si l’on n’assert que le 400.
		expect(result.data?.error).toBe(m.categories_error_duplicate_named({ name: 'Alimentation' }));
	});

	it('donne la même réponse dans les deux langues, ce que #162 rend possible', async () => {
		expect.assertions(4);

		// La propriété centrale : la réponse ne dépend plus de la langue lue. Avant, cette même
		// paire d’appels donnait 400 en anglais et rien en français.
		for (const locale of ['en', 'fr'] as const) {
			overwriteGetLocale(() => locale);
			vi.clearAllMocks();
			// La table est remise à son état initial à CHAQUE tour, et pas seulement les mocks.
			// Sans cela, le « Groceries » créé au tour anglais est encore là au tour français, qui
			// le refuse alors très correctement : la deuxième itération mesurerait la fuite d’état
			// du test au lieu de la propriété visée.
			db.categories.length = 0;
			db.categories.push(
				{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
				{ id: 'cat-non-classe', userId: 'user-a', name: UNCLASSIFIED_CATEGORY, defaultKey: null }
			);

			expect((await runAction('createCategory', { name: 'Groceries' })).status).toBeUndefined();
			expect((await runAction('createCategory', { name: 'Alimentation' })).status).toBe(400);
		}
	});

	it('refuse le renommage vers le nom stocké d’une autre catégorie', async () => {
		expect.assertions(2);
		db.categories.push({ id: 'cat-loisirs', userId: 'user-a', name: 'Loisirs', defaultKey: null });

		const result = await runAction('renameCategory', {
			id: 'cat-loisirs',
			newName: 'Alimentation'
		});

		expect(result.status).toBe(400);
		expect(result.data?.error).toBe(m.categories_error_duplicate_named({ name: 'Alimentation' }));
	});

	it('laisse une catégorie se renommer en une variante de casse de son propre nom', async () => {
		expect.assertions(1);

		// Exclure la ligne elle-même est ce qui fait de ce contrôle une règle d’unicité plutôt
		// qu’un gel : la ligne renommée ne doit pas compter comme son propre conflit.
		const result = await runAction('renameCategory', {
			id: 'cat-alimentation',
			newName: 'alimentation'
		});

		expect(result.status).toBeUndefined();
	});

	it('réserve le libellé affiché de la pile « à classer », pas seulement son slug', async () => {
		expect.assertions(4);

		for (const typed of [
			m.common_category_uncategorized(),
			// The label of the OTHER locale too: allowing it only defers the collision to the day
			// the user switches language, and the pile can never be renamed out of the way.
			m.common_category_uncategorized({}, { locale: 'fr' })
		]) {
			const result = await runAction('createCategory', { name: typed });

			expect(result.status).toBe(400);
			expect(result.data?.error).toBe(m.categories_error_reserved_name());
		}
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
		request: new Request('http://localhost/categories', { method: 'POST', body: formData })
	})) as {
		status?: number;
		success?: string;
		data?: { error?: string; errorLink?: { href: string; label: string } };
	};
}

// #161: the delete dialog states the consequence BEFORE the action, so `load` has to carry the
// number of rules each category would pause. The user is thinking about transactions when they
// delete a category, not about a rule they wrote three months ago; the dialog is the only moment
// they hold both, and a count computed after the fact would arrive too late to be a choice.
describe('load — rules a delete would pause', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.categories.length = 0;
		db.categories.push(
			{ id: 'cat-loisirs', userId: 'user-a', name: 'Loisirs', defaultKey: null },
			{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' }
		);
		db.categoryRules.length = 0;
		db.mappings.length = 0;
	});

	async function loadCategories() {
		const data = (await load({ locals: { user: testUser } } as Parameters<typeof load>[0])) as {
			categories: Array<{ name: string; pausedRuleCount: number }>;
		};
		return new Map(data.categories.map((category) => [category.name, category.pausedRuleCount]));
	}

	it('counts the rules that target a category, folding case as the delete does', async () => {
		expect.assertions(2);

		// Two spellings of one category. The delete matches on `computeNameKey`, so both rules
		// follow it, and a count that compared raw text would under-report by one and understate the
		// consequence in the one sentence the user reads before deciding.
		db.categoryRules.push(
			{ id: 'r1', userId: 'user-a', targetCategory: 'Loisirs' },
			{ id: 'r2', userId: 'user-a', targetCategory: 'loisirs' }
		);

		const counts = await loadCategories();

		expect(counts.get('Loisirs')).toBe(2);
		expect(counts.get('Alimentation')).toBe(0);
	});

	it("does not count another user's rules", async () => {
		expect.assertions(1);

		db.categoryRules.push({ id: 'r-other', userId: 'user-b', targetCategory: 'Loisirs' });

		expect((await loadCategories()).get('Loisirs')).toBe(0);
	});

	it('reports zero rather than omitting the field when nothing targets the category', async () => {
		expect.assertions(1);

		// The dialog renders the line only above zero, so an `undefined` here would read as "no
		// rules" and be indistinguishable from a real count that failed to arrive.
		expect((await loadCategories()).get('Loisirs')).toBe(0);
	});
});

// #162's rename prompt, at the seam the unit spec beside `planDefaultCategoryRenames` cannot
// reach: the load's decision to SHOW it. The plan and the dismissal are two independent inputs,
// and the whole design rests on only one of them being stored, so both directions are asserted
// here rather than inferred from the schema docstring.
describe('load — the rename prompt (#162)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.promptDismissal.at = null;
		db.categories.length = 0;
		db.categories.push(
			{ id: 'cat-alimentation', userId: 'user-a', name: 'Alimentation', defaultKey: 'food' },
			{ id: 'cat-mine', userId: 'user-a', name: 'Mes courses', defaultKey: null }
		);
		db.categoryRules.length = 0;
		db.mappings.length = 0;
	});

	afterEach(() => {
		overwriteGetLocale(() => 'fr');
	});

	async function loadPrompt() {
		const data = (await load({ locals: { user: testUser } } as Parameters<typeof load>[0])) as {
			renamePrompt: { count: number; blockedByExistingName: number } | null;
		};
		return data.renamePrompt;
	}

	it('offers the rename to a reader whose language renders the name differently', async () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		const prompt = await loadPrompt();

		// One, not two: "Mes courses" is a name the user chose and nothing may offer to change it.
		expect(prompt).not.toBeNull();
		expect(prompt?.count).toBe(1);
	});

	it('offers NOTHING to a French reader, which is the migration no-op seen from the UI', async () => {
		expect.assertions(1);
		overwriteGetLocale(() => 'fr');

		// The same rows, the same code, a different reader. No condition anywhere special-cases
		// French: the plan is empty because the catalogue renders "Alimentation" as "Alimentation".
		expect(await loadPrompt()).toBeNull();
	});

	it('goes quiet once the user has dismissed it', async () => {
		expect.assertions(2);
		overwriteGetLocale(() => 'en');

		// APPEAR then DISAPPEAR, never absence-then-hope: asserting the prompt is present first is
		// what proves this fixture can produce one at all, so the null below means the dismissal did
		// it rather than the fixture never having had anything to offer.
		expect(await loadPrompt()).not.toBeNull();

		await runAction('dismissRenamePrompt', {});

		expect(await loadPrompt()).toBeNull();
	});

	it('dismissing does not touch a single category name', async () => {
		expect.assertions(1);
		overwriteGetLocale(() => 'en');

		const before = db.categories.map((category) => category.name);
		await runAction('dismissRenamePrompt', {});

		expect(db.categories.map((category) => category.name)).toEqual(before);
	});

	it('stops offering on its own once the names have been adopted, with nothing dismissed', async () => {
		expect.assertions(3);
		overwriteGetLocale(() => 'en');

		expect(await loadPrompt()).not.toBeNull();

		await runAction('adoptDefaultNames', {});

		// The derived half going false is what silences it, so the stored flag is still null. That
		// is the property the schema docstring claims and the reason a user who renames a category
		// back, or switches language, is offered it again.
		expect(await loadPrompt()).toBeNull();
		expect(db.promptDismissal.at).toBeNull();
	});
});
