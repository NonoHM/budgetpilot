import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionNature } from '$lib/domain/transaction';

// Volume/equivalence tests for the batched-scan refactor (see CLAUDE.md technical debt on
// rawForClassify/unbounded findMany): verifies that computing the same aggregates via bounded
// SQL (count/capped findMany) + batched JS scans (forEachTransactionBatch) produces IDENTICAL
// results to a naive "load everything into memory, then filter in JS" reference implementation,
// on a 15k-50k row synthetic dataset, while never issuing an unbounded Prisma query.

interface Row {
	id: string;
	userId: string;
	date: Date;
	label: string;
	manualCategory: string | null;
	natureManual: string | null;
	categoryId: string;
	category: { name: string };
}

const UNCLASSIFIED = 'uncategorized';

const db = vi.hoisted(() => {
	const rows: Row[] = [];
	const categories: Array<{ id: string; userId: string; name: string }> = [];
	let categoryNatureMappings: Array<{ userId: string; categoryName: string; nature: string }> = [];
	let categoryRules: Array<{
		id: string;
		name: string;
		matchText: string;
		targetCategory: string;
		targetNature: TransactionNature | null;
		enabled: boolean;
		isRegex: boolean;
		createdAt: Date;
	}> = [];

	function matchesTransactionWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
		if (!where) return true;
		for (const [key, value] of Object.entries(where)) {
			if (key === 'OR') {
				if (!(value as Array<Record<string, unknown>>).some((c) => matchesTransactionWhere(row, c)))
					return false;
				continue;
			}
			if (key === 'AND') {
				if (
					!(value as Array<Record<string, unknown>>).every((c) => matchesTransactionWhere(row, c))
				)
					return false;
				continue;
			}
			if (key === 'category') {
				const is = (value as { is: { userId?: string; name: string } }).is;
				if (row.category.name !== is.name) return false;
				if (is.userId && row.userId !== is.userId) return false;
				continue;
			}
			const actual = (row as unknown as Record<string, unknown>)[key];
			if (value && typeof value === 'object' && !Array.isArray(value) && 'in' in value) {
				// Generic `{ field: { in: [...] } }` support (manualCategory, categoryId, id...).
				if (!(value as { in: unknown[] }).in.includes(actual)) return false;
				continue;
			}
			if (actual !== value) return false;
		}
		return true;
	}

	// Real (date desc, id desc) sort, unlike the smaller page.server.spec.ts mock which trusts
	// fixture insertion order — this file specifically validates cross-batch ordering at volume.
	function sortDescByDateThenId(list: Row[]): Row[] {
		return [...list].sort((a, b) => {
			const byDate = b.date.getTime() - a.date.getTime();
			if (byDate !== 0) return byDate;
			return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
		});
	}

	const prisma = {
		transaction: {
			findMany: vi.fn(
				async ({
					where,
					cursor,
					skip,
					take
				}: {
					where?: Record<string, unknown>;
					select?: unknown;
					orderBy?: unknown;
					cursor?: { id: string };
					skip?: number;
					take?: number;
				} = {}) => {
					let result = sortDescByDateThenId(rows.filter((r) => matchesTransactionWhere(r, where)));
					if (cursor) {
						const idx = result.findIndex((r) => r.id === cursor.id);
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
					rows.filter((r) => matchesTransactionWhere(r, where)).length
			),
			updateMany: vi.fn(
				async ({
					where,
					data
				}: {
					where: Record<string, unknown>;
					data: { manualCategory?: string; natureManual?: string | null };
				}) => {
					let count = 0;
					for (const row of rows) {
						if (!matchesTransactionWhere(row, where)) continue;
						if ('manualCategory' in data) row.manualCategory = data.manualCategory ?? null;
						if ('natureManual' in data) row.natureManual = data.natureManual ?? null;
						count += 1;
					}
					return { count };
				}
			)
		},
		category: {
			findFirst: vi.fn(async ({ where }: { where: { userId: string; name: string } }) => {
				const found = categories.find((c) => c.userId === where.userId && c.name === where.name);
				return found ? { id: found.id } : null;
			}),
			findMany: vi.fn(async ({ where }: { where: { userId: string; name: { in: string[] } } }) =>
				categories
					.filter((c) => c.userId === where.userId && where.name.in.includes(c.name))
					.map((c) => ({ id: c.id }))
			)
		},
		categoryNatureMapping: {
			findMany: vi.fn(async ({ where }: { where: { userId: string; nature?: string } }) =>
				categoryNatureMappings
					.filter((m) => m.userId === where.userId && (!where.nature || m.nature === where.nature))
					.map((m) => ({ categoryName: m.categoryName }))
			)
		},
		categoryRule: {
			findMany: vi.fn(async ({ where }: { where: { userId: string; enabled: boolean } }) =>
				categoryRules.filter((r) => r.enabled === where.enabled)
			)
		}
	};

	return {
		rows,
		categories,
		get categoryNatureMappings() {
			return categoryNatureMappings;
		},
		set categoryNatureMappings(value) {
			categoryNatureMappings = value;
		},
		get categoryRules() {
			return categoryRules;
		},
		set categoryRules(value) {
			categoryRules = value;
		},
		prisma
	};
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { countUncategorizedTransactions } = await import('./nature');
const { forEachTransactionBatch } = await import('./batch');
const { collectTransactionsMatchingQuery } = await import('./search');
const { buildTransactionWhere, resolveUncategorizedCategoryId } = await import('./where');
const { previewCategoryRules, applyCategoryRules, findMatchingCategoryRule } =
	await import('../categorization/rules');

const USER = 'user-volume';
const CAT_ALIMENTATION = 'cat-alimentation';
const CAT_AUTRE = 'cat-autre';
const CAT_UNCATEGORIZED = 'cat-uncategorized';

function normalizeForMatch(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.trim();
}

/**
 * Builds a synthetic dataset of `count` transactions cycling through 6 archetypes, exercising
 * every branch of countUncategorizedTransactions/isUncategorizedByCategory/rule matching:
 *  0: natureManual = 'uncategorized' (manual override) -> counts as uncategorized nature.
 *  1: manualCategory null, linked to the "Non catégorisé" category (mapped -> uncategorized nature
 *     AND in the "to classify" pile).
 *  2: manualCategory = 'MysteryBucket' (also mapped to nature 'uncategorized', but NOT in the "to
 *     classify" pile since the effective category isn't "Non catégorisé").
 *  3: manualCategory null, linked to 'Alimentation' (label contains "auchan", matches rule A).
 *  4: natureManual = 'fee' (manual, wins over any mapping) + linked to "Non catégorisé" (must NOT
 *     count as uncategorized nature despite the category link, but DOES stay in the classify pile).
 *  5: manualCategory = 'Autre-perso' (already classified, label contains "uber", matches rule B).
 */
function buildDataset(count: number): Row[] {
	return Array.from({ length: count }, (_, i) => {
		const archetype = i % 6;
		const id = `tx-${String(count - i).padStart(7, '0')}`;
		const date = new Date(2024, 0, 1 + (i % 700));
		switch (archetype) {
			case 0:
				return {
					id,
					userId: USER,
					date,
					label: `Manual override ${i}`,
					manualCategory: null,
					natureManual: 'uncategorized',
					categoryId: CAT_AUTRE,
					category: { name: 'Autre' }
				};
			case 1:
				return {
					id,
					userId: USER,
					date,
					label: `AUCHAN Épicerie ${i}`,
					manualCategory: null,
					natureManual: null,
					categoryId: CAT_UNCATEGORIZED,
					category: { name: UNCLASSIFIED }
				};
			case 2:
				return {
					id,
					userId: USER,
					date,
					label: `Mystery item ${i}`,
					manualCategory: 'MysteryBucket',
					natureManual: null,
					categoryId: CAT_AUTRE,
					category: { name: 'Autre' }
				};
			case 3:
				return {
					id,
					userId: USER,
					date,
					label: `Auchan Courses ${i}`,
					manualCategory: null,
					natureManual: null,
					categoryId: CAT_ALIMENTATION,
					category: { name: 'Alimentation' }
				};
			case 4:
				return {
					id,
					userId: USER,
					date,
					label: `Frais bancaires ${i}`,
					manualCategory: null,
					natureManual: 'fee',
					categoryId: CAT_UNCATEGORIZED,
					category: { name: UNCLASSIFIED }
				};
			default:
				return {
					id,
					userId: USER,
					date,
					label: `Uber Eats ${i}`,
					manualCategory: 'Autre-perso',
					natureManual: null,
					categoryId: CAT_AUTRE,
					category: { name: 'Autre' }
				};
		}
	});
}

// Naive full-scan reference for "effective nature is uncategorized" (see CLAUDE.md convention:
// natureManual takes priority, then a CategoryNatureMapping on the effective category, and the
// default fallback NEVER produces 'uncategorized').
function naiveUncategorizedNatureCount(
	rows: Row[],
	mappings: Array<{ categoryName: string; nature: string }>
): number {
	const mapByName = new Map(mappings.map((m) => [m.categoryName, m.nature]));
	let count = 0;
	for (const row of rows) {
		if (row.natureManual) {
			if (row.natureManual === 'uncategorized') count += 1;
			continue;
		}
		const effectiveCategory = row.manualCategory ?? row.category.name;
		if (mapByName.get(effectiveCategory) === 'uncategorized') count += 1;
	}
	return count;
}

// Naive full-scan reference for the "to classify" pile (see CLAUDE.md: effective category ===
// "Non catégorisé", independent of nature).
function naiveClassifyPile(rows: Row[]): Row[] {
	return rows.filter((row) => (row.manualCategory ?? row.category.name) === UNCLASSIFIED);
}

describe('volume equivalence — countUncategorizedTransactions (SQL) vs naive full-scan', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.rows.length = 0;
		db.categories.length = 0;
		db.categories.push(
			{ id: CAT_ALIMENTATION, userId: USER, name: 'Alimentation' },
			{ id: CAT_AUTRE, userId: USER, name: 'Autre' },
			{ id: CAT_UNCATEGORIZED, userId: USER, name: UNCLASSIFIED }
		);
		db.categoryNatureMappings = [
			{ userId: USER, categoryName: UNCLASSIFIED, nature: 'uncategorized' },
			{ userId: USER, categoryName: 'MysteryBucket', nature: 'uncategorized' }
		];
	});

	it('matches the naive JS reference exactly on 20 000 rows, using only bounded SQL count/findMany calls (no unbounded scan)', async () => {
		expect.assertions(3);

		const dataset = buildDataset(20_000);
		db.rows.push(...dataset);

		const [sqlCount, naiveCount] = [
			await countUncategorizedTransactions(USER),
			naiveUncategorizedNatureCount(dataset, db.categoryNatureMappings)
		];

		expect(sqlCount).toBe(naiveCount);
		expect(sqlCount).toBeGreaterThan(0);
		// countUncategorizedTransactions never loads transaction rows into memory: only
		// categoryNatureMapping/category lookups + a single scalar `count`.
		expect(db.prisma.transaction.findMany).not.toHaveBeenCalled();
	});

	it('falls back to a plain natureManual count when no mapping targets "uncategorized" (still SQL-only)', async () => {
		expect.assertions(2);

		db.categoryNatureMappings = [];
		const dataset = buildDataset(15_000);
		db.rows.push(...dataset);

		const sqlCount = await countUncategorizedTransactions(USER);
		const naiveCount = dataset.filter((r) => r.natureManual === 'uncategorized').length;

		expect(sqlCount).toBe(naiveCount);
		expect(db.prisma.transaction.findMany).not.toHaveBeenCalled();
	});
});

