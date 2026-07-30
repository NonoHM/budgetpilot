import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';

/**
 * Get-or-create for a category, matching on the folded name.
 *
 * The single write path for "I have a category name, give me its row": manual entry, budget
 * saving, CSV and bank import all land here. It exists because a raw-name comparison does not
 * describe what the app means by a duplicate. A user who already has "Courses" and imports a
 * row categorized as "courses" must get the existing category back, not a second one, since
 * everything downstream (budgets, nature mappings, reports) treats those two spellings as one
 * category.
 *
 * One `upsert` on `(userId, nameKey)`, not a read followed by a write. The previous version
 * looked the folded name up first and fell back to an upsert on the raw name, which was safe
 * only because SQLite serializes writers: under PostgreSQL's or MySQL's default isolation, two
 * concurrent imports of the same new category could both miss the read and both insert, and
 * the raw-name constraint would not stop them if the two spellings differed. The constraint now
 * sits on the key itself, so the database refuses the second insert and the upsert absorbs it.
 *
 * `name` is only written on creation. An existing category keeps the spelling the user chose,
 * which is why `update` touches nothing: an import announcing "COURSES" must not rewrite a
 * category the user deliberately named "Courses".
 */
export async function resolveCategoryByName(userId: string, name: string): Promise<{ id: string }> {
	return prisma.category.upsert({
		where: { userId_nameKey: { userId, nameKey: computeNameKey(name) } },
		update: {},
		create: { userId, name, nameKey: computeNameKey(name) },
		select: { id: true }
	});
}
