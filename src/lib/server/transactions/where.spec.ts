import { computeNameKey } from '$lib/server/naming/nameKey';
import { describe, expect, it } from 'vitest';
import { MAX_ANCHOR_IDS } from '$lib/server/backup/schema';
import { detectRecurringFlows } from '$lib/domain/forecast';
import {
	buildTransactionWhere,
	MAX_TRANSACTION_ID_FILTER,
	normalizeId,
	normalizeIdList,
	normalizeSearch,
	parseTransactionDateRange,
	parseTransactionFilter
} from './where';

describe('buildTransactionWhere', () => {
	it('scope toujours par userId, même sans filtre', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'all',
			category: '',
			importBatchId: ''
		});

		expect(where).toEqual({ userId: 'user-a' });
	});

	it('filtre par type income/expense', () => {
		expect.assertions(2);

		const income = buildTransactionWhere({
			userId: 'user-a',
			type: 'income',
			category: '',
			importBatchId: ''
		});
		const expense = buildTransactionWhere({
			userId: 'user-a',
			type: 'expense',
			category: '',
			importBatchId: ''
		});

		expect(income).toMatchObject({ type: 'income' });
		expect(expense).toMatchObject({ type: 'expense' });
	});

	it('ignore le type quand le filtre vaut "all" ou "classify"', () => {
		expect.assertions(2);

		const all = buildTransactionWhere({
			userId: 'user-a',
			type: 'all',
			category: '',
			importBatchId: ''
		});
		const classify = buildTransactionWhere({
			userId: 'user-a',
			type: 'classify',
			category: '',
			importBatchId: ''
		});

		expect(all).not.toHaveProperty('type');
		expect(classify).not.toHaveProperty('type');
	});

	it('type "classify" filtre par catégorie effective non catégorisée (manuelle OU liée)', () => {
		expect.assertions(2);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'classify',
			category: '',
			importBatchId: '',
			uncategorizedCategoryId: 'cat-uncat-id'
		});

		expect(where).not.toHaveProperty('type');
		expect(where.OR).toEqual([
			{ manualCategoryKey: computeNameKey('uncategorized') },
			{ AND: [{ manualCategory: null }, { categoryId: 'cat-uncat-id' }] }
		]);
	});

	it('type "classify" sans uncategorizedCategoryId résolu ne matche aucune catégorie liée', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'classify',
			category: '',
			importBatchId: ''
		});

		expect(where.OR).toEqual([
			{ manualCategoryKey: computeNameKey('uncategorized') },
			{ AND: [{ manualCategory: null }, { categoryId: '__none__' }] }
		]);
	});

	it('combine le filtre "classify" et le filtre catégorie sans se chevaucher (AND explicite)', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'classify',
			category: 'Alimentation',
			importBatchId: '',
			uncategorizedCategoryId: 'cat-uncat-id'
		});

		expect(where.AND).toEqual([
			{
				OR: [
					{ manualCategoryKey: computeNameKey('uncategorized') },
					{ AND: [{ manualCategory: null }, { categoryId: 'cat-uncat-id' }] }
				]
			},
			{
				OR: [
					{ manualCategoryKey: computeNameKey('Alimentation') },
					{
						AND: [
							{ manualCategory: null },
							{ category: { is: { userId: 'user-a', nameKey: computeNameKey('Alimentation') } } }
						]
					}
				]
			}
		]);
	});

	it('filtre par catégorie effective (manuelle OU catégorie liée du même user)', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'all',
			category: 'Alimentation',
			importBatchId: ''
		});

		expect(where.OR).toEqual([
			{ manualCategoryKey: computeNameKey('Alimentation') },
			{
				AND: [
					{ manualCategory: null },
					{ category: { is: { userId: 'user-a', nameKey: computeNameKey('Alimentation') } } }
				]
			}
		]);
	});

	it('le filtre catégorie ne fuit jamais vers un autre userId', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'victim-user',
			type: 'all',
			category: 'Alimentation',
			importBatchId: ''
		});

		expect(where.OR?.[1]).toMatchObject({
			AND: [{ manualCategory: null }, { category: { is: { userId: 'victim-user' } } }]
		});
	});

	it('filtre par importBatchId', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'all',
			category: '',
			importBatchId: 'batch-123'
		});

		expect(where.importBatchId).toBe('batch-123');
	});

	it('filtre par plage de dates [from, to)', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'all',
			category: '',
			from: new Date('2026-06-01T00:00:00.000Z'),
			to: new Date('2026-06-15T00:00:00.000Z'),
			importBatchId: ''
		});

		expect(where.date).toEqual({
			gte: new Date('2026-06-01T00:00:00.000Z'),
			lt: new Date('2026-06-15T00:00:00.000Z')
		});
	});

	it('ignore le filtre de date si seule une des deux bornes est fournie', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'all',
			category: '',
			from: new Date('2026-06-01T00:00:00.000Z'),
			importBatchId: ''
		});

		expect(where).not.toHaveProperty('date');
	});

	it('combine tous les filtres simultanément', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'expense',
			category: 'Alimentation',
			from: new Date('2026-06-01T00:00:00.000Z'),
			to: new Date('2026-07-01T00:00:00.000Z'),
			importBatchId: 'batch-1'
		});

		expect(where).toMatchObject({
			userId: 'user-a',
			type: 'expense',
			importBatchId: 'batch-1'
		});
	});

	it('filtre par liste d’ids SANS jamais perdre le scope userId', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'all',
			category: '',
			importBatchId: '',
			ids: ['transaction-1', 'transaction-2']
		});

		// toEqual, not toMatchObject: the point of this assertion is that `userId` is STILL there
		// next to the id whitelist. A partial match would pass with the conjunct removed.
		expect(where).toEqual({
			userId: 'user-a',
			id: { in: ['transaction-1', 'transaction-2'] }
		});
	});

	it('traite une liste d’ids vide comme « ne matche rien », jamais comme « pas de filtre »', () => {
		expect.assertions(1);

		const where = buildTransactionWhere({
			userId: 'user-a',
			type: 'all',
			category: '',
			importBatchId: '',
			ids: []
		});

		expect(where).toEqual({ userId: 'user-a', id: { in: [] } });
	});

	it('n’ajoute aucun filtre d’id quand ids est absent ou null', () => {
		expect.assertions(2);

		const base = { userId: 'user-a', type: 'all' as const, category: '', importBatchId: '' };

		expect(buildTransactionWhere(base)).not.toHaveProperty('id');
		expect(buildTransactionWhere({ ...base, ids: null })).not.toHaveProperty('id');
	});
});