describe('volume equivalence — "to classify" pile (buildTransactionWhere + resolveUncategorizedCategoryId) vs naive full-scan', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.rows.length = 0;
		db.categories.length = 0;
		db.categories.push(
			{ id: CAT_ALIMENTATION, userId: USER, name: 'Alimentation' },
			{ id: CAT_AUTRE, userId: USER, name: 'Autre' },
			{ id: CAT_UNCATEGORIZED, userId: USER, name: UNCLASSIFIED }
		);
	});

	it('count() + capped findMany() reproduce the exact same content as a naive full-history filter, on 20 000 rows', async () => {
		expect.assertions(4);

		const dataset = buildDataset(20_000);
		db.rows.push(...dataset);

		const uncategorizedCategoryId = await resolveUncategorizedCategoryId(USER);
		expect(uncategorizedCategoryId).toBe(CAT_UNCATEGORIZED);

		const where = buildTransactionWhere({
			userId: USER,
			type: 'classify',
			category: '',
			importBatchId: '',
			uncategorizedCategoryId
		});

		const [sqlCount, stackRows] = await Promise.all([
			db.prisma.transaction.count({ where }),
			db.prisma.transaction.findMany({
				where,
				select: { id: true },
				orderBy: [{ date: 'desc' }, { id: 'desc' }],
				take: 5_000
			})
		]);

		const naivePile = naiveClassifyPile(dataset);
		expect(sqlCount).toBe(naivePile.length);

		// FOCUS_STACK_CAP (5000) < naivePile.length for this dataset size, so we only compare the
		// capped prefix — but it must be EXACTLY the most-recent-first prefix, not an arbitrary subset.
		const naiveIdsDescByDate = [...naivePile]
			.sort((a, b) => b.date.getTime() - a.date.getTime() || (b.id < a.id ? -1 : 1))
			.map((r) => r.id)
			.slice(0, 5_000);

		expect(stackRows.map((r: { id: string }) => r.id)).toEqual(naiveIdsDescByDate);
		expect(stackRows.length).toBeLessThanOrEqual(5_000);
	});
});

