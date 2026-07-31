import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What this file is about: the backfill runs under the lock, and it re-asks whether there is
 * anything to do once it holds it.
 *
 * That second check is the whole reason two application instances can share a database. Without
 * it the instance that waited its turn would go on to apply a plan the winner has already
 * applied, which is the race the lock was added to remove rather than to reorder.
 */

const hasPendingNameKeys = vi.fn();
const runNameKeyBackfill = vi.fn();
const withBootBackfillLock = vi.fn(
	async (_name: string, work: () => Promise<unknown>) => await work()
);

vi.mock('$lib/server/db', () => ({ prisma: {} }));
vi.mock('./backfill.ts', () => ({ hasPendingNameKeys, runNameKeyBackfill }));
vi.mock('$lib/server/database/advisoryLock', () => ({ withBootBackfillLock }));

const { ensureNameKeysBackfilled } = await import('./boot');

const emptyReport = { users: [] };

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	withBootBackfillLock.mockImplementation(async (_name, work) => await work());
	runNameKeyBackfill.mockResolvedValue(emptyReport);
});

describe('ensureNameKeysBackfilled', () => {
	it('takes no lock at all when nothing is pending', async () => {
		hasPendingNameKeys.mockResolvedValue(false);

		await ensureNameKeysBackfilled();

		// The common case is every boot of an already-migrated database, which must not pay for
		// a second connection just to learn there is nothing to do.
		expect(withBootBackfillLock).not.toHaveBeenCalled();
		expect(runNameKeyBackfill).not.toHaveBeenCalled();
	});

	it('runs the backfill inside the lock, never outside it', async () => {
		hasPendingNameKeys.mockResolvedValue(true);
		let heldWhenRun = false;
		withBootBackfillLock.mockImplementation(async (_name, work) => {
			heldWhenRun = false;
			runNameKeyBackfill.mockImplementation(async () => {
				heldWhenRun = true;
				return emptyReport;
			});
			return await work();
		});

		await ensureNameKeysBackfilled();

		expect(withBootBackfillLock).toHaveBeenCalledWith('name-keys', expect.any(Function));
		expect(heldWhenRun).toBe(true);
	});

	it('does nothing once inside the lock if another instance finished first', async () => {
		// Pending before the wait, no longer pending after it: exactly what the loser of the
		// race sees.
		hasPendingNameKeys.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

		await ensureNameKeysBackfilled();

		expect(withBootBackfillLock).toHaveBeenCalledOnce();
		expect(runNameKeyBackfill).not.toHaveBeenCalled();
	});
});
