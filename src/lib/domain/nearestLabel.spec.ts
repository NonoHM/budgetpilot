import { describe, expect, it } from 'vitest';
import { buildNgramIndex, cosine, nearestByNgrams, rankByNearest } from './nearestLabel';

describe('rankByNearest', () => {
	it('ranks each category by its single most similar label, with the lead over the next', () => {
		const ranked = rankByNearest([
			{ category: 'food', similarity: 0.5 },
			{ category: 'food', similarity: 0.9 },
			{ category: 'dining', similarity: 0.7 },
			{ category: 'transport', similarity: 0.2 }
		]);
		// The maximum, not the sum: three weak dining neighbours must not outvote one close match.
		expect(ranked).toMatchObject({ category: 'food', similarity: 0.9 });
		expect(ranked?.margin).toBeCloseTo(0.2, 12);
	});

	it('reads a lone category as leading a runner-up at zero', () => {
		expect(rankByNearest([{ category: 'food', similarity: 0.4 }])).toStrictEqual({
			category: 'food',
			similarity: 0.4,
			margin: 0.4
		});
	});

	it('has nothing to rank when nothing is similar at all', () => {
		expect(rankByNearest([])).toBeNull();
		expect(rankByNearest([{ category: 'food', similarity: 0 }])).toBeNull();
	});
});

describe('cosine', () => {
	it('is 1 for one direction, 0 for orthogonal ones, and 0 against a zero vector', () => {
		expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 12);
		expect(cosine([1, 0], [0, 3])).toBe(0);
		expect(cosine([0, 0], [1, 1])).toBe(0);
	});

	it('refuses vectors of two widths', () => {
		expect(() => cosine([1], [1, 2])).toThrow('width');
	});
});

describe('the character n-gram reader', () => {
	const index = buildNgramIndex([
		{ label: 'CB PRIMEUR SELDULREN 02/07', category: 'food' },
		{ label: 'CB BAZAR VADULPEL 01/07', category: 'shopping' },
		{ label: 'PRLV SEPA ABONNEMENT TUTUZU', category: 'subscriptions' }
	]);

	// A never-seen merchant in a known trade versus a known merchant: the trade noun carries it.
	it('reads an unseen merchant by the trade word it shares with a filed label', () => {
		expect(nearestByNgrams(index, 'CB PRIMEUR QUAVELTOR 14/09')?.category).toBe('food');
		expect(nearestByNgrams(index, 'CB BAZAR QUAVELTOR 14/09')?.category).toBe('shopping');
	});

	it('ignores the card date, so two dates of one label read the same', () => {
		expect(nearestByNgrams(index, 'CB BAZAR VADULPEL 03/11')).toStrictEqual(
			nearestByNgrams(index, 'CB BAZAR VADULPEL 01/07')
		);
	});

	it('proposes nothing for a label that shares no n-gram with any filed one', () => {
		expect(nearestByNgrams(index, 'XQZ')).toBeNull();
	});

	it('has nothing to read from an empty history', () => {
		expect(nearestByNgrams(buildNgramIndex([]), 'CB BAZAR')).toBeNull();
	});
});