describe('volume equivalence — classifiableCount via forEachTransactionBatch vs naive full-scan rule matching', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.rows.length = 0;
		db.categories.length = 0;
		db.categories.push(
			{ id: CAT_ALIMENTATION, userId: USER, name: 'Alimentation' },
			{ id: CAT_AUTRE, userId: USER, name: 'Autre' },
			{ id: CAT_UNCATEGORIZED, userId: USER, name: UNCLASSIFIED }
		);
	});

	it('scans the "to classify" pile in bounded batches and finds exactly the same matches as a naive one-shot scan, on 20 000 rows', async () => {
		expect.assertions(3);

		const dataset = buildDataset(20_000);
		db.rows.push(...dataset);

		const rules = [
			{
				id: 'rule-auchan',
				name: 'Auchan',
				matchText: 'auchan',
				targetCategory: 'Alimentation',
				targetNature: null,
				enabled: true,
				isRegex: false
			}
		];

		const uncategorizedCategoryId = await resolveUncategorizedCategoryId(USER);
		const where = buildTransactionWhere({
			userId: USER,
			type: 'classify',
			category: '',
			importBatchId: '',
			uncategorizedCategoryId
		});

		let classifiableCount = 0;
		await forEachTransactionBatch(
			where,
			{ id: true, label: true, manualCategory: true },
			(rows) => {
				for (const row of rows) {
					if (
						findMatchingCategoryRule(
							{ label: row.label, manualCategory: row.manualCategory },
							rules
						) !== null
					) {
						classifiableCount += 1;
					}
				}
			},
			1_000
		);

		const naivePile = naiveClassifyPile(dataset);
		const naiveClassifiable = naivePile.filter(
			(row) =>
				findMatchingCategoryRule(
					{ label: row.label, manualCategory: row.manualCategory },
					rules
				) !== null
		).length;

		expect(classifiableCount).toBe(naiveClassifiable);
		expect(classifiableCount).toBeGreaterThan(0);
		// No call ever fetches more than the requested batch size — memory is bounded.
		const calls = db.prisma.transaction.findMany.mock.calls as Array<[{ take?: number }]>;
		expect(calls.every(([args]) => args.take === 1_000)).toBe(true);
	});
});

