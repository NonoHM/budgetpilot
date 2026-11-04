import { normalizeForMatch } from './normalize';

/**
 * A category proposed from the member's own history, with no model (#1014, decided in #1009).
 *
 * « The same label » is `historyKey`: the label folded by `normalizeForMatch`, keeping only the
 * tokens made of letters, so a card date (` 12/03`) or a reference does not split one merchant.
 * There is no similarity stage beyond that: a merchant the member never filed gets nothing, which
 * the measurement reports as its own figure (#1014). A label whose only words are generic
 * (« VIR SEPA » followed by a reference number) shares one key with every such label, so the floor
 * below is what keeps it from proposing unless the member filed them all alike.
 *
 * Among the member's latest `HISTORY_WINDOW` rows of that key, the most frequent category is
 * proposed when its share reaches `HISTORY_SUGGESTION_FLOOR`. The floor is GnuCash's import
 * matcher threshold (`.90 * probability_factor`, `libgnucash/engine/Account.cpp` at b183b50); the
 * recent window follows Actual Budget, which votes over a payee's latest transactions rather than
 * all of them, so a member who moved a merchant to another category is followed.
 *
 * Pure: the caller passes rows the member set (`categorySetBy` is `member`), never a rule's or an
 * imported file's category, which is the poisoning route the plan names (AISVS C1.3.2).
 */
export const HISTORY_SUGGESTION_FLOOR = 0.9;
export const HISTORY_WINDOW = 10;

export type HistoryRow = { label: string; category: string; date: Date };
export type HistoryIndex = ReadonlyMap<string, readonly string[]>;

export function historyKey(label: string): string {
	return normalizeForMatch(label)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => /^\p{L}+$/u.test(token))
		.join(' ');
}

/** Each key's latest `HISTORY_WINDOW` categories, newest first, whatever order rows arrive in. */
export function buildHistoryIndex(rows: readonly HistoryRow[]): HistoryIndex {
	const index = new Map<string, string[]>();
	const newestFirst = [...rows].sort((a, b) => b.date.getTime() - a.date.getTime());
	for (const row of newestFirst) {
		const key = historyKey(row.label);
		if (key === '') continue;
		const window = index.get(key) ?? [];
		if (window.length < HISTORY_WINDOW) window.push(row.category);
		index.set(key, window);
	}
	return index;
}

export function suggestFromHistory(index: HistoryIndex, label: string): string | null {
	const window = index.get(historyKey(label));
	if (!window || window.length === 0) return null;
	const counts = new Map<string, number>();
	for (const key of window) counts.set(key, (counts.get(key) ?? 0) + 1);
	const [top, count] = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
	return count / window.length >= HISTORY_SUGGESTION_FLOOR ? top : null;
}
