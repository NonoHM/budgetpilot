import { describe, expect, it } from 'vitest';
import {
	buildNgramIndex,
	cosine,
	nearestByNgrams,
	rankByNearest,
	SIMILAR_MARGIN,
	suggestFromSimilar
} from './nearestLabel';

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

/**
 * B4 (#1016): the production proposal over the reader above. Each test separates one clause, and
 * names the break that reddens it.
 */
describe('suggestFromSimilar', () => {
	const filed = [{ label: 'CB PRIMEUR LOMI 02/03', category: 'food' }];
	// A member's account, not four rows: 24 made-up merchants, half on a card, half by transfer,
	// so « cb » and « sepa » are prefixes by their share and « primeur » is not (SIMILAR_MAX_DF).
	const corpus = ['CB PRIMEUR LOMI 02/03', ...fillerLabels(24)];

	it('proposes the category of a filed label sharing a distinctive word', () => {
		const index = buildNgramIndex(filed, [...corpus, 'CB PRIMEUR ZUPEL 09/03']);
		expect(suggestFromSimilar(index, 'CB PRIMEUR ZUPEL 09/03')).toBe('food');
	});

	// Contradiction pass F1: one filed card row, every card row shares only « cb » with it.
	// Separates an IDF fitted on every label the member holds from one fitted on the filed rows:
	// fitted on the one filed row, « cb » weighs what « primeur » weighs.
	it('proposes nothing when the only word shared is a prefix, with the IDF fitted on all labels', () => {
		const index = buildNgramIndex(filed, [...corpus, 'CB BOUTIQUE QUAZU 09/03']);
		expect(suggestFromSimilar(index, 'CB BOUTIQUE QUAZU 09/03')).toBeNull();
	});

	// A prefix in about half the labels but not all: a gate on « not in every label » lets it
	// through, and a short name leaves the prefix most of the grams. Separates the `max_df`
	// ceiling from a gate on word IDF above 0, and from the margin.
	it('proposes nothing when the only word shared is in more than SIMILAR_MAX_DF of labels', () => {
		const sepa = [{ label: 'VIR SEPA LO', category: 'income' }];
		const index = buildNgramIndex(sepa, [...corpus, 'VIR SEPA LO', 'VIR SEPA KU']);
		expect(nearestByNgrams(index, 'VIR SEPA KU')?.margin).toBeGreaterThan(SIMILAR_MARGIN);
		expect(suggestFromSimilar(index, 'VIR SEPA KU')).toBeNull();
	});

	// Too few labels to tell a prefix from a trade word: two labels sharing a word are each 1 of 4.
	it('proposes nothing to a member holding too few labels to tell', () => {
		const index = buildNgramIndex(filed, ['CB PRIMEUR LOMI', 'CB BAZAR VALO', 'CB PRIMEUR ZUPEL']);
		expect(nearestByNgrams(index, 'CB PRIMEUR ZUPEL')?.margin).toBeGreaterThan(SIMILAR_MARGIN);
		expect(suggestFromSimilar(index, 'CB PRIMEUR ZUPEL')).toBeNull();
	});

	// Most grams of « primeurs » are grams of « primeur », so the margin alone would propose.
	// Separates the whole-word clause from the margin.
	it('proposes nothing when the labels share grams but no whole word', () => {
		const index = buildNgramIndex(filed, [...corpus, 'CB PRIMEURS ZUPEL 09/03']);
		expect(nearestByNgrams(index, 'CB PRIMEURS ZUPEL 09/03')?.margin).toBeGreaterThan(
			SIMILAR_MARGIN
		);
		expect(suggestFromSimilar(index, 'CB PRIMEURS ZUPEL 09/03')).toBeNull();
	});

	// Two categories equally near: the margin is 0, and a constant of 0 would propose a coin toss.
	it('proposes nothing between two categories equally near', () => {
		expect(SIMILAR_MARGIN).toBeGreaterThan(0);
		const index = buildNgramIndex(
			[
				{ label: 'CB PRIMEUR LOMI 02/03', category: 'food' },
				{ label: 'CB PRIMEUR LOMI 02/03', category: 'shopping' }
			],
			[...corpus, 'CB PRIMEUR LOMI 09/03']
		);
		expect(nearestByNgrams(index, 'CB PRIMEUR LOMI 09/03')?.margin).toBe(0);
		expect(suggestFromSimilar(index, 'CB PRIMEUR LOMI 09/03')).toBeNull();
	});
});

/** `n` made-up merchants, letters only, alternating a card prefix and a transfer prefix. */
function fillerLabels(n: number): string[] {
	const syllables = ['BA', 'DE', 'FI', 'GO', 'KU', 'LA', 'ME', 'NO', 'PI', 'RO', 'SU', 'TA'];
	return Array.from(
		{ length: n },
		(_, i) =>
			`${i % 2 ? 'CB' : 'VIR SEPA'} ${syllables[i % 12]}${syllables[Math.floor(i / 12)]}NDOR`
	);
}