describe('normalizeIdList', () => {
	it('distingue « absent » (pas de filtre) de « présent mais vide » (ne matche rien)', () => {
		expect.assertions(3);

		expect(normalizeIdList(null)).toBeNull();
		expect(normalizeIdList('')).toEqual([]);
		expect(normalizeIdList(' , , ')).toEqual([]);
	});

	it('parse une liste séparée par des virgules et déduplique', () => {
		expect.assertions(1);

		expect(normalizeIdList('transaction-1, transaction-2 ,transaction-1')).toEqual([
			'transaction-1',
			'transaction-2'
		]);
	});

	it('écarte les éléments malformés sans lever, et sans laisser passer les valides', () => {
		expect.assertions(1);

		expect(normalizeIdList("short,transaction-1,'; DROP TABLE,bad id here")).toEqual([
			'transaction-1'
		]);
	});

	it('borne la liste à MAX_TRANSACTION_ID_FILTER avant tout accès à la base', () => {
		expect.assertions(2);

		const overLong = Array.from(
			{ length: MAX_TRANSACTION_ID_FILTER + 500 },
			(_, index) => `transaction-${index}`
		).join(',');
		const parsed = normalizeIdList(overLong);

		expect(parsed).toHaveLength(MAX_TRANSACTION_ID_FILTER);
		// The cap is applied to the SEGMENTS, so it is the first N that survive — the truncation
		// happens before validation, not after, which is what keeps a pathological URL from
		// materializing thousands of strings.
		expect(parsed?.[MAX_TRANSACTION_ID_FILTER - 1]).toBe(
			`transaction-${MAX_TRANSACTION_ID_FILTER - 1}`
		);
	});

	it('accepte sans troncature le plus grand lot d’ancres que /upcoming-bills puisse émettre', () => {
		expect.assertions(1);

		// Cross-check against the producer's own cap (backup/schema.ts). Asserted here rather than
		// imported into where.ts so a change to MAX_ANCHOR_IDS goes red instead of silently
		// truncating "Voir les transactions liées".
		expect(MAX_TRANSACTION_ID_FILTER).toBeGreaterThanOrEqual(MAX_ANCHOR_IDS);
	});

	// The assertion above is the EASY half — it compares two constants. The hard half is the
	// arithmetic that justifies the constant, which until now lived only in a comment: the ceiling
	// is not "~52 for a weekly stream", because classifyCadence tests the MEDIAN interval, so a
	// group counts as weekly at a 5-day median (about 2 × 365 / 5 = 146 over a 12-month span).
	// This runs the real detector on a real 5-day-median stream and reads the number off, so a
	// change to the cadence windows that pushes it past 250 goes red here instead of silently
	// truncating a user's link. detectRecurringFlows applies no lookback filter of its own — the
	// 12-month window is the caller's FORECAST_LOOKBACK_MONTHS, and this fixture's 725-day span is
	// not constructed to pin that boundary — so this test says nothing about the lookback.
	it('encaisse le plus gros flux réellement détectable (médiane 5 jours) sans troncature', () => {
		expect.assertions(4);

		const start = Date.UTC(2025, 7, 1);
		const transactions = Array.from({ length: 146 }, (_, index) => ({
			id: `transaction-${String(index).padStart(4, '0')}`,
			date: new Date(start + index * 5 * 86_400_000).toISOString().slice(0, 10),
			label: 'BOULANGERIE DU COIN',
			category: 'Alimentation',
			amountCents: -1_200,
			type: 'expense' as const
		}));

		const flows = detectRecurringFlows(transactions);
		const weekly = flows.find((flow) => flow.cadence === 'weekly');

		// The premise: a 5-day median really is classified weekly, and really is one flow.
		expect(weekly).toBeDefined();
		expect(weekly?.occurrenceCount).toBe(146);
		// ~146, not ~52 — this is the number a future session raising MAX_ANCHOR_IDS reasons from.
		expect(weekly!.occurrenceCount).toBeGreaterThan(52);
		// And the whole thing still fits the filter's bound, untruncated.
		expect(normalizeIdList(transactions.map((t) => t.id).join(','))).toHaveLength(146);
	});
});

