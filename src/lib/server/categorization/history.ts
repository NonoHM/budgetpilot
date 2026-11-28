import { prisma } from '$lib/server/db';
import { categorySetBy } from '$lib/domain/categorySetBy';
import { buildHistoryIndex, type HistoryIndex } from '$lib/domain/historySuggestion';
import { buildNgramIndex, type NgramIndex } from '$lib/domain/nearestLabel';
import { computeNameKey } from '$lib/server/naming/nameKey';

// shortcut: the newest 5000 member-set rows bound the read on every list load; a merchant whose
// latest rows are all older than that gets no proposal. Move it to a per-key query if one does.
const MAX_HISTORY_ROWS = 5000;

/** What every proposal past the rules reads: the same label (#1014), then a similar one (#1016). */
export type MemberHistory = { index: HistoryIndex; similar: NgramIndex };

/**
 * The member's own category choices, as the index `suggestFromHistory` reads (#1014), and the
 * n-gram index `suggestFromSimilar` reads (#1016): proposed from the same member-set rows, its IDF
 * fitted on the member's newest `limit` labels whatever their pin, under the same `userId` clause.
 *
 * Only rows whose pin `categorySetBy` reads as `member`: never a rule's, never an accepted
 * suggestion (proposals would then reinforce themselves), never `unknown`, and never an imported
 * file's category column, `categoryId` (the poisoning route the 1.4 plan names). A restored
 * backup keeps the author its file states (ruled under #1013), so a member's own backup feeds
 * their own history. Scoped by `userId` in the one where clause, and the source clause sits there
 * too, before the cap, so the cap counts member rows only. A pin whose category no longer exists, or the « uncategorized »
 * sentinel, is dropped; the index holds the live category's NAME, matched on its key, because
 * `acceptSuggestion` posts a name and the page shows one.
 */
export async function loadMemberHistory(
	userId: string,
	categories: ReadonlyArray<{ id: string; name: string }>,
	uncategorizedCategoryId: string | null,
	limit = MAX_HISTORY_ROWS
): Promise<MemberHistory> {
	const nameByKey = new Map(
		categories
			.filter((category) => category.id !== uncategorizedCategoryId)
			.map((category) => [computeNameKey(category.name), category.name])
	);
	const [corpus, rows] = await Promise.all([
		prisma.transaction.findMany({
			where: { userId },
			orderBy: [{ date: 'desc' }, { id: 'desc' }],
			take: limit,
			select: { label: true }
		}),
		prisma.transaction.findMany({
			where: { userId, manualCategorySource: 'member' },
			orderBy: [{ date: 'desc' }, { id: 'desc' }],
			take: limit,
			select: {
				label: true,
				date: true,
				manualCategoryKey: true,
				manualCategorySource: true,
				manualCategorySourceKey: true
			}
		})
	]);
	const filed = rows.flatMap((row) => {
		const name = row.manualCategoryKey ? nameByKey.get(row.manualCategoryKey) : undefined;
		return categorySetBy(row) === 'member' && name
			? [{ label: row.label, category: name, date: row.date }]
			: [];
	});
	return {
		index: buildHistoryIndex(filed),
		similar: buildNgramIndex(
			filed,
			corpus.map((row) => row.label)
		)
	};
}
