/**
 * The filter combination space for /transactions, enumerated rather than hoped for.
 *
 * Eight dimensions in value CLASSES (not raw values) give a full cross product of 58 320, which is
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
	// 'part-only' names a category NO PARENT carries — it exists solely on parts. It is what makes
	// OD-1 provable rather than merely present: `?category=<real>` matches the répartie rows through
	// their parent anyway, so without this class the splits branch of the category predicate could be
	// deleted and every row here would still pass.
	category: ['absent', 'real', 'part-only', 'nonexistent'],
	range: ['absent', 'valid-narrow', 'valid-covering-all', 'lone-from', 'malformed', 'reversed'],
	importBatch: ['absent', 'real', 'nonexistent'],
	tag: ['absent', 'real', 'nonexistent'],
	ids: ['absent', 'subset', 'empty', 'all-malformed', 'over-cap', 'covering-all'],
	// A fixed enum like `type`, not an id lookup like `tag`/`category` — `split` has no
	// real/nonexistent distinction, only the three literal values TransactionSplitFilter admits.
	split: ['all', 'split', 'unsplit']
} as const satisfies Record<string, readonly string[]>;

export type Dimensions = typeof DIMENSIONS;
export type FilterRow = { [K in keyof Dimensions]: Dimensions[K][number] };

/**
 * The classes that can actually RETURN ROWS, pairwise-covered separately. This exists because the
 * first run of the agreement suite was green and nearly worthless, and the number is worth keeping:
 * of 55 rows, **7** resolved a non-empty set. The other 48 compared empty against empty.
 *
 * Pairwise over DIMENSIONS is complete on the PARAMETER space and says almost nothing about the
 * RESULT space, because half the classes are deliberately barren — `nonexistent`, `contains-none`,
 * `empty`, `all-malformed` and every fail-closed range each zero the whole intersection on their
 * own, and a greedy pairwise row usually contains at least one of them. Both properties matter and
 * they are not the same property: DIMENSIONS proves the three sites agree on emptiness and on
 * refusal, this proves they agree on ACTUAL SETS.
 *
 * Asserting "every dimension is non-empty in the fixture" does not catch this — that check passed
 * while 87% of the matrix was proving nothing. The row-level assertion in scope.db-smoke.ts is what
 * catches it, and it is the one to keep honest if these classes ever change.
 */
export const PRODUCTIVE_DIMENSIONS = {
	q: ['absent', 'contains-some', 'regex-valid'],
	type: ['all', 'income', 'expense', 'classify'],
	category: ['absent', 'real', 'part-only'],
	range: ['absent', 'valid-narrow', 'valid-covering-all'],
	importBatch: ['absent', 'real'],
	tag: ['absent', 'real'],
	ids: ['absent', 'subset', 'over-cap', 'covering-all'],
	// All three, because the fixture now SEEDS répartitions (every 11th row). The first version of
	// this line excluded 'split' on the correct observation that no parts existed — which would have
	// declared the class in DIMENSIONS while it proved nothing, the "declared exception that never
	// moved" shape CLAUDE.md records. The fix is to give the class something to find, not to admit
	// it cannot find anything.
	split: ['all', 'split', 'unsplit']
} as const satisfies Record<keyof Dimensions, readonly string[]>;

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
 *  - type=classify x category: both push into `conditions[]`, and where.ts collapses one into
 *    `where.OR` and two into `where.AND`. The comment there records that they must not overwrite
 *    one another.
 *  - type=classify x split: the SECOND structural interaction, added with the Répartition filter.
 *    This one is not about `conditions[]` at all — both constrain the same RELATION, and the
 *    accumulator in where.ts resolves the contradictory pair to match-nothing rather than letting
 *    whichever was assigned last win. Pairwise over DIMENSIONS reaches the isolated pair, but not
 *    the property that matters here: that the contradiction dominates a rich background of other
 *    active filters instead of being quietly discarded by one of them. Hence a named row, and a
 *    second one pairing it with `ids=subset`, which is the conjunct the first implementation of
 *    this contradiction collided with.
 *
 *    This entry replaces a sentence that called classify x category "the only structural
 *    interaction". It was true when written and stopped being true the moment a filter constrained
 *    a relation another filter already constrained — which is exactly the expiry condition the
 *    DIMENSIONS docstring above states, met for the first time here.
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
		ids: 'absent',
		split: 'all'
	},
	// The contradiction, against a rich background: every other dimension is active and productive,
	// so a row coming back non-empty here means the classify requirement or the split requirement
	// was dropped rather than composed.
	{
		q: 'contains-some',
		type: 'classify',
		category: 'real',
		range: 'valid-covering-all',
		importBatch: 'real',
		tag: 'real',
		ids: 'covering-all',
		split: 'split'
	},
	// The same contradiction beside `ids=subset`. `?ids=` writes `where.id`, which the first draft
	// of the contradiction used as its match-nothing mechanism and which would have silently
	// overwritten it. Pinned so that mechanism cannot come back unnoticed.
	{
		q: 'absent',
		type: 'classify',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'subset',
		split: 'split'
	},
	// The productive half of the same dimension: répartie rows, on their own and crossed with the
	// category that only a PART carries. Without this row the split dimension would appear in the
	// matrix only through combinations that resolve nothing.
	{
		q: 'absent',
		type: 'all',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'absent',
		split: 'split'
	},
	{
		q: 'contains-some',
		type: 'classify',
		category: 'real',
		range: 'valid-narrow',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset',
		split: 'all'
	},
	{
		q: 'regex-valid',
		type: 'all',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'real',
		ids: 'subset',
		split: 'all'
	},
	{
		q: 'contains-some',
		type: 'all',
		category: 'absent',
		range: 'valid-narrow',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'absent',
		split: 'all'
	},
	{
		q: 'absent',
		type: 'all',
		category: 'absent',
		range: 'valid-covering-all',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'covering-all',
		split: 'all'
	},
	{
		q: 'regex-invalid',
		type: 'classify',
		category: 'real',
		range: 'valid-narrow',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset',
		split: 'all'
	},
	{
		q: 'contains-some',
		type: 'income',
		category: 'real',
		range: 'malformed',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset',
		split: 'all'
	},
	{
		q: 'contains-some',
		type: 'income',
		category: 'real',
		range: 'lone-from',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset',
		split: 'all'
	},
	{
		q: 'contains-some',
		type: 'income',
		category: 'real',
		range: 'reversed',
		importBatch: 'real',
		tag: 'real',
		ids: 'subset',
		split: 'all'
	},
	{
		q: 'contains-some',
		type: 'all',
		category: 'real',
		range: 'valid-narrow',
		importBatch: 'real',
		tag: 'real',
		ids: 'empty',
		split: 'all'
	},
	{
		q: 'absent',
		type: 'all',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'empty',
		split: 'all'
	},
	{
		q: 'absent',
		type: 'classify',
		category: 'real',
		range: 'absent',
		importBatch: 'absent',
		tag: 'real',
		ids: 'empty',
		split: 'all'
	},
	{
		q: 'contains-some',
		type: 'all',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'all-malformed',
		split: 'all'
	},
	{
		q: 'absent',
		type: 'all',
		category: 'absent',
		range: 'absent',
		importBatch: 'absent',
		tag: 'absent',
		ids: 'over-cap',
		split: 'all'
	}
];
