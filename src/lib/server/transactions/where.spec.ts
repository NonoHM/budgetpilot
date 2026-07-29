import { computeNameKey } from '$lib/server/naming/nameKey';
import { describe, expect, it } from 'vitest';
import {
	buildTransactionWhere,
	normalizeId,
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