describe('volume equivalence — previewCategoryRules / applyCategoryRules vs naive full-scan matching', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.rows.length = 0;
		db.categoryRules = [
			{
				id: 'rule-auchan',
				name: 'Auchan',
				matchText: 'auchan',
				targetCategory: 'Alimentation',
				targetNature: 'spending',
				enabled: true,
				isRegex: false,
				createdAt: new Date('2026-01-01T00:00:00.000Z')
			},
			{
				id: 'rule-uber',
				name: 'Uber',
				matchText: 'uber',
				targetCategory: 'Transport',
				targetNature: null,
				enabled: true,
				isRegex: false,
				createdAt: new Date('2026-01-02T00:00:00.000Z')
			}
		];
	});

	it('previewCategoryRules.count matches a naive scan over every manualCategory-null row, on 20 000 rows', async () => {
		expect.assertions(2);

		const dataset = buildDataset(20_000);
		db.rows.push(...dataset);

		const preview = await previewCategoryRules(USER);

		const naiveCount = dataset.filter(
			(row) =>
				row.manualCategory === null &&
				findMatchingCategoryRule(
					{ label: row.label, manualCategory: row.manualCategory },
					db.categoryRules
				) !== null
		).length;

		expect(preview.count).toBe(naiveCount);
		expect(preview.count).toBeGreaterThan(0);
	});

	it('applyCategoryRules updates exactly the naive-expected number of rows, respecting the natureManual guard (rules never overwrite a manual correction), on 20 000 rows', async () => {
		expect.assertions(3);

		const dataset = buildDataset(20_000);
		// A subset of otherwise-matching rows already has a manual nature set: applyCategoryRules
		// must NOT overwrite them when the matched rule carries a targetNature (see rules.ts —
		// updateMany's `natureManual: null` guard).
		for (let i = 0; i < dataset.length; i += 37) {
			if (dataset[i].manualCategory === null) dataset[i].natureManual = 'transfer';
		}
		// Computed BEFORE calling applyCategoryRules: the mock's `updateMany` mutates the same row
		// objects in place (db.rows holds the very same references as `dataset`), so evaluating
		// this naive reference after the call would see the already-updated manualCategory/
		// natureManual and silently zero itself out.
		const naiveExpected = dataset.filter((row) => {
			if (row.manualCategory !== null) return false;
			const rule = findMatchingCategoryRule(
				{ label: row.label, manualCategory: row.manualCategory },
				db.categoryRules
			);
			if (!rule) return false;
			// Guard only applies when the matched rule sets a targetNature.
			if (rule.targetNature) return row.natureManual === null;
			return true;
		}).length;

		db.rows.push(...dataset);

		const updated = await applyCategoryRules(USER);

		expect(updated).toBe(naiveExpected);
		expect(updated).toBeGreaterThan(0);

		// Spot-check: rows excluded by the guard must keep their pre-existing manual nature.
		const guarded = dataset.find(
			(row) =>
				row.natureManual === 'transfer' &&
				findMatchingCategoryRule({ label: row.label, manualCategory: null }, db.categoryRules)
					?.targetNature === 'spending'
		);
		expect(guarded?.natureManual).toBe('transfer');
	});
});