describe('normalizeSearch', () => {
	it('retourne une chaîne vide pour null', () => {
		expect.assertions(1);

		expect(normalizeSearch(null)).toBe('');
	});

	it('trim la valeur', () => {
		expect.assertions(1);

		expect(normalizeSearch('  auchan  ')).toBe('auchan');
	});

	it('tronque à 120 caractères', () => {
		expect.assertions(1);

		const long = 'a'.repeat(200);

		expect(normalizeSearch(long)).toHaveLength(120);
	});
});

describe('normalizeId', () => {
	it('accepte un identifiant alphanumérique de 8 caractères ou plus', () => {
		expect.assertions(2);

		expect(normalizeId('batch1234')).toBe('batch1234');
		expect(normalizeId('AbC-123_XYZ')).toBe('AbC-123_XYZ');
	});

	it('rejette un identifiant trop court', () => {
		expect.assertions(1);

		expect(normalizeId('short')).toBe('');
	});

	it('rejette les caractères non autorisés (protection contre injection via query param)', () => {
		expect.assertions(3);

		expect(normalizeId("'; DROP TABLE")).toBe('');
		expect(normalizeId('batch 1234 5678')).toBe('');
		expect(normalizeId(null)).toBe('');
	});
});

describe('parseTransactionFilter', () => {
	it('accepte les valeurs connues', () => {
		expect.assertions(3);

		expect(parseTransactionFilter('income')).toBe('income');
		expect(parseTransactionFilter('expense')).toBe('expense');
		expect(parseTransactionFilter('classify')).toBe('classify');
	});

	it('retombe sur "all" pour toute valeur inconnue ou absente', () => {
		expect.assertions(3);

		expect(parseTransactionFilter('bogus')).toBe('all');
		expect(parseTransactionFilter(null)).toBe('all');
		expect(parseTransactionFilter('')).toBe('all');
	});
});

describe('parseTransactionDateRange', () => {
	it('retourne aucun range ni erreur quand from/to sont absents', () => {
		expect.assertions(1);

		expect(parseTransactionDateRange(null, null)).toEqual({ range: null, error: false });
	});

	it('parse une plage valide', () => {
		expect.assertions(1);

		const result = parseTransactionDateRange('2026-06-01', '2026-06-15');

		expect(result).toEqual({
			range: {
				from: new Date('2026-06-01T00:00:00.000Z'),
				to: new Date('2026-06-16T00:00:00.000Z'),
				fromDate: '2026-06-01',
				toDate: '2026-06-15'
			},
			error: false
		});
	});

	it('bloque (sans lever) quand une seule des deux bornes est fournie', () => {
		expect.assertions(2);

		expect(parseTransactionDateRange('2026-06-01', null)).toEqual({ range: null, error: true });
		expect(parseTransactionDateRange(null, '2026-06-15')).toEqual({ range: null, error: true });
	});

	it('bloque (sans lever) quand from > to', () => {
		expect.assertions(1);

		expect(parseTransactionDateRange('2026-06-15', '2026-06-01')).toEqual({
			range: null,
			error: true
		});
	});
});
