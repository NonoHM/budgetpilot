import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fake Prisma for the tag service.
 *
 * Deliberately records call arguments rather than simulating a database: what these tests assert
 * is the SHAPE of the queries, above all that every mutation carries `userId`. Whether the engine
 * then behaves as intended under concurrency is a different question, and one a fake structurally
 * cannot answer, so it is asked against real engines in tags.db-smoke.ts.
 */
const db = vi.hoisted(() => {
	const prisma = {
		tag: {
			upsert: vi.fn(),
			updateMany: vi.fn(),
			deleteMany: vi.fn(),
			findMany: vi.fn()
		},
		transaction: {
			findFirst: vi.fn()
		},
		transactionTag: {
			findMany: vi.fn(),
			createMany: vi.fn(),
			deleteMany: vi.fn()
		}
	};
	return { prisma };
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

// The retry wrapper is exercised for real in categories/resolve.spec.ts and against real engines;
// here it is passed through so the upsert's arguments stay inspectable.
vi.mock('$lib/server/database/upsert', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/database/upsert')>();
	return {
		...actual,
		withConcurrentWriteRetry: vi.fn((run: () => Promise<unknown>) => run())
	};
});

const {
	resolveTagByName,
	renameTag,
	recolorTag,
	deleteTag,
	listTagsWithCounts,
	setTransactionTags,
	pruneOrphanTags,
	TagVanishedError
} = await import('./service');
const { computeNameKey } = await import('$lib/server/naming/nameKey');
const { MAX_TAGS_PER_TRANSACTION, TAG_COLOR_TOKENS } = await import('$lib/domain/tags');

beforeEach(() => {
	vi.clearAllMocks();
	db.prisma.tag.upsert.mockResolvedValue({ id: 'tag-row-1' });
	db.prisma.tag.updateMany.mockResolvedValue({ count: 1 });
	db.prisma.tag.deleteMany.mockResolvedValue({ count: 1 });
	db.prisma.tag.findMany.mockResolvedValue([]);
	db.prisma.transaction.findFirst.mockResolvedValue({ id: 'tx-1' });
	db.prisma.transactionTag.findMany.mockResolvedValue([]);
	db.prisma.transactionTag.createMany.mockResolvedValue({ count: 0 });
	db.prisma.transactionTag.deleteMany.mockResolvedValue({ count: 0 });
});

describe('resolveTagByName', () => {
	it('upserts on the folded name so two spellings are one tag', async () => {
		expect.assertions(2);

		await resolveTagByName('user-a', 'Portugal');
		await resolveTagByName('user-a', 'portugal');

		expect(db.prisma.tag.upsert).toHaveBeenCalledTimes(2);
		const [first, second] = db.prisma.tag.upsert.mock.calls;
		expect(first[0].where.userId_nameKey.nameKey).toBe(second[0].where.userId_nameKey.nameKey);
	});

	it('scopes the upsert key by userId, not by nameKey alone', async () => {
		expect.assertions(1);

		await resolveTagByName('user-a', 'Portugal');

		expect(db.prisma.tag.upsert.mock.calls[0][0].where.userId_nameKey.userId).toBe('user-a');
	});

	it('assigns a colour deterministically and never writes a raw hex', async () => {
		expect.assertions(2);

		await resolveTagByName('user-a', 'Portugal');

		const created = db.prisma.tag.upsert.mock.calls[0][0].create;
		// Membership in the closed set, not a shape regex. The regex this replaced encoded the
		// token spelling, so it went red on a pure rename while still passing for any string that
		// merely looked like a token. What the column actually guarantees is membership.
		expect(TAG_COLOR_TOKENS).toContain(created.colorToken);
		expect(created.nameKey).toBe(computeNameKey('Portugal'));
	});

	it('leaves an existing tag name untouched on a second resolve', async () => {
		expect.assertions(1);

		await resolveTagByName('user-a', 'PORTUGAL');

		// An empty update is what keeps "PORTUGAL" typed later from rewriting the tag the user
		// deliberately named "Portugal". Same rule as resolveCategoryByName.
		expect(db.prisma.tag.upsert.mock.calls[0][0].update).toEqual({});
	});

	it('refuses to return a tag whose id the upsert did not produce', async () => {
		expect.assertions(1);

		// Exactly what CI observed on PostgreSQL. With `update: {}` Prisma compiles the upsert to
		// SELECT-then-UPDATE rather than INSERT ... ON CONFLICT, and a concurrent prune deleting the
		// row between those two statements makes the UPDATE match nothing, so RETURNING yields no
		// row and Prisma hands back an object with no id instead of raising. Returning it would let
		// `tagId: undefined` reach a createMany, which fails far from the cause.
		db.prisma.tag.upsert.mockResolvedValue({});

		await expect(resolveTagByName('user-a', 'Portugal')).rejects.toThrow(TagVanishedError);
	});

	it('treats a P2025 from the upsert as the same vanished tag', async () => {
		expect.assertions(1);

		// The other outcome of the SAME window, and the one CI hit on the second run: the fallback's
		// SELECT found the row and the UPDATE that followed matched nothing. Identical code produced
		// the id-less object above on one run and this error on the next, so both normalise to one
		// type rather than making every caller know which it got.
		db.prisma.tag.upsert.mockRejectedValue(
			Object.assign(new Error('No record was found for an upsert.'), { code: 'P2025' })
		);

		await expect(resolveTagByName('user-a', 'Portugal')).rejects.toThrow(TagVanishedError);
	});

	it('recovers by re-resolving after a P2025, not only after an id-less row', async () => {
		expect.assertions(1);

		db.prisma.tag.upsert
			.mockRejectedValueOnce(
				Object.assign(new Error('No record was found for an upsert.'), { code: 'P2025' })
			)
			.mockResolvedValue({ id: 'tag-row-1' });

		expect(await setTransactionTags('user-a', 'tx-1', ['Portugal'])).toBe('ok');
	});

	it('rethrows an upsert error that is not the prune race', async () => {
		expect.assertions(1);

		// P2025 is normalised, everything else is not. Swallowing an unrelated failure into a retry
		// would turn one error into three and hide its cause.
		db.prisma.tag.upsert.mockRejectedValue(new Error('connection lost'));

		await expect(resolveTagByName('user-a', 'Portugal')).rejects.toThrow('connection lost');
	});

	it('recovers by re-resolving when the first upsert came back without an id', async () => {
		expect.assertions(2);

		// The throw above is only half the fix. Left uncaught it would turn a silent bad insert into
		// a 500 on an ordinary edit, so the caller with the retry loop has to absorb it.
		db.prisma.tag.upsert.mockResolvedValueOnce({}).mockResolvedValue({ id: 'tag-row-1' });

		expect(await setTransactionTags('user-a', 'tx-1', ['Portugal'])).toBe('ok');
		expect(db.prisma.transactionTag.createMany).toHaveBeenCalledWith({
			data: [{ transactionId: 'tx-1', tagId: 'tag-row-1' }]
		});
	});

	it('refuses a name that normalizes to empty', async () => {
		expect.assertions(2);

		await expect(resolveTagByName('user-a', '   ')).rejects.toThrow();
		expect(db.prisma.tag.upsert).not.toHaveBeenCalled();
	});
});

describe('renameTag', () => {
	it('writes name and nameKey in one update so they cannot diverge', async () => {
		expect.assertions(2);

		await renameTag('user-a', 'clay', 'Portugal 2026');

		const call = db.prisma.tag.updateMany.mock.calls[0][0];
		expect(call.data.name).toBe('Portugal 2026');
		expect(call.data.nameKey).toBe(computeNameKey('Portugal 2026'));
	});

	it('scopes the update by id AND userId', async () => {
		expect.assertions(1);

		await renameTag('user-a', 'clay', 'Portugal');

		expect(db.prisma.tag.updateMany.mock.calls[0][0].where).toEqual({
			id: 'clay',
			userId: 'user-a'
		});
	});

	it('reports not-found on a zero count, indistinguishably from another user tag', async () => {
		expect.assertions(1);

		db.prisma.tag.updateMany.mockResolvedValue({ count: 0 });

		expect(await renameTag('user-a', 'someone-elses-tag', 'Portugal')).toBe('not-found');
	});

	it('reports duplicate when the unique constraint fires', async () => {
		expect.assertions(1);

		db.prisma.tag.updateMany.mockRejectedValue(
			Object.assign(new Error('unique'), { code: 'P2002' })
		);

		expect(await renameTag('user-a', 'clay', 'Existant')).toBe('duplicate');
	});

	it('rethrows an error that is not a unique violation', async () => {
		expect.assertions(1);

		db.prisma.tag.updateMany.mockRejectedValue(new Error('connection lost'));

		await expect(renameTag('user-a', 'clay', 'Portugal')).rejects.toThrow('connection lost');
	});
});

describe('recolorTag', () => {
	it('refuses a token outside the palette without touching the database', async () => {
		expect.assertions(2);

		expect(await recolorTag('user-a', 'clay', '#ff0000')).toBe('invalid-color');
		expect(db.prisma.tag.updateMany).not.toHaveBeenCalled();
	});

	it('scopes the update by id AND userId', async () => {
		expect.assertions(2);

		expect(await recolorTag('user-a', 'clay', 'azure')).toBe('ok');
		expect(db.prisma.tag.updateMany.mock.calls[0][0].where).toEqual({
			id: 'clay',
			userId: 'user-a'
		});
	});
});

describe('deleteTag', () => {
	it('scopes the delete by id AND userId and reports not-found on zero', async () => {
		expect.assertions(2);

		db.prisma.tag.deleteMany.mockResolvedValue({ count: 0 });

		expect(await deleteTag('user-a', 'clay')).toBe('not-found');
		expect(db.prisma.tag.deleteMany.mock.calls[0][0].where).toEqual({
			id: 'clay',
			userId: 'user-a'
		});
	});
});

describe('listTagsWithCounts', () => {
	it('scopes by userId and returns the transaction count per tag', async () => {
		expect.assertions(2);

		db.prisma.tag.findMany.mockResolvedValue([
			{ id: 't1', name: 'Portugal', colorToken: 'olive', _count: { transactions: 4 } }
		]);

		const result = await listTagsWithCounts('user-a');

		expect(db.prisma.tag.findMany.mock.calls[0][0].where).toEqual({ userId: 'user-a' });
		expect(result).toEqual([
			{ id: 't1', name: 'Portugal', colorToken: 'olive', transactionCount: 4 }
		]);
	});

	it('falls back to a real token rather than surfacing one the palette does not define', async () => {
		expect.assertions(1);

		db.prisma.tag.findMany.mockResolvedValue([
			{ id: 't1', name: 'Ancien', colorToken: 'legacy-99', _count: { transactions: 0 } }
		]);

		const [tag] = await listTagsWithCounts('user-a');

		expect(tag.colorToken).toBe('clay');
	});
});

describe('setTransactionTags', () => {
	it('refuses a transaction belonging to another user, before any write', async () => {
		expect.assertions(3);

		db.prisma.transaction.findFirst.mockResolvedValue(null);

		expect(await setTransactionTags('user-a', 'someone-elses-tx', ['Portugal'])).toBe('not-found');
		expect(db.prisma.transactionTag.createMany).not.toHaveBeenCalled();
		expect(db.prisma.tag.upsert).not.toHaveBeenCalled();
	});

	it('establishes ownership with an id AND userId read', async () => {
		expect.assertions(1);

		await setTransactionTags('user-a', 'tx-1', ['Portugal']);

		expect(db.prisma.transaction.findFirst.mock.calls[0][0].where).toEqual({
			id: 'tx-1',
			userId: 'user-a'
		});
	});

	it('refuses more than MAX_TAGS_PER_TRANSACTION', async () => {
		expect.assertions(2);

		const names = Array.from({ length: MAX_TAGS_PER_TRANSACTION + 1 }, (_, i) => `tag ${i}`);

		expect(await setTransactionTags('user-a', 'tx-1', names)).toBe('too-many');
		expect(db.prisma.transactionTag.createMany).not.toHaveBeenCalled();
	});

	it('counts the DE-DUPLICATED set against the cap, not the raw input', async () => {
		expect.assertions(2);

		// Eleven DISTINCT spellings that all fold to one tag are one tag, not eleven. Refusing them
		// would be a false refusal on a legal edit.
		//
		// They have to be distinct, and that is the whole point of the fixture. Eleven identical
		// strings de-duplicate under either rule, and five varied ones stay under the cap of 10, so
		// both of those versions passed while the code was still folding by DISPLAY name. Toggling
		// one letter's case per index gives 11 strings no Set of display names collapses, which is
		// the only shape that reaches the cap check.
		// Long enough that one distinct spelling exists per index: an 8-letter base wrapped at
		// `i % base.length` and produced only 8, which the size assertion below caught.
		const base = 'vacancesportugal';
		const names = Array.from({ length: MAX_TAGS_PER_TRANSACTION + 1 }, (_, i) =>
			base
				.split('')
				.map((letter, position) => (position === i % base.length ? letter.toUpperCase() : letter))
				.join('')
		);
		expect(new Set(names).size).toBe(MAX_TAGS_PER_TRANSACTION + 1);

		expect(await setTransactionTags('user-a', 'tx-1', names)).toBe('ok');
	});

	it('de-duplicates names that fold to the same tag', async () => {
		expect.assertions(1);

		await setTransactionTags('user-a', 'tx-1', ['Portugal', 'portugal', 'PORTUGAL']);

		expect(db.prisma.tag.upsert).toHaveBeenCalledTimes(1);
	});

	it('deletes only the links the user removed, leaving the others alone', async () => {
		expect.assertions(2);

		db.prisma.transactionTag.findMany.mockResolvedValue([{ tagId: 'clay' }, { tagId: 'ochre' }]);
		db.prisma.tag.upsert
			.mockResolvedValueOnce({ id: 'clay' })
			.mockResolvedValueOnce({ id: 'olive' });

		await setTransactionTags('user-a', 'tx-1', ['Un', 'Trois']);

		expect(db.prisma.transactionTag.deleteMany.mock.calls[0][0].where.tagId).toEqual({
			in: ['ochre']
		});
		// clay was already linked and must not be re-inserted: the composite primary key would
		// reject it and the whole edit would fail.
		expect(db.prisma.transactionTag.createMany.mock.calls[0][0].data).toEqual([
			{ transactionId: 'tx-1', tagId: 'olive' }
		]);
	});

	it('writes nothing at all when the set is unchanged', async () => {
		expect.assertions(3);

		db.prisma.transactionTag.findMany.mockResolvedValue([{ tagId: 'tag-row-1' }]);

		expect(await setTransactionTags('user-a', 'tx-1', ['Portugal'])).toBe('ok');
		expect(db.prisma.transactionTag.createMany).not.toHaveBeenCalled();
		expect(db.prisma.transactionTag.deleteMany).not.toHaveBeenCalled();
	});

	it('retries once when a concurrent prune deletes the tag between resolve and link', async () => {
		expect.assertions(3);

		// The race measured on a real engine (tags.db-smoke.ts): the tag is resolved, a concurrent
		// prune legitimately deletes it because it has no transactions yet, and the link insert
		// then hits P2003. Recovery requires RE-RESOLVING, not merely re-inserting, which is why
		// the retry wraps both.
		db.prisma.transactionTag.createMany
			.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: 'P2003' }))
			.mockResolvedValue({ count: 1 });

		expect(await setTransactionTags('user-a', 'tx-1', ['Portugal'])).toBe('ok');
		expect(db.prisma.transactionTag.createMany).toHaveBeenCalledTimes(2);
		// Re-resolved rather than reusing the id that just vanished.
		expect(db.prisma.tag.upsert).toHaveBeenCalledTimes(2);
	});

	it('still prunes the tag it unlinked when the link insert had to be retried', async () => {
		expect.assertions(2);

		// The interaction the retry test and the prune test could not see between them: a retry
		// that ALSO removes a tag. If the removal is written before the insert, the second attempt
		// re-reads the links, finds the removed one already gone, computes an empty removal set,
		// and the orphaned tag is never pruned. Tested together because per-leg testing is exactly
		// what misses this.
		// A STATEFUL fake, not a scripted sequence, and that distinction is the point. A constant
		// findMany keeps reporting the removed link, so the second attempt recomputes the same
		// removal set and the bug is invisible; a scripted `once([old]).then([])` encodes the
		// buggy delete-before-insert order and so goes red against the CORRECT code. Only a fake
		// that reflects the writes the code actually issued is right under both orders.
		const links: Array<{ tagId: string }> = [{ tagId: 'tag-old' }];
		db.prisma.transactionTag.findMany.mockImplementation(async () => [...links]);
		db.prisma.transactionTag.deleteMany.mockImplementation(
			async ({ where }: { where: { tagId: { in: string[] } } }) => {
				const before = links.length;
				const kept = links.filter((link) => !where.tagId.in.includes(link.tagId));
				links.length = 0;
				links.push(...kept);
				return { count: before - links.length };
			}
		);
		db.prisma.tag.upsert.mockResolvedValue({ id: 'tag-new' });
		db.prisma.transactionTag.createMany
			.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: 'P2003' }))
			.mockImplementation(async ({ data }: { data: Array<{ tagId: string }> }) => {
				links.push(...data.map((row) => ({ tagId: row.tagId })));
				return { count: data.length };
			});

		expect(await setTransactionTags('user-a', 'tx-1', ['Nouveau'])).toBe('ok');
		expect(db.prisma.tag.deleteMany.mock.calls[0][0].where.id).toEqual({ in: ['tag-old'] });
	});

	it('leaves the existing links intact when every link attempt fails', async () => {
		expect.assertions(2);

		// A failed edit must be a no-op, not a destructive one. Deleting the old links before the
		// new ones land means three failed attempts leave the user with neither set.
		db.prisma.transactionTag.findMany.mockResolvedValue([{ tagId: 'tag-old' }]);
		db.prisma.tag.upsert.mockResolvedValue({ id: 'tag-new' });
		db.prisma.transactionTag.createMany.mockRejectedValue(
			Object.assign(new Error('fk'), { code: 'P2003' })
		);

		await expect(setTransactionTags('user-a', 'tx-1', ['Nouveau'])).rejects.toThrow('fk');
		expect(db.prisma.transactionTag.deleteMany).not.toHaveBeenCalled();
	});

	it('rethrows a foreign-key violation that keeps recurring rather than looping forever', async () => {
		expect.assertions(2);

		db.prisma.transactionTag.createMany.mockRejectedValue(
			Object.assign(new Error('fk'), { code: 'P2003' })
		);

		await expect(setTransactionTags('user-a', 'tx-1', ['Portugal'])).rejects.toThrow('fk');
		expect(db.prisma.transactionTag.createMany).toHaveBeenCalledTimes(3);
	});

	it('does not retry an error that is not a foreign-key violation', async () => {
		expect.assertions(2);

		db.prisma.transactionTag.createMany.mockRejectedValue(new Error('connection lost'));

		await expect(setTransactionTags('user-a', 'tx-1', ['Portugal'])).rejects.toThrow(
			'connection lost'
		);
		expect(db.prisma.transactionTag.createMany).toHaveBeenCalledTimes(1);
	});

	it('prunes only the tags it just unlinked', async () => {
		expect.assertions(1);

		db.prisma.transactionTag.findMany.mockResolvedValue([{ tagId: 'clay' }, { tagId: 'ochre' }]);
		db.prisma.tag.upsert.mockResolvedValue({ id: 'clay' });

		await setTransactionTags('user-a', 'tx-1', ['Un']);

		expect(db.prisma.tag.deleteMany.mock.calls[0][0].where.id).toEqual({ in: ['ochre'] });
	});
});

describe('pruneOrphanTags', () => {
	it('deletes only tags with no remaining transactions, atomically', async () => {
		expect.assertions(3);

		await pruneOrphanTags('user-a', ['ochre']);

		const where = db.prisma.tag.deleteMany.mock.calls[0][0].where;
		expect(where.userId).toBe('user-a');
		expect(where.id).toEqual({ in: ['ochre'] });
		// The emptiness condition is INSIDE the delete, not a read followed by a write. A request
		// tagging one of these at the same moment must lose the delete, not orphan a link.
		expect(where.transactions).toEqual({ none: {} });
	});

	it('does nothing when handed an empty list', async () => {
		expect.assertions(1);

		await pruneOrphanTags('user-a', []);

		expect(db.prisma.tag.deleteMany).not.toHaveBeenCalled();
	});
});
