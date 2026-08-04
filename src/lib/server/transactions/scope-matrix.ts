/**
 * The filter combination space for /transactions, enumerated rather than hoped for.
 *
 * Seven dimensions in value CLASSES (not raw values) give a full cross product of 19 440, which is
 * not exhaustible: each row costs three call sites, `load` walks every page, and the agreement
 * suite runs on three engines, two of them over a socket.
 *
 * So the matrix is pairwise-exhaustive, and the point of pairwise here is that it is COUNTABLE:
 * `uncoveredPairs` is what proves the claim, rather than a sentence in a docstring. What pairwise
 * does NOT cover — arbitrary 3-way-and-above combinations — is covered separately by NAMED_ROWS
 * for the dimension groups that genuinely interact, and is excluded elsewhere on a structural
 * argument: every other dimension writes its own independent top-level key in
 * `buildTransactionWhere`, so a 3-way interaction between them has no mechanism.
 *
 * THAT EXCLUSION EXPIRES if a future filter stops being an independent conjunct. If you add a
 * filter that lands inside `conditions[]` (as `type: 'classify'` and `category` do), it joins the
 * interacting group and needs its own NAMED_ROWS entries.
 */
export const DIMENSIONS = {
	q: ['absent', 'contains-some', 'contains-none', 'regex-valid', 'regex-invalid'],
	type: ['all', 'income', 'expense', 'classify'],
	category: ['absent', 'real', 'nonexistent'],
	range: ['absent', 'valid-narrow', 'valid-covering-all', 'lone-from', 'malformed', 'reversed'],
	importBatch: ['absent', 'real', 'nonexistent'],
	tag: ['absent', 'real', 'nonexistent'],
	ids: ['absent', 'subset', 'empty', 'all-malformed', 'over-cap', 'covering-all']
} as const satisfies Record<string, readonly string[]>;

export type Dimensions = typeof DIMENSIONS;
export type FilterRow = { [K in keyof Dimensions]: Dimensions[K][number] };

function pairKey(keys: string[], a: string, av: string, b: string, bv: string): string {
	// Ordered by dimension index so the same pair always produces the same key regardless of which
	// side the caller happens to hold.
	return keys.indexOf(a) < keys.indexOf(b) ? `${a}=${av}|${b}=${bv}` : `${b}=${bv}|${a}=${av}`;
}

interface Pair {
	k1: string;
	v1: string;
	k2: string;
	v2: string;
}

/**
 * Every pair, as a Map keyed by `pairKey` so a pair can be both tested for membership and read back
 * as its four components. Reading it back is what lets a row be SEEDED from an uncovered pair
 * instead of parsing one out of its own key string.
 */
function allPairs(dims: Record<string, readonly string[]>): Map<string, Pair> {
	const keys = Object.keys(dims);
	const pairs = new Map<string, Pair>();
	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			for (const v1 of dims[keys[i]]) {
				for (const v2 of dims[keys[j]]) {
					pairs.set(pairKey(keys, keys[i], v1, keys[j], v2), {
						k1: keys[i],
						v1,
						k2: keys[j],
						v2
					});
				}
			}
		}
	}
	return pairs;
}

/**
 * Greedy pairwise generation, each row SEEDED from a still-uncovered pair.
 *
 * The seed is not an optimisation, it is a correctness fix, and the first version of this function
 * shipped without it. Greedy scoring alone cannot choose a value for the FIRST dimension it
 * processes: nothing is assigned yet, so every candidate scores 0, the strict `>` keeps the first
 * one, and `q` was pinned to 'absent' on every row forever — 209 of the 660 pairs were unreachable
 * and the generator died on its own progress guard after 17 rows. Seeding from an uncovered pair
 * gives the row two fixed dimensions to score the rest against, and guarantees each row covers at
 * least the pair it was seeded with.
 *
 * Deliberately deterministic (no Math.random): a failing row must be reproducible from its index
 * alone. `Map` iteration order is insertion order, and `allPairs` inserts in a fixed order, so the
 * seed choice is stable across runs.
 */
