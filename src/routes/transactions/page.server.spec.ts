import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { computeNameKey, computeNullableNameKey } from '$lib/server/naming/nameKey';

const db = vi.hoisted(() => {
	interface MockTransaction {
		id: string;
		userId: string;
		date: Date;
		label: string;
		amountCents: number;
		type: string;
		source: string;
		manualCategory: string | null;
		natureManual: string | null;
		notes: string | null;
		dedupeKey: string | null;
		metadataJson: string | null;
		createdAt: Date;
		updatedAt: Date;
		categoryId: string;
		category: { name: string };
		account: {
			name: string;
			source: string;
			netWorthAccount?: { name: string } | null;
		} | null;
		importBatch: {
			id: string;
			fileName: string | null;
			source: string;
			rowCount: number;
			createdAt: Date;
		} | null;
	}

	// Category name -> id, mirrors the Prisma unique (userId, name) index used by
	// resolveUncategorizedCategoryId and the `category: { is: { userId, name } } }` relation filter.
	// Literal 'uncategorized' instead of the UNCLASSIFIED_CATEGORY import: vi.hoisted() factories
	// run before ES module imports are initialized, so the imported binding isn't available here.
	const CATEGORY_IDS: Record<string, string> = {
		Alimentation: 'cat-alimentation',
		Autre: 'cat-autre',
		uncategorized: 'cat-uncategorized'
	};

	const transactions: MockTransaction[] = Array.from({ length: 30 }, (_, index) => ({
		id: `transaction-${index + 1}`,
		userId: 'user-a',
		date: new Date(`2026-06-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
		label: index === 0 ? 'AUCHAN COURSES' : `Transaction ${index + 1}`,
		amountCents: index % 2 === 0 ? 3_000 : 15_000,
		type: index % 2 === 0 ? 'expense' : 'income',
		source: index === 0 ? 'banque_populaire' : 'csv',
		manualCategory: index === 0 ? 'Loisirs' : null,
		natureManual: index === 0 ? 'fee' : null,
		notes: 'AUCHAN 0065 SC 78MAUREPAS | 210626 CB****2593-30,00EUR',
		dedupeKey: '2026-06-22|auchan courses|3000|expense|80FDBFG|export.csv',
		metadataJson: JSON.stringify({
			reference: '80FDBFG',
			csvFields: {
				'Date de comptabilisation': '22/06/2026',
				'Libelle simplifie': 'AUCHAN',
				'Libelle operation': 'AUCHAN 0065 SC 78MAUREPAS',
				Reference: '80FDBFG',
				'Informations complementaires': '210626 CB****2593-30,00EUR',
				'Type operation': 'Carte bancaire',
				Categorie: 'Alimentation',
				'Sous categorie': 'Hyper/supermarche',
				Debit: '-30,00',
				'Date operation': '22/06/2026'
			}
		}),
		createdAt: new Date('2026-06-24T10:00:00.000Z'),
		updatedAt: new Date('2026-06-24T11:00:00.000Z'),
		categoryId: index === 0 ? CATEGORY_IDS.Alimentation : CATEGORY_IDS.Autre,
		category: { name: index === 0 ? 'Alimentation' : 'Autre' },
		account: { name: 'Compte import CSV', source: 'banque_populaire' },
		importBatch: {
			id: 'batch-123456',
			fileName: 'export.csv',
			source: 'banque_populaire',
			rowCount: 30,
			createdAt: new Date('2026-06-24T09:00:00.000Z')
		}
	}));

	// One row belonging to ANOTHER user, so that a `where` which lost its `userId` conjunct has
	// something to leak instead of quietly still passing. Invisible to every other test in this
	// file: they all go through buildTransactionWhere, which filters by userId: 'user-a'.
	transactions.push({
		...transactions[0],
		id: 'transaction-foreign',
		userId: 'user-b',
		label: 'FOREIGN MERCHANT',
		manualCategory: null,
		natureManual: null,
		categoryId: CATEGORY_IDS.Autre,
		category: { name: 'Autre' }
	});

	// Faithfully evaluates the subset of Prisma `where` shapes actually used by the app code:
	// scalar equality (userId, type, manualCategory, categoryId, importBatchId...), `id: { in }`,
	// `date: { gte, lt }`, nested `category: { is: { userId, name } } }`, and recursive `OR`/`AND`.
	function matchesWhere(t: MockTransaction, where: Record<string, unknown> | undefined): boolean {
		if (!where) return true;
		for (const [key, value] of Object.entries(where)) {
			if (key === 'OR') {
				if (!(value as Array<Record<string, unknown>>).some((cond) => matchesWhere(t, cond)))
					return false;
				continue;
			}
			if (key === 'AND') {
				if (!(value as Array<Record<string, unknown>>).every((cond) => matchesWhere(t, cond)))
					return false;
				continue;
			}
			if (key === 'category') {
				const is = (value as { is: { userId?: string; nameKey: string } }).is;
				if (computeNameKey(t.category.name) !== is.nameKey) return false;
				if (is.userId && t.userId !== is.userId) return false;
				continue;
			}
			if (key === 'date') {
				const range = value as { gte?: Date; lt?: Date };
				const time = t.date.getTime();
				if (range.gte && time < range.gte.getTime()) return false;
				if (range.lt && time >= range.lt.getTime()) return false;
				continue;
			}
			if (key === 'id') {
				if (typeof value === 'string') {
					if (t.id !== value) return false;
				} else if (value && typeof value === 'object' && 'in' in value) {
					if (!(value as { in: string[] }).in.includes(t.id)) return false;
				}
				continue;
			}
			if (key === 'manualCategoryKey') {
				// Derived, not stored on the fixture: the key is a pure function of the name.
				if (computeNullableNameKey(t.manualCategory) !== value) return false;
				continue;
			}
			// Operator objects on a plain scalar field, e.g. `type: { notIn: [...] }` or
			// `amountCents: { gte: 0 }` — the shapes transactionKindWhere emits (totals.ts).
			if (value && typeof value === 'object' && !(value instanceof Date)) {
				const actual = (t as unknown as Record<string, unknown>)[key];
				const cond = value as {
					in?: unknown[];
					notIn?: unknown[];
					gte?: number;
					gt?: number;
					lte?: number;
					lt?: number;
				};
				if (cond.in && !cond.in.includes(actual)) return false;
				if (cond.notIn && cond.notIn.includes(actual)) return false;
				if (cond.gte !== undefined && !((actual as number) >= cond.gte)) return false;
				if (cond.gt !== undefined && !((actual as number) > cond.gt)) return false;
				if (cond.lte !== undefined && !((actual as number) <= cond.lte)) return false;
				if (cond.lt !== undefined && !((actual as number) < cond.lt)) return false;
				continue;
			}
			// Scalar fields: userId, type, importBatchId, manualCategory, natureManual, categoryId...
			if ((t as unknown as Record<string, unknown>)[key] !== value) return false;
		}
		return true;
	}

	function filterTransactions(where: Record<string, unknown> | undefined): MockTransaction[] {
		return transactions.filter((t) => matchesWhere(t, where));
	}

	return {
		transactions,
		CATEGORY_IDS,
		prisma: {
			transaction: {
				// Faithfully applies `where` (see matchesWhere) plus cursor/skip/take pagination —
				// real sorting is delegated to SQLite in production, so this mock trusts the fixture's
				// insertion order as the "already sorted" order instead of re-sorting by `orderBy`
				// (several tests assert on that stable insertion order directly, see the
				// "classifyStackIds (mode focus)" describe block below).
				findMany: vi.fn(
					async ({
						where,
						skip,
						take,
						cursor
					}: {
						where?: Record<string, unknown>;
						skip?: number;
						take?: number;
						cursor?: { id: string };
					} = {}) => {
						let result = filterTransactions(where);
						if (cursor?.id) {
							const idx = result.findIndex((t) => t.id === cursor.id);
							result = idx === -1 ? [] : result.slice(idx + (skip ?? 0));
						} else if (typeof skip === 'number') {
							result = result.slice(skip);
						}
						if (typeof take === 'number') result = result.slice(0, take);
						return result;
					}
				),
				count: vi.fn(
					async ({ where }: { where?: Record<string, unknown> } = {}) =>
						filterTransactions(where).length
				),
				aggregate: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
					const matched = filterTransactions(where);
					const sum = matched.reduce((total, t) => total + t.amountCents, 0);
					return { _sum: { amountCents: matched.length > 0 ? sum : null } };
				}),
				findFirst: vi.fn(
					async ({ where }) => transactions.find((item) => item.id === where.id) ?? null
				),
				updateMany: vi.fn(async ({ where, data }) => {
					if (where.userId !== 'user-a') return { count: 0 };
					const ids: string[] = where.id?.in ?? (where.id ? [where.id] : []);
					let count = 0;
					for (const id of ids) {
						const transaction = transactions.find((item) => item.id === id);
						if (!transaction) continue;
						if ('manualCategory' in where && transaction.manualCategory !== where.manualCategory)
							continue;
						if ('manualCategory' in data) transaction.manualCategory = data.manualCategory;
						// manualCategoryKey rides along with manualCategory in the real write path.
						if ('natureManual' in data) transaction.natureManual = data.natureManual;
						count++;
					}
					return { count };
				}),
				deleteMany: vi.fn(async ({ where }) => {
					const index = transactions.findIndex(
						(item) => item.id === where.id && where.userId === 'user-a'
					);
					if (index === -1) return { count: 0 };
					transactions.splice(index, 1);
					return { count: 1 };
				})
			},
			categoryNatureMapping: {
				findMany: vi.fn(async () => [{ categoryName: 'Loisirs', nature: 'investment' }])
			},
			category: {
				findMany: vi.fn(async () => [
					{ name: 'Alimentation' },
					{ name: 'Autre' },
					{ name: 'uncategorized' }
				]),
				findFirst: vi.fn(async ({ where }: { where: { userId: string; nameKey: string } }) => {
					const found = Object.entries(CATEGORY_IDS).find(
						([name]) => computeNameKey(name) === where.nameKey
					);
					return found ? { id: found[1], name: found[0] } : null;
				})
			},
			categoryRule: {
				findMany: vi.fn(async () => [...categoryRules]),
				create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
					const rule = {
						id: `rule-${categoryRules.length + 1}`,
						isRegex: false,
						enabled: true,
						targetNature: null,
						...data
					};
					categoryRules.push(rule as (typeof categoryRules)[number]);
					return rule;
				})
			}
		}
	};
});

// Separate from `db` (vi.hoisted) to stay mutable/resettable per test — categoryRule.create
// pushes rules created in the session here, categoryRule.findMany reads them back (to test
// applyCategoryRules in the same test as the creation, see describe createRule below).
const categoryRules: Array<{
	id: string;
	name: string;
	matchText: string;
	targetCategory: string;
	targetNature: string | null;
	isRegex: boolean;
	enabled: boolean;
}> = [];

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { actions, load } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

interface TestTransactionPageData {
	transactions: Array<{ id: string; category: string; isManualCategory: boolean }>;
	uncategorizedCount: number;
	classifiableCount: number;
	selectedTransaction: {
		category: string;
		importedCategory: string;
		manualCategory: string | null;
		manualNature: string | null;
		nature: string;
		natureSource: string;
		isManualCategory: boolean;
		reference: string | null;
		dedupeKey: string | null;
		bankFields: Array<{ label: string; value: string }>;
		account: {
			name: string;
			source: string;
			netWorthAccountName: string | null;
		} | null;
	} | null;
	pagination: {
		pageSize: number;
		hasNext: boolean;
		totalTransactions: number;
	};
	queryError: boolean;
	classifyStackIds: string[];
	filters: { ids: string };
	filteredTotals: { incomeCents: number; expenseCents: number };
}

describe('/transactions load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('displays a paginated list of 25 transactions by default', async () => {
		expect.assertions(4);

		const data = await runLoad('/transactions');

		expect(data.transactions).toHaveLength(25);
		expect(data.pagination.pageSize).toBe(25);
		expect(data.pagination.hasNext).toBe(true);
		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ skip: 0, take: 25 })
		);
	});

	it('totals the whole filtered set, not the current page', async () => {
		expect.assertions(1);

		// 30 rows, PAGE_SIZE is 25: a page-scoped total would report 13 expense rows' worth
		// (indices 0-24 on page 1), not the full 15 expense rows' worth (45000).
		const data = await runLoad('/transactions');

		expect(data.filteredTotals.expenseCents).toBe(45_000);
	});

	it('reports zero totals when the filter is in error', async () => {
		expect.assertions(1);

		const data = await runLoad('/transactions?qMode=regex&q=%28unclosed');

		expect(data.filteredTotals).toEqual({ incomeCents: 0, expenseCents: 0 });
	});

	it('applies the label search, case- and accent-insensitive', async () => {
		expect.assertions(2);

		const data = await runLoad('/transactions?q=auchan');

		expect(data.transactions).toHaveLength(1);
		expect(data.transactions[0].id).toBe('transaction-1');
	});

	it('rejects an invalid regex in the filter (qMode=regex) without crashing', async () => {
		expect.assertions(2);

		const data = await runLoad('/transactions?q=%28unclosed&qMode=regex');

		expect(data.transactions).toHaveLength(0);
		expect(data.queryError).toBe(true);
	});

	// `?ids=` is the "Voir les transactions liées" link from /upcoming-bills: raw client input
	// naming rows directly, so these cover the ownership scope, the shape validation and the bound.
	describe('filtre ?ids=', () => {
		it('ne retourne que les transactions demandées', async () => {
			expect.assertions(2);

			const data = await runLoad('/transactions?ids=transaction-3,transaction-7');

			expect(data.transactions.map((t) => t.id)).toEqual(['transaction-3', 'transaction-7']);
			expect(data.filters.ids).toBe('transaction-3,transaction-7');
		});

		it('ne retourne JAMAIS la transaction d’un autre utilisateur, même nommée explicitement', async () => {
			expect.assertions(2);

			const data = await runLoad('/transactions?ids=transaction-foreign,transaction-3');

			expect(data.transactions.map((t) => t.id)).toEqual(['transaction-3']);
			expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						userId: 'user-a',
						id: { in: ['transaction-foreign', 'transaction-3'] }
					})
				})
			);
		});

		it('ne retourne rien quand seule une transaction étrangère est demandée', async () => {
			expect.assertions(1);

			const data = await runLoad('/transactions?ids=transaction-foreign');

			expect(data.transactions).toEqual([]);
		});

		it('ne matche rien (et n’élargit pas à tout l’historique) quand tous les ids sont malformés', async () => {
			expect.assertions(2);

			const data = await runLoad('/transactions?ids=short,%27%3B%20DROP%20TABLE');

			expect(data.transactions).toEqual([]);
			expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({ userId: 'user-a', id: { in: [] } })
				})
			);
		});

		it('s’INTERSECTE avec les autres filtres au lieu de les remplacer', async () => {
			expect.assertions(2);

			// transaction-3 is an expense, transaction-4 an income (index parity, see the fixture).
			const data = await runLoad('/transactions?type=income&ids=transaction-3,transaction-4');

			expect(data.transactions.map((t) => t.id)).toEqual(['transaction-4']);
			expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						userId: 'user-a',
						type: 'income',
						id: { in: ['transaction-3', 'transaction-4'] }
					})
				})
			);
		});

		// The stated reason buildPageHref carries `ids`: 250 ids over 25 per page is 10 pages, so a
		// filtered view that lost the param on page 2 would silently show the whole history instead.
		//
		// The id list is a STRICT SUBSET (26 of the fixture's 30 owned transactions), not the whole
		// fixture: with all 30 ids, dropping the `ids` filter entirely produces identical totals and
		// page contents, so the test could not fail. 26 ids over 25 per page still exercises two
		// pages (25 then 1) while keeping the filtered totals genuinely different from the
		// unfiltered 30.
		it('reste paginé DANS la liste d’ids, page 2 comprise', async () => {
			expect.assertions(3);

			const twentySix = Array.from({ length: 26 }, (_, i) => `transaction-${i + 1}`).join(',');
			const first = await runLoad(`/transactions?ids=${twentySix}`);
			const second = await runLoad(`/transactions?ids=${twentySix}&page=2`);

			expect(first.pagination.totalTransactions).toBe(26);
			expect(first.transactions).toHaveLength(25);
			// 26 owned ids, not the fixture's full 30-row history: the filter survived the second load.
			expect(second.transactions).toHaveLength(1);
		});

		it('borne la liste avant de la passer à Prisma', async () => {
			expect.assertions(1);

			const overLong = Array.from({ length: 2_000 }, (_, index) => `transaction-${index}`).join(
				','
			);
			await runLoad(`/transactions?ids=${overLong}`);

			const call = db.prisma.transaction.findMany.mock.calls.at(-1)?.[0] as {
				where: { id: { in: string[] } };
			};

			expect(call.where.id.in.length).toBeLessThanOrEqual(250);
		});
	});

	it('applique le filtre income/expense', async () => {
		expect.assertions(1);

		await runLoad('/transactions?type=income');

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ type: 'income' })
			})
		);
	});

	it('applies the category filter', async () => {
		expect.assertions(1);

		await runLoad('/transactions?category=Alimentation');

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					// Filtered on the folded key on both branches, so "alimentation" and
					// "Alimentation" select the same rows on every database engine.
					OR: [
						{ manualCategoryKey: computeNameKey('Alimentation') },
						{
							AND: [
								{ manualCategory: null },
								{
									category: {
										is: { userId: testUser.id, nameKey: computeNameKey('Alimentation') }
									}
								}
							]
						}
					]
				})
			})
		);
	});

	it('filtre les transactions d’un import batch', async () => {
		expect.assertions(1);

		await runLoad('/transactions?importBatch=batch-123456');

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ importBatchId: 'batch-123456' })
			})
		);
	});

	it('loads the selected detail with the Banque Populaire metadata', async () => {
		expect.assertions(10);

		const data = await runLoad('/transactions?selected=transaction-1');

		expect(db.prisma.transaction.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: 'transaction-1', userId: testUser.id } })
		);
		expect(data.selectedTransaction?.reference).not.toContain('80FDBFG');
		expect(data.selectedTransaction?.category).toBe('Loisirs');
		expect(data.selectedTransaction?.importedCategory).toBe('Alimentation');
		expect(data.selectedTransaction?.manualCategory).toBe('Loisirs');
		expect(data.selectedTransaction?.manualNature).toBe('fee');
		expect(data.selectedTransaction?.isManualCategory).toBe(true);
		expect(data.selectedTransaction?.bankFields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: 'Libelle operation' }),
				expect.objectContaining({
					label: 'Informations complementaires',
					value: expect.stringContaining('CB****')
				})
			])
		);
		expect(
			data.selectedTransaction?.bankFields.map((field) => field.value).join(' ')
		).not.toContain('2593');
		expect(data.selectedTransaction?.dedupeKey).not.toContain('80FDBFG');
	});

	it('displays the manual nature with priority in the detail', async () => {
		expect.assertions(2);

		const data = await runLoad('/transactions?selected=transaction-1');

		expect(data.selectedTransaction?.nature).toBe('fee');
		expect(data.selectedTransaction?.natureSource).toBe('manual');
	});

	it('exposes the linked NetWorthAccount name on account.netWorthAccountName when the technical Account is linked', async () => {
		expect.assertions(3);

		db.transactions.push({
			id: 'transaction-linked-account',
			userId: 'user-a',
			date: new Date('2026-06-10T00:00:00.000Z'),
			label: 'Loyer',
			amountCents: -80_000,
			type: 'expense',
			source: 'csv',
			manualCategory: null,
			natureManual: null,
			notes: null,
			dedupeKey: 'linked-account-dedupe-key',
			metadataJson: null,
			createdAt: new Date('2026-06-10T10:00:00.000Z'),
			updatedAt: new Date('2026-06-10T10:00:00.000Z'),
			category: { name: 'Alimentation' },
			categoryId: db.CATEGORY_IDS.Alimentation,
			account: {
				name: 'Compte courant',
				source: 'csv',
				netWorthAccount: { name: 'Compte courant Boursorama' }
			},
			importBatch: null
		});

		const data = await runLoad('/transactions?selected=transaction-linked-account');

		expect(data.selectedTransaction?.account?.name).toBe('Compte courant');
		expect(data.selectedTransaction?.account?.source).toBe('csv');
		expect(data.selectedTransaction?.account?.netWorthAccountName).toBe(
			'Compte courant Boursorama'
		);

		db.transactions.splice(
			db.transactions.findIndex((t) => t.id === 'transaction-linked-account'),
			1
		);
	});

	it('returns account.netWorthAccountName: null when the technical Account has no NetWorthAccount link', async () => {
		expect.assertions(3);

		db.transactions.push({
			id: 'transaction-unlinked-account',
			userId: 'user-a',
			date: new Date('2026-06-10T00:00:00.000Z'),
			label: 'Loyer',
			amountCents: -80_000,
			type: 'expense',
			source: 'csv',
			manualCategory: null,
			natureManual: null,
			notes: null,
			dedupeKey: 'unlinked-account-dedupe-key',
			metadataJson: null,
			createdAt: new Date('2026-06-10T10:00:00.000Z'),
			updatedAt: new Date('2026-06-10T10:00:00.000Z'),
			category: { name: 'Alimentation' },
			categoryId: db.CATEGORY_IDS.Alimentation,
			account: { name: 'Compte courant', source: 'csv', netWorthAccount: null },
			importBatch: null
		});

		const data = await runLoad('/transactions?selected=transaction-unlinked-account');

		expect(data.selectedTransaction?.account?.name).toBe('Compte courant');
		expect(data.selectedTransaction?.account?.source).toBe('csv');
		expect(data.selectedTransaction?.account?.netWorthAccountName).toBeNull();

		db.transactions.splice(
			db.transactions.findIndex((t) => t.id === 'transaction-unlinked-account'),
			1
		);
	});

	it('leaves the whole account field null (no crash) when the transaction has no technical Account at all', async () => {
		expect.assertions(3);

		db.transactions.push({
			id: 'transaction-no-account',
			userId: 'user-a',
			date: new Date('2026-06-10T00:00:00.000Z'),
			label: 'Loyer',
			amountCents: -80_000,
			type: 'expense',
			source: 'csv',
			manualCategory: null,
			natureManual: null,
			notes: null,
			dedupeKey: 'no-account-dedupe-key',
			metadataJson: null,
			createdAt: new Date('2026-06-10T10:00:00.000Z'),
			updatedAt: new Date('2026-06-10T10:00:00.000Z'),
			category: { name: 'Alimentation' },
			categoryId: db.CATEGORY_IDS.Alimentation,
			account: null,
			importBatch: null
		});

		const data = await runLoad('/transactions?selected=transaction-no-account');

		expect(data.selectedTransaction).not.toBeNull();
		expect(data.selectedTransaction?.account).toBeNull();
		expect(data.selectedTransaction?.category).toBe('Alimentation');

		db.transactions.splice(
			db.transactions.findIndex((t) => t.id === 'transaction-no-account'),
			1
		);
	});

	it('displays the manual category with priority in the list', async () => {
		expect.assertions(2);

		const data = await runLoad('/transactions');

		expect(data.transactions[0].category).toBe('Loisirs');
		expect(data.transactions[0].isManualCategory).toBe(true);
	});

	it("updates the manual category only for the current user's transaction", async () => {
		expect.assertions(3);

		const result = await runSaveManualCategory({
			transactionId: 'transaction-1',
			manualCategory: '  Alimentation  '
		});

		expect(result).toEqual({ manualCategorySuccess: true });
		expect(db.prisma.transaction.updateMany).toHaveBeenCalledWith({
			where: { id: 'transaction-1', userId: testUser.id },
			data: {
				manualCategory: 'Alimentation',
				manualCategoryKey: computeNameKey('Alimentation')
			}
		});
		expect(db.transactions[0].manualCategory).toBe('Alimentation');
	});

	it('refuse de modifier une transaction d’un autre user', async () => {
		expect.assertions(2);

		const result = await runSaveManualCategory({
			transactionId: 'other-user-transaction',
			manualCategory: 'Alimentation'
		});

		expect(result.status).toBe(404);
		expect(db.prisma.transaction.updateMany).toHaveBeenCalledWith({
			where: { id: 'other-user-transaction', userId: testUser.id },
			data: {
				manualCategory: 'Alimentation',
				manualCategoryKey: computeNameKey('Alimentation')
			}
		});
	});

	it('always creates a rule with isRegex: false via the quick "create a rule from a transaction" flow', async () => {
		expect.assertions(1);

		await runCreateRule({
			name: 'Depuis transaction',
			matchText: 'AUCHAN',
			targetCategory: 'Alimentation'
		});

		expect(db.prisma.categoryRule.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ isRegex: false }) })
		);
	});

	it('removes the override when the category is empty', async () => {
		expect.assertions(1);

		await runSaveManualCategory({
			transactionId: 'transaction-1',
			manualCategory: '   '
		});

		expect(db.prisma.transaction.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { manualCategory: null, manualCategoryKey: null } })
		);
	});

	it('rejects a manual category that is too long', async () => {
		expect.assertions(2);

		const result = await runSaveManualCategory({
			transactionId: 'transaction-1',
			manualCategory: 'x'.repeat(61)
		});

		expect(result.status).toBe(400);
		expect(db.prisma.transaction.updateMany).not.toHaveBeenCalled();
	});

	it('rejects control characters in the manual category', async () => {
		expect.assertions(2);

		const result = await runSaveManualCategory({
			transactionId: 'transaction-1',
			manualCategory: 'Santé\u0000'
		});

		expect(result.status).toBe(400);
		expect(db.prisma.transaction.updateMany).not.toHaveBeenCalled();
	});

	it('modifie la nature manuelle uniquement pour la transaction du user courant', async () => {
		expect.assertions(3);

		const result = await runSaveManualNature({
			transactionId: 'transaction-1',
			manualNature: 'investment'
		});

		expect(result).toEqual({ manualNatureSuccess: true });
		expect(db.prisma.transaction.updateMany).toHaveBeenCalledWith({
			where: { id: 'transaction-1', userId: testUser.id },
			data: { natureManual: 'investment' }
		});
		expect(db.transactions[0].natureManual).toBe('investment');
	});

	it('resets the manual nature', async () => {
		expect.assertions(1);

		await runSaveManualNature({
			transactionId: 'transaction-1',
			manualNature: ''
		});

		expect(db.prisma.transaction.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { natureManual: null } })
		);
	});

	it('refuse une nature invalide', async () => {
		expect.assertions(2);

		const result = await runSaveManualNature({
			transactionId: 'transaction-1',
			manualNature: 'weird'
		});

		expect(result.status).toBe(400);
		expect(db.prisma.transaction.updateMany).not.toHaveBeenCalled();
	});

	it('permanently deletes a transaction of the current user', async () => {
		expect.assertions(3);

		const result = await runDeleteTransaction({ transactionId: 'transaction-2' });

		expect(result).toEqual({ deleteSuccess: true });
		expect(db.prisma.transaction.deleteMany).toHaveBeenCalledWith({
			where: { id: 'transaction-2', userId: testUser.id }
		});
		expect(db.transactions.find((t) => t.id === 'transaction-2')).toBeUndefined();
	});

	it('refuse de supprimer avec un identifiant de transaction invalide', async () => {
		expect.assertions(2);

		const result = await runDeleteTransaction({ transactionId: '' });

		expect(result.status).toBe(400);
		expect(db.prisma.transaction.deleteMany).not.toHaveBeenCalled();
	});

	it('refuse de supprimer une transaction d’un autre user', async () => {
		expect.assertions(3);
		const before = db.transactions.length;

		const result = await runDeleteTransaction({ transactionId: 'other-user-transaction' });

		expect(result.status).toBe(404);
		expect(db.prisma.transaction.deleteMany).toHaveBeenCalledWith({
			where: { id: 'other-user-transaction', userId: testUser.id }
		});
		expect(db.transactions.length).toBe(before);
	});
});

describe('/transactions load — "to classify" pile', () => {
	afterEach(() => {
		const index = db.transactions.findIndex((t) => t.id === 'transaction-unclassified');
		if (index !== -1) db.transactions.splice(index, 1);
	});

	it('counts a transaction as "to classify" when its effective category is the UNCLASSIFIED_CATEGORY sentinel (not a translated name)', async () => {
		expect.assertions(2);

		const baseline = await runLoad('/transactions');

		db.transactions.push({
			id: 'transaction-unclassified',
			userId: 'user-a',
			date: new Date('2026-06-15T00:00:00.000Z'),
			label: 'Mystery payment',
			amountCents: -2_000,
			type: 'expense',
			source: 'csv',
			manualCategory: null,
			natureManual: null,
			notes: null,
			dedupeKey: 'mystery-dedupe-key',
			metadataJson: null,
			createdAt: new Date('2026-06-15T10:00:00.000Z'),
			updatedAt: new Date('2026-06-15T10:00:00.000Z'),
			category: { name: UNCLASSIFIED_CATEGORY },
			categoryId: db.CATEGORY_IDS[UNCLASSIFIED_CATEGORY],
			account: { name: 'Compte import CSV', source: 'csv' },
			importBatch: null
		});
		db.prisma.categoryRule.findMany.mockResolvedValueOnce([
			{
				id: 'r1',
				name: 'Regle mystery',
				matchText: 'mystery',
				targetCategory: 'Loisirs',
				targetNature: null,
				isRegex: false,
				enabled: true
			}
		]);

		const withUnclassified = await runLoad('/transactions');

		expect(withUnclassified.uncategorizedCount).toBe(baseline.uncategorizedCount + 1);
		expect(withUnclassified.classifiableCount).toBeGreaterThanOrEqual(1);
	});
});

describe('/transactions load — classifyStackIds (mode focus)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		const index = db.transactions.findIndex((t) => t.id === 'transaction-focus-unclassified');
		if (index !== -1) db.transactions.splice(index, 1);
	});

	it('computes uncategorizedCount in pure SQL (count) and classifyStackIds via a single capped findMany, never an unbounded full-history scan', async () => {
		const data = await runLoad('/transactions');

		// Every transaction.findMany call issued while loading the page must be bounded — either
		// by an explicit `take` (capped pile / paginated list / batched rule-matching scan) or by
		// an `id: { in }` scope — never a plain "everything for this user" fetch (see CLAUDE.md
		// technical debt: rawForClassify without take, now removed).
		const findManyCalls = db.prisma.transaction.findMany.mock.calls as Array<
			[{ where?: { id?: { in?: string[] } }; take?: number }]
		>;
		expect(findManyCalls.length).toBeGreaterThan(0);
		for (const [args] of findManyCalls) {
			expect(typeof args.take === 'number' || Boolean(args.where?.id?.in)).toBe(true);
		}

		// The capped findMany feeding classifyStackIds is scoped to the current user and ordered by
		// (date desc, id desc) for a stable cursor — see forEachTransactionBatch/classifyStackRows.
		const classifyStackCall = findManyCalls.find(
			(call) => (call[0] as { take?: number }).take === 5000
		);
		expect(classifyStackCall?.[0]).toMatchObject({ where: { userId: testUser.id } });

		// classifyStackIds must be an exact subset of the "Non catégorisé" transactions counted by
		// uncategorizedCount (both derived from the same `classify` where clause), never a
		// disjoint/incomplete pile.
		expect(data.classifyStackIds).toHaveLength(data.uncategorizedCount);
	});

	it('classifyStackIds respects the order returned by rawForClassify (date desc on the Prisma side)', async () => {
		expect.assertions(1);

		db.transactions.push({
			id: 'transaction-focus-unclassified',
			userId: 'user-a',
			date: new Date('2026-06-01T00:00:00.000Z'),
			label: 'Still to classify',
			amountCents: -1_500,
			type: 'expense',
			source: 'csv',
			manualCategory: null,
			natureManual: null,
			notes: null,
			dedupeKey: 'focus-dedupe-key',
			metadataJson: null,
			createdAt: new Date('2026-06-01T09:00:00.000Z'),
			updatedAt: new Date('2026-06-01T09:00:00.000Z'),
			category: { name: UNCLASSIFIED_CATEGORY },
			categoryId: db.CATEGORY_IDS[UNCLASSIFIED_CATEGORY],
			account: { name: 'Compte import CSV', source: 'csv' },
			importBatch: null
		});

		const data = await runLoad('/transactions');

		// The findMany mock returns rows in insertion order (real sorting is delegated to
		// SQLite): classifyStackIds must faithfully preserve this order, with no JS-side re-sort.
		const expectedOrder = db.transactions
			.filter((t) => t.manualCategory === null && t.category.name === UNCLASSIFIED_CATEGORY)
			.map((t) => t.id);
		expect(data.classifyStackIds).toEqual(expectedOrder);
	});
});

describe('createRule — application automatique en mode focus (focusRemainingIds)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		categoryRules.length = 0;
	});

	afterEach(() => {
		const touchedIds = new Set([
			'transaction-5',
			'transaction-6',
			'transaction-10',
			'transaction-15'
		]);
		for (const t of db.transactions) {
			if (touchedIds.has(t.id)) {
				t.manualCategory = null;
				t.natureManual = null;
			}
		}
	});

	it('automatically classifies, among the provided focusRemainingIds, transactions matching the rule that was just created', async () => {
		expect.assertions(3);

		const result = await runCreateRule(
			{ name: 'Regle test', matchText: 'Transaction 5', targetCategory: 'Alimentation' },
			['transaction-5', 'transaction-6']
		);

		expect(result.autoAppliedIds).toEqual(['transaction-5']);
		expect(db.transactions.find((t) => t.id === 'transaction-5')?.manualCategory).toBe(
			'Alimentation'
		);
		expect(db.transactions.find((t) => t.id === 'transaction-6')?.manualCategory).toBeNull();
	});

	it('NEVER touches a transaction outside focusRemainingIds, even if it also matches the rule (no retroactive application to history)', async () => {
		expect.assertions(1);

		// "Transaction" matches almost all uncategorized transactions in the history, but only
		// transaction-5 was passed in focusRemainingIds — the scope must stay strict.
		await runCreateRule(
			{ name: 'Regle large', matchText: 'Transaction', targetCategory: 'Alimentation' },
			['transaction-5']
		);

		expect(db.transactions.find((t) => t.id === 'transaction-6')?.manualCategory).toBeNull();
	});

	it('makes no extra transaction-side calls when focusRemainingIds is absent (existing modal flow unchanged)', async () => {
		expect.assertions(2);

		const result = await runCreateRule({
			name: 'Regle simple',
			matchText: 'AUCHAN',
			targetCategory: 'Alimentation'
		});

		expect(result.autoAppliedIds).toBeUndefined();
		expect(db.prisma.transaction.findMany).not.toHaveBeenCalled();
	});

	it('scans the ENTIRE remaining stack and applies the rule to non-consecutive matches (no stopping at the first non-match)', async () => {
		expect.assertions(4);

		// matchText "5" matche "Transaction 5" et "Transaction 15" (contient le chiffre 5), mais pas
		// "Transaction 10" placed between the two in focusRemainingIds — a scan that stopped at
		// the first non-matching item (transaction-10) would miss transaction-15; the expected
		// behavior is to scan the whole list and apply everywhere it matches.
		const result = await runCreateRule(
			{ name: 'Regle test', matchText: '5', targetCategory: 'Alimentation' },
			['transaction-5', 'transaction-10', 'transaction-15']
		);

		expect(result.autoAppliedIds).toEqual(['transaction-5', 'transaction-15']);
		expect(db.transactions.find((t) => t.id === 'transaction-5')?.manualCategory).toBe(
			'Alimentation'
		);
		expect(db.transactions.find((t) => t.id === 'transaction-10')?.manualCategory).toBeNull();
		expect(db.transactions.find((t) => t.id === 'transaction-15')?.manualCategory).toBe(
			'Alimentation'
		);
	});

	it('only matches against the rule that was just created, never other already-active rules', async () => {
		expect.assertions(2);

		// Pre-existing rule that would match transaction-6 ("Transaction 6"), but the rule that
		// was just created ("Transaction 5") does not match transaction-6: it should not be classified.
		categoryRules.push({
			id: 'existing-rule',
			name: 'Pre-existing rule',
			matchText: 'Transaction 6',
			targetCategory: 'Autre',
			targetNature: null,
			isRegex: false,
			enabled: true
		});

		const result = await runCreateRule(
			{ name: 'Regle test', matchText: 'Transaction 5', targetCategory: 'Alimentation' },
			['transaction-5', 'transaction-6']
		);

		expect(result.autoAppliedIds).toEqual(['transaction-5']);
		expect(db.transactions.find((t) => t.id === 'transaction-6')?.manualCategory).toBeNull();
	});

	it('writes the manual category key alongside the name', async () => {
		expect.assertions(1);

		// The key column is what every query matches on, so a write that sets the name alone
		// would leave the transaction invisible to the very category it was just pinned to.
		await runCreateRule(
			{ name: 'Regle test', matchText: 'Transaction 5', targetCategory: 'Alimentation' },
			['transaction-5']
		);

		expect(db.prisma.transaction.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					manualCategory: 'Alimentation',
					manualCategoryKey: computeNameKey('Alimentation')
				})
			})
		);
	});
});

describe('acceptSuggestion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		const transaction = db.transactions.find((t) => t.id === 'transaction-5');
		if (transaction) {
			transaction.manualCategory = null;
			transaction.natureManual = null;
		}
	});

	it('writes the manual category key alongside the name', async () => {
		expect.assertions(2);

		const result = await runAcceptSuggestion({
			transactionId: 'transaction-5',
			category: 'Alimentation'
		});

		expect(result).toEqual({ acceptSuccess: true });
		expect(db.prisma.transaction.updateMany).toHaveBeenCalledWith({
			where: { id: 'transaction-5', userId: testUser.id },
			data: {
				manualCategory: 'Alimentation',
				manualCategoryKey: computeNameKey('Alimentation'),
				natureManual: null
			}
		});
	});

	it('accepts a category spelled with a different case, since names fold', async () => {
		expect.assertions(1);

		// The validation looks the category up by key, exactly like every other write path:
		// "alimentation" is the same category as "Alimentation", not an invalid one.
		const result = await runAcceptSuggestion({
			transactionId: 'transaction-5',
			category: 'alimentation'
		});

		expect(result).toEqual({ acceptSuccess: true });
	});
});

async function runLoad(path: string) {
	return (await load({
		locals: { user: testUser },
		url: new URL(path, 'http://localhost')
	} as Parameters<typeof load>[0])) as TestTransactionPageData;
}

async function runSaveManualCategory(input: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return (await (
		actions.saveManualCategory as (event: {
			locals: { user: typeof testUser };
			request: Request;
		}) => Promise<unknown>
	)({
		locals: { user: testUser },
		request: new Request('http://localhost/transactions', {
			method: 'POST',
			body: formData
		})
	})) as { status?: number; manualCategorySuccess?: boolean };
}

async function runSaveManualNature(input: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return (await (
		actions.saveManualNature as (event: {
			locals: { user: typeof testUser };
			request: Request;
		}) => Promise<unknown>
	)({
		locals: { user: testUser },
		request: new Request('http://localhost/transactions', {
			method: 'POST',
			body: formData
		})
	})) as { status?: number; manualNatureSuccess?: boolean };
}

async function runAcceptSuggestion(input: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return (await (
		actions.acceptSuggestion as (event: {
			locals: { user: typeof testUser };
			request: Request;
		}) => Promise<unknown>
	)({
		locals: { user: testUser },
		request: new Request('http://localhost/transactions', {
			method: 'POST',
			body: formData
		})
	})) as { status?: number; acceptSuccess?: boolean };
}

async function runCreateRule(input: Record<string, string>, focusRemainingIds: string[] = []) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);
	for (const id of focusRemainingIds) formData.append('focusRemainingIds', id);

	return (await (
		actions.createRule as (event: {
			locals: { user: typeof testUser };
			request: Request;
		}) => Promise<unknown>
	)({
		locals: { user: testUser },
		request: new Request('http://localhost/transactions', {
			method: 'POST',
			body: formData
		})
	})) as { status?: number; createRuleSuccess?: boolean; autoAppliedIds?: string[] };
}

async function runDeleteTransaction(input: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return (await (
		actions.deleteTransaction as (event: {
			locals: { user: typeof testUser };
			request: Request;
		}) => Promise<unknown>
	)({
		locals: { user: testUser },
		request: new Request('http://localhost/transactions', {
			method: 'POST',
			body: formData
		})
	})) as { status?: number; deleteSuccess?: boolean };
}
