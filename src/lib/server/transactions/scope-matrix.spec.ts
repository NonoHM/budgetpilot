import { describe, it, expect } from 'vitest';
import { DIMENSIONS, pairwiseRows, uncoveredPairs } from './scope-matrix';

describe('pairwise matrix generator', () => {
	it('covers every pair of value classes across every pair of dimensions', () => {
		const rows = pairwiseRows(DIMENSIONS);
		expect(uncoveredPairs(DIMENSIONS, rows)).toEqual([]);
	});

	it('is far smaller than the full cross product it stands in for', () => {
		const full = Object.values(DIMENSIONS).reduce((n, values) => n * values.length, 1);
		// 5 x 4 x 4 x 6 x 3 x 3 x 6 x 3. Recomputed, never adjusted to whatever the code returned:
		// this literal is the calibration that proves the generator is standing in for the space it
		// claims to, so deriving it from DIMENSIONS would make it a tautology.
		expect(full).toBe(77_760);
		// The combinatorial lower bound is 6 x 6 = 36 (the two largest dimensions). A greedy
		// generator lands near it; anything above 120 means the generator regressed into
		// near-exhaustive enumeration and the suite's runtime claim no longer holds.
		expect(pairwiseRows(DIMENSIONS).length).toBeGreaterThanOrEqual(36);
		expect(pairwiseRows(DIMENSIONS).length).toBeLessThan(120);
	});

	it('is deterministic, so a failing row can be reproduced from the row index alone', () => {
		expect(pairwiseRows(DIMENSIONS)).toEqual(pairwiseRows(DIMENSIONS));
	});
});
