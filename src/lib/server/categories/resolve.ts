import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';

/**
 * Get-or-create for a category, matching on the folded name.
 *
 * The single write path for "I have a category name, give me its row": manual entry, budget
 * saving, CSV and bank import all land here. It exists because the raw-name unique
 * constraint no longer describes what the app means by a duplicate. A user who already has
 * "Courses" and imports a row categorized as "courses" must get the existing category back,
 * not a second one, since everything downstream (budgets, nature mappings, reports) now
 * treats those two spellings as one category.
 *
 * The folded lookup runs first, and the upsert on the raw name is the fallback that also
 * absorbs a concurrent first insert of the exact same spelling.
 */
export async function resolveCategoryByName(userId: string, name: string): Promise<{ id: string }> {
	const nameKey = computeNameKey(name);

	const existing = await prisma.category.findFirst({
		where: { userId, nameKey },
		select: { id: true }
	});
	if (existing) return existing;

	return prisma.category.upsert({
		where: { userId_name: { userId, name } },
		update: { nameKey },
		create: { userId, name, nameKey },
		select: { id: true }
	});
}