export function pairwiseRows(dims: Record<string, readonly string[]>): FilterRow[] {
	const keys = Object.keys(dims);
	const uncovered = allPairs(dims);
	const rows: FilterRow[] = [];

	while (uncovered.size > 0) {
		const seed = uncovered.values().next().value as Pair;
		const row: Record<string, string> = { [seed.k1]: seed.v1, [seed.k2]: seed.v2 };

		for (const key of keys) {
			if (key in row) continue;
			let best = dims[key][0];
			let bestScore = -1;
			for (const value of dims[key]) {
				let score = 0;
				for (const other of keys) {
					if (other === key || !(other in row)) continue;
					if (uncovered.has(pairKey(keys, key, value, other, row[other]))) score++;
				}
				if (score > bestScore) {
					bestScore = score;
					best = value;
				}
			}
			row[key] = best;
		}

		let progressed = false;
		for (let i = 0; i < keys.length; i++) {
			for (let j = i + 1; j < keys.length; j++) {
				if (uncovered.delete(pairKey(keys, keys[i], row[keys[i]], keys[j], row[keys[j]])))
					progressed = true;
			}
		}
		// Unreachable while the seed holds — the seeded pair is uncovered by construction — but kept
		// as the backstop that caught the unseeded version. Without it the loop is silently infinite
		// on a generator bug, and a hung CI job reads as an infrastructure problem rather than a
		// defect here.
		if (!progressed) throw new Error('pairwise generator made no progress; uncovered pairs remain');
		rows.push(row as FilterRow);
	}

	return rows;
}

export function uncoveredPairs(
	dims: Record<string, readonly string[]>,
	rows: FilterRow[]
): string[] {
	const keys = Object.keys(dims);
	const uncovered = allPairs(dims);
	for (const row of rows) {
		for (let i = 0; i < keys.length; i++) {
			for (let j = i + 1; j < keys.length; j++) {
				uncovered.delete(
					pairKey(
						keys,
						keys[i],
						row[keys[i] as keyof FilterRow],
						keys[j],
						row[keys[j] as keyof FilterRow]
					)
				);
			}
		}
	}
	// `.keys()`, not the Map itself: spreading a Map yields [key, value] entries, and an array of
	// those is both unreadable in a failure message and never equal to the `[]` the spec asserts.
	return [...uncovered.keys()].sort();
}

/**
 * Higher-order combinations the pairwise set does not guarantee, named because the code has a
 * REASON for these dimensions to interfere — not because they feel risky.
 *
 *  - type=classify x category: the only structural interaction in buildTransactionWhere. Both push
 *    into `conditions[]`, and where.ts:110-114 collapses one into `where.OR` and two into
 *    `where.AND`. The comment there records that they must not overwrite one another.
 *  - q x tag: three implementations of one intersection (load scans the tag-free scope and
 *    re-filters in JS; bulkTag narrows to `id: { in }`; export runs the full where).
 *  - q x ids: the JS match is collected THROUGH the where, then re-narrowed by id.
 *  - every fail-closed class against a RICH background, so "fails closed" is proven to dominate
 *    active filters rather than merely to hold in isolation.
 *  - ids=empty against everything: see the docstring in scope.db-smoke.ts. Highest consequence.
 */
export const NAMED_ROWS: FilterRow[] = [
	{
		q: 'contains-some',
		type: 'classify',
		category: 'real',
		range: 'absent',
		importBatch: 'absent',
		tag: 'real',
		ids: 'absent'
	},
	{
		q: 'contains-some',
		type: 'classify',
		category: 'real',
		range: 'valid-narrow',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset'
	},
	{
		q: 'regex-valid',
		type: 'all',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'real',
		ids: 'subset'
	},
	{
		q: 'contains-some',
		type: 'all',
		category: 'absent',
		range: 'valid-narrow',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'absent'
	},
	{
		q: 'absent',
		type: 'all',
		category: 'absent',
		range: 'valid-covering-all',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'covering-all'
	},
	{
		q: 'regex-invalid',
		type: 'classify',
		category: 'real',
		range: 'valid-narrow',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset'
	},
	{
		q: 'contains-some',
		type: 'income',
		category: 'real',
		range: 'malformed',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset'
	},
	{
		q: 'contains-some',
		type: 'income',
		category: 'real',
		range: 'lone-from',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset'
	},
	{
		q: 'contains-some',
		type: 'income',
		category: 'real',
		range: 'reversed',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset'
	},
	{
		q: 'contains-some',
		type: 'all',
		category: 'real',
		range: 'valid-narrow',
		importBatch: 'real',
		tag: 'real',
		ids: 'empty'
	},
	{
		q: 'absent',
		type: 'all',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'empty'
	},
	{
		q: 'absent',
		type: 'classify',
		category: 'real',
		range: 'absent',
		importBatch: 'absent',
		tag: 'real',
		ids: 'empty'
	},
	{
		q: 'contains-some',
		type: 'all',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'all-malformed'
	},
	{
		q: 'absent',
		type: 'all',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'over-cap'
	}
];
