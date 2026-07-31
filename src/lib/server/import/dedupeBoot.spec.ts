import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same contract as naming/boot.spec.ts, on the other boot backfill: locked, and re-checked once
// the lock is held.

const hasPendingDedupeKeyHashes = vi.fn();
const runDedupeKeyHashBackfill = vi.fn();
const withBootBackfillLock = vi.fn(
	async (_name: string, work: () => Promise<unknown>) => await work()
);

vi.mock('$lib/server/db', () => ({ prisma: {} }));
vi.mock('./dedupeBackfill.ts', () => ({
	hasPendingDedupeKeyHashes,
	runDedupeKeyHashBackfill
}));
vi.mock('$lib/server/database/advisoryLock', () => ({ withBootBackfillLock }));

const { ensureDedupeKeyHashesBackfilled } = await import('./dedupeBoot');

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	withBootBackfillLock.mockImplementation(async (_name, work) => await work());
	runDedupeKeyHashBackfill.mockResolvedValue(0);
});

describe('ensureDedupeKeyHashesBackfilled', () => {
	it('takes no lock when every row already carries its hash', async () => {
		hasPendingDedupeKeyHashes.mockResolvedValue(false);

		await ensureDedupeKeyHashesBackfilled();

		expect(withBootBackfillLock).not.toHaveBeenCalled();
	});

	it('holds its own lock, not the name-key one', async () => {
		hasPendingDedupeKeyHashes.mockResolvedValue(true);

		await ensureDedupeKeyHashesBackfilled();

		// A separate name so neither backfill waits on work it does not depend on.
		expect(withBootBackfillLock).toHaveBeenCalledWith('dedupe-keys', expect.any(Function));
		expect(runDedupeKeyHashBackfill).toHaveBeenCalledOnce();
	});

	it('skips the walk if another instance hashed the rows while it waited', async () => {
		hasPendingDedupeKeyHashes.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

		await ensureDedupeKeyHashesBackfilled();

		expect(runDedupeKeyHashBackfill).not.toHaveBeenCalled();
	});
});
