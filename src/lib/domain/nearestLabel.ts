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
	labelled: ReadonlyArray<{ vector: Sparse; category: string; words: ReadonlySet<string> }>;
	/** How many of the corpus's distinct keys hold each word, and how many keys there are. */
	wordDf: ReadonlyMap<string, number>;
	documents: number;
};

/** 3- to 5-character grams of each word, padded so a word's start and end are grams of their own. */
function grams(label: string): Sparse {
	return gramsOfKey(historyKey(label));
}

/** The same, over a label already folded by `historyKey`, so a corpus is folded once. */
function gramsOfKey(key: string): Sparse {
	const counts: Sparse = new Map();
	for (const word of key.split(' ').filter(Boolean)) {
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

const wordsOfKey = (key: string) => new Set(key.split(' ').filter(Boolean));

/**
 * One entry per distinct key and category, so a merchant filed fifty times is one neighbour.
 *
 * The IDF is fitted on `corpus`, every label the member holds whether filed or not, as a
 * vectorizer is fitted on its whole corpus with no category read (scikit-learn's `fit`): a bank's
 * « CB » or « PRLV SEPA » then weighs what it weighs across the account, not what it weighs among
 * the few rows the member filed by hand (contradiction pass 1016-note-1, F1). Only `rows`, the
 * member's own choices, are ever proposed from (AISVS 1.0 C1.3.2). Without a corpus, the filed
 * rows are their own, which is B3's measurement.
 */
export function buildNgramIndex(
	rows: readonly { label: string; category: string }[],
	corpus: readonly string[] = rows.map((row) => row.label)
): NgramIndex {
	const distinct = new Map<string, { key: string; category: string }>();
	for (const row of rows) {
		const key = historyKey(row.label);
		distinct.set(`${key}\u0001${row.category}`, { key, category: row.category });
	}
	// The filed labels are in the corpus by construction, whatever the caller's cap cut. Each key's
	// grams are counted once and reused for the filed vectors.
	const gramsByKey = new Map<string, Sparse>();
	for (const key of [...corpus.map(historyKey), ...[...distinct.values()].map((d) => d.key)])
		if (key !== '' && !gramsByKey.has(key)) gramsByKey.set(key, gramsOfKey(key));
	const df = new Map<string, number>();
	const wordDf = new Map<string, number>();
	for (const [key, counts] of gramsByKey) {
		for (const gram of counts.keys()) df.set(gram, (df.get(gram) ?? 0) + 1);
		for (const word of wordsOfKey(key)) wordDf.set(word, (wordDf.get(word) ?? 0) + 1);
	}
	const documents = gramsByKey.size;
	// Smoothed IDF, as scikit-learn's TfidfVectorizer computes it: ln((1 + N) / (1 + df)) + 1.
	const idf = new Map([...df].map(([gram, n]) => [gram, Math.log((1 + documents) / (1 + n)) + 1]));
	return {
		idf,
		labelled: [...distinct.values()].map(({ key, category }) => ({
			vector: weigh(gramsByKey.get(key) ?? new Map(), idf),
			category,
			words: wordsOfKey(key)
		})),
		wordDf,
		documents
	};
}

/** Each filed label's cosine to `label`, in the index's order. */
function similarities(index: NgramIndex, label: string): number[] {
	const query = weigh(grams(label), index.idf);
	return index.labelled.map(({ vector }) => {
		let dot = 0;
		for (const [gram, weight] of query) dot += weight * (vector.get(gram) ?? 0);
		return dot;
	});
}

const ranking = (index: NgramIndex, scores: number[]) =>
	rankByNearest(index.labelled.map(({ category }, i) => ({ category, similarity: scores[i] })));

export function nearestByNgrams(index: NgramIndex, label: string): Ranked | null {
	return ranking(index, similarities(index, label));
}

/**
 * The lead the nearest category must hold over the next before it is proposed (#1016). Read off
 * the SPARSE protocol of `modelResidue.measure.spec.ts`, where 1, 3 or 10 rows per category are
 * filed and the rest are only in the corpus: the largest of the three fit-fold thresholds that
 * reach 0.90 precision (0.259, 0.129, 0.258 on 2026-11-28), rounded up, then scored on the held
 * fold. The spec asserts both, so moving this below a fit threshold reddens it. Above 0, so two
 * categories equally near never propose a coin toss.
 */
export const SIMILAR_MARGIN = 0.26;

/**
 * The share of the member's distinct labels a word may appear in and still say something about
 * the merchant. The threshold semantics of scikit-learn's `max_df`, which drops « corpus-specific
 * stop words » above it (`sklearn/feature_extraction/text.py` at 1.7.2), applied here to the WHOLE
 * words the gate below reads, not to the grams the similarity is computed over. Measured on the invented set, 130 keys: the
 * bank prefixes sit at 0.23 to 0.54 (`cb`, `sepa`, `prlv`, `vir`), trade words at 0.08 or less.
 * A word shared by two labels is then in at least 2 of them, so a member holding fewer than 20
 * distinct labels is proposed nothing similar: too few labels to tell a prefix from a trade word.
 */
export const SIMILAR_MAX_DF = 0.1;

/**
 * The nearest category to a label nobody filed, with its lead, when its nearest filed label shares
 * a WHOLE word with this one that is in at most `SIMILAR_MAX_DF` of the labels the member holds;
 * otherwise `null`. Shared grams alone are not enough: « primeurs » is mostly « primeur », and a
 * prefix every row carries says nothing about the merchant. The measurement reads this, so the
 * threshold it sets is the one this gate is applied under.
 */
export function similarLead(index: NgramIndex, label: string): Ranked | null {
	const scores = similarities(index, label);
	const ranked = ranking(index, scores);
	if (!ranked) return null;
	const nearest = index.labelled[scores.indexOf(ranked.similarity)];
	return [...wordsOfKey(historyKey(label))].some(
		(word) =>
			nearest.words.has(word) && (index.wordDf.get(word) ?? 0) <= SIMILAR_MAX_DF * index.documents
	)
		? ranked
		: null;
}

/** The category proposed for a label nobody filed, from the member's own filed labels (#1016). */
export function suggestFromSimilar(index: NgramIndex, label: string): string | null {
	const lead = similarLead(index, label);
	return lead && lead.margin >= SIMILAR_MARGIN ? lead.category : null;
}
