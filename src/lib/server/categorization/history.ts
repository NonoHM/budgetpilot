import { prisma } from '$lib/server/db';
import { categorySetBy } from '$lib/domain/categorySetBy';
import { buildHistoryIndex, type HistoryIndex } from '$lib/domain/historySuggestion';
import { computeNameKey } from '$lib/server/naming/nameKey';

// shortcut: the newest 5000 member-set rows bound the read on every list load; a merchant whose
// latest rows are all older than that gets no proposal. Move it to a per-key query if one does.
const MAX_HISTORY_ROWS = 5000;

/**
 * The member's own category choices, as the index `suggestFromHistory` reads (#1014).
 *
 * Only rows whose pin `categorySetBy` reads as `member`: never a rule's, never an accepted
 * suggestion (proposals would then reinforce themselves), never `unknown`, and never the file's
 * own `categoryId` (an imported column, the poisoning route AISVS 1.0 C1.3.2 is about). Scoped by
 * `userId` in the one where clause. A pin whose category no longer exists, or the « uncategorized »
 * sentinel, is dropped; the index holds the live category's NAME, matched on its key, because
 * `acceptSuggestion` posts a name and the page shows one.
 */
export async function loadMemberHistory(
	userId: string,
	categories: ReadonlyArray<{ id: string; name: string }>,
	uncategorizedCategoryId: string | null
): Promise<HistoryIndex> {
	const nameByKey = new Map(
		categories
			.filter((category) => category.id !== uncategorizedCategoryId)
			.map((category) => [computeNameKey(category.name), category.name])
	);
	const rows = await prisma.transaction.findMany({
		where: { userId, manualCategorySource: 'member' },
		orderBy: [{ date: 'desc' }, { id: 'desc' }],
		take: MAX_HISTORY_ROWS,
		select: {
			label: true,
			date: true,
			manualCategoryKey: true,
			manualCategorySource: true,
			manualCategorySourceKey: true
		}
	});
	return buildHistoryIndex(
		rows.flatMap((row) => {
			const name = row.manualCategoryKey ? nameByKey.get(row.manualCategoryKey) : undefined;
			return categorySetBy(row) === 'member' && name
				? [{ label: row.label, category: name, date: row.date }]
				: [];
		})
	);
}
