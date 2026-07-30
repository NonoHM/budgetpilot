import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		category: {
			findFirst: vi.fn(),
			upsert: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { resolveCategoryByName } = await import('./resolve');
const { computeNameKey } = await import('$lib/server/naming/nameKey');

describe('resolveCategoryByName', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.category.upsert.mockResolvedValue({ id: 'category-1' });
	});

	it('resolves in a single upsert keyed on the folded name', async () => {
		expect.assertions(2);

		await resolveCategoryByName('user-1', 'Alimentation');

		// One statement, no preceding read. The previous version looked the folded name up and
		// fell back to an upsert on the raw name, which was safe only because SQLite serializes
		// writers: two concurrent imports of a new category could both miss the read and both
		// insert, and a raw-name constraint would not stop them if the spellings differed.
		expect(db.prisma.category.findFirst).not.toHaveBeenCalled();
		expect(db.prisma.category.upsert).toHaveBeenCalledWith({
			where: {
				userId_nameKey: { userId: 'user-1', nameKey: computeNameKey('Alimentation') }
			},
			update: {},
			create: {
				userId: 'user-1',
				name: 'Alimentation',
				nameKey: computeNameKey('Alimentation')
			},
			select: { id: true }
		});
	});

	it.each([
		['alimentation', 'Alimentation'],
		['ALIMENTATION', 'Alimentation'],
		['Alimentâtion', 'Alimentation']
	])('resolves %s to the same key as %s', async (spelling, canonical) => {
		expect.assertions(1);

		await resolveCategoryByName('user-1', spelling);

		expect(db.prisma.category.upsert.mock.calls[0][0].where.userId_nameKey.nameKey).toBe(
			computeNameKey(canonical)
		);
	});

	it('never rewrites the name of a category that already exists', async () => {
		expect.assertions(1);

		await resolveCategoryByName('user-1', 'ALIMENTATION');

		// An import announcing "ALIMENTATION" must not rename the category the user
		// deliberately called "Alimentation": the spelling is only written on creation.
		expect(db.prisma.category.upsert.mock.calls[0][0].update).toEqual({});
	});

	it('scopes the lookup to the calling user', async () => {
		expect.assertions(2);

		await resolveCategoryByName('user-1', 'Alimentation');

		const { where, create } = db.prisma.category.upsert.mock.calls[0][0];
		expect(where.userId_nameKey.userId).toBe('user-1');
		expect(create.userId).toBe('user-1');
	});
});
