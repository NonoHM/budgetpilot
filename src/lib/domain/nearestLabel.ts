import { historyKey } from './historySuggestion';

/**
 * Reading a label nobody filed by the filed labels nearest to it (#1015, B3), with one confidence
 * for every reader: the MARGIN between the best category and the runner-up. Selective
 * classification abstains below a threshold on such a score (Geifman and El-Yaniv,
 * arXiv:1705.08500); the threshold is read off B3's risk-coverage curve, never shown on screen.
 *
 * Two readers share `rankByNearest`, so they cannot come to disagree about what a lead is:
 *
 * - the embedding reader, whose similarities are `cosine` over `embedLocalModel` vectors;
 * - the character n-gram reader below, which needs no model host at all: TF-IDF over 3- to
 *   5-character grams of `historyKey`, the baseline any model must beat (TF-IDF plus a linear
 *   model is the baseline arXiv:2508.05425 and arXiv:2312.07730 report for transactions).
 *
 * Pure, and over `historyKey` only: what reaches a reader is the label's letter tokens, never an
 * amount, a date or a reference.
 */

export type Scored = { category: string; similarity: number };
export type Ranked = { category: string; similarity: number; margin: number };

/**
 * Each category by its single most similar label, the maximum and not a sum, so many weak
 * neighbours cannot outvote one close match. A lone category leads a runner-up at zero. A
 * similarity of zero or less is no evidence, and nothing at all ranks as `null`.
 */
export function rankByNearest(scored: readonly Scored[]): Ranked | null {
	const best = new Map<string, number>();
	for (const { category, similarity } of scored) {
		// Above the best so far, which starts at 0: a similarity of zero or less never enters.
		if (similarity > (best.get(category) ?? 0)) best.set(category, similarity);
	}
	const [first, second] = [...best].sort((a, b) => b[1] - a[1]);
	if (!first) return null;
	return { category: first[0], similarity: first[1], margin: first[1] - (second?.[1] ?? 0) };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
	if (a.length !== b.length) throw new Error('cosine: two vectors of different width');
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

type Sparse = Map<string, number>;
export type NgramIndex = {
	idf: ReadonlyMap<string, number>;
	labelled: ReadonlyArray<{ vector: Sparse; category: string }>;
};

/** 3- to 5-character grams of each word, padded so a word's start and end are grams of their own. */
function grams(label: string): Sparse {
	const counts: Sparse = new Map();
	for (const word of historyKey(label).split(' ').filter(Boolean)) {
		const padded = ` ${word} `;
		for (let n = 3; n <= 5; n++) {
			for (let i = 0; i + n <= padded.length; i++) {
				const gram = padded.slice(i, i + n);
				counts.set(gram, (counts.get(gram) ?? 0) + 1);
			}
		}
	}
	return counts;
}

/** TF-IDF weights, unit length, so a dot product is the cosine. A gram the index never saw weighs 0. */
function weigh(counts: Sparse, idf: ReadonlyMap<string, number>): Sparse {
	const vector: Sparse = new Map();
	let norm = 0;
	for (const [gram, count] of counts) {
		const weight = count * (idf.get(gram) ?? 0);
		if (weight === 0) continue;
		vector.set(gram, weight);
		norm += weight * weight;
	}
	for (const [gram, weight] of vector) vector.set(gram, weight / Math.sqrt(norm));
	return vector;
}

/** One entry per distinct key and category, so a merchant filed fifty times is one neighbour. */
export function buildNgramIndex(rows: readonly { label: string; category: string }[]): NgramIndex {
	const distinct = new Map<string, { label: string; category: string }>();
	for (const row of rows) distinct.set(`${historyKey(row.label)}\u0001${row.category}`, row);
	const counted = [...distinct.values()].map((row) => ({ counts: grams(row.label), ...row }));
	const df = new Map<string, number>();
	for (const { counts } of counted)
		for (const gram of counts.keys()) df.set(gram, (df.get(gram) ?? 0) + 1);
	// Smoothed IDF, as scikit-learn's TfidfVectorizer computes it: ln((1 + N) / (1 + df)) + 1.
	const idf = new Map(
		[...df].map(([gram, n]) => [gram, Math.log((1 + counted.length) / (1 + n)) + 1])
	);
	return {
		idf,
		labelled: counted.map(({ counts, category }) => ({ vector: weigh(counts, idf), category }))
	};
}

export function nearestByNgrams(index: NgramIndex, label: string): Ranked | null {
	const query = weigh(grams(label), index.idf);
	return rankByNearest(
		index.labelled.map(({ vector, category }) => {
			let dot = 0;
			for (const [gram, weight] of query) dot += weight * (vector.get(gram) ?? 0);
			return { category, similarity: dot };
		})
	);
}
