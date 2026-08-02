import { describe, expect, it } from 'vitest';
import { highlightMatchSegments, normalizeForMatch } from './normalize';

describe('normalizeForMatch', () => {
	it('strips accents, folds case and trims', () => {
		expect(normalizeForMatch('  Café Clients  ')).toBe('cafe clients');
	});
});

describe('highlightMatchSegments', () => {
	it('returns a single unmatched segment when the query is empty', () => {
		expect(highlightMatchSegments('Portugal', '')).toEqual([{ text: 'Portugal', matched: false }]);
	});

	it('returns a single unmatched segment when nothing matches', () => {
		expect(highlightMatchSegments('Portugal', 'xyz')).toEqual([
			{ text: 'Portugal', matched: false }
		]);
	});

	it('bolds a prefix match', () => {
		expect(highlightMatchSegments('Portugal', 'Port')).toEqual([
			{ text: 'Port', matched: true },
			{ text: 'ugal', matched: false }
		]);
	});

	it('bolds a match anywhere in the string, not only a prefix', () => {
		expect(highlightMatchSegments('Portugal', 'ugal')).toEqual([
			{ text: 'Port', matched: false },
			{ text: 'ugal', matched: true }
		]);
	});

	it('bolds a match in the middle, producing three segments', () => {
		expect(highlightMatchSegments('Remboursement Paul', 'sement')).toEqual([
			{ text: 'Rembour', matched: false },
			{ text: 'sement', matched: true },
			{ text: ' Paul', matched: false }
		]);
	});

	it('matches case- and accent-insensitively while preserving the original casing/accents in the output', () => {
		expect(highlightMatchSegments('Café clients', 'cafe')).toEqual([
			{ text: 'Café', matched: true },
			{ text: ' clients', matched: false }
		]);
	});
});