describe('volume equivalence — collectTransactionsMatchingQuery vs naive full-scan label search', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.rows.length = 0;
	});

	it('returns exactly the same set (no loss/duplication across batch boundaries) as a naive accent-insensitive filter, on 20 000 rows', async () => {
		expect.assertions(2);

		const dataset = buildDataset(20_000).map((row, i) =>
			i % 5 === 0 ? { ...row, label: `Café François ${i}` } : row
		);
		db.rows.push(...dataset);

		const matches = await collectTransactionsMatchingQuery(
			{ userId: USER },
			{ id: true, label: true },
			'francois',
			'contains'
		);

		const naiveMatches = dataset.filter((row) =>
			normalizeForMatch(row.label).includes(normalizeForMatch('francois'))
		);

		expect(matches.map((m: { id: string }) => m.id).sort()).toEqual(
			naiveMatches.map((r) => r.id).sort()
		);
		expect(matches.length).toBeGreaterThan(0);
	});
});

describe('boundedness at 50 000 rows — no single Prisma call ever returns an unbounded result set', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.rows.length = 0;
	});

	it('forEachTransactionBatch scans 50 000 rows using only bounded findMany calls (each <= batchSize)', async () => {
		expect.assertions(3);

		const dataset = buildDataset(50_000);
		db.rows.push(...dataset);

		let scanned = 0;
		await forEachTransactionBatch(
			{ userId: USER },
			{ id: true },
			(rows) => {
				scanned += rows.length;
			},
			2_000
		);

		expect(scanned).toBe(50_000);
		const calls = db.prisma.transaction.findMany.mock.calls as Array<[{ take?: number }]>;
		// 50 000 is an exact multiple of the 2 000 batch size: the scan issues 25 full batches, then
		// one extra bounded call that comes back empty (rows.length === 0) to detect the end — see
		// forEachTransactionBatch's `rows.length < batchSize` early-return condition. Still strictly
		// bounded (never a single unbounded findMany), just one more round-trip than the naive
		// ceil(total / batchSize) count.
		expect(calls.length).toBe(26);
		expect(calls.every(([args]) => (args.take ?? 0) <= 2_000)).toBe(true);
	});
});
