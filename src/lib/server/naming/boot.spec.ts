import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

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

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

const { ensureNameKeysBackfilled } = await import('./boot');
const { logBackfillLockWait } = await import('$lib/server/logging');

const emptyReport = { users: [] };

beforeEach(() => {
	vi.clearAllMocks();
	logged.length = 0;
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

	it('runs the backfill inside the lock, never outside it, and logs its counts', async () => {
		hasPendingNameKeys.mockResolvedValue(true);
		// Four distinct figures, so an attribute carrying the wrong one cannot pass.
		const report = {
			dryRun: false,
			users: [{ keysWritten: { account: 3 }, accountMergesBlocked: [], netWorthCollisions: [] }],
			rowsDeleted: 2,
			transactionsReassigned: 5
		};
		let heldWhenRun = false;
		withBootBackfillLock.mockImplementation(async (_name, work) => {
			heldWhenRun = false;
			runNameKeyBackfill.mockImplementation(async () => {
				heldWhenRun = true;
				return report;
			});
			return await work();
		});

		await ensureNameKeysBackfilled();

		expect(withBootBackfillLock).toHaveBeenCalledWith('name-keys', expect.any(Function), {
			onWait: logBackfillLockWait
		});
		expect(heldWhenRun).toBe(true);
		expect(logged).toEqual([
			{ event: EVENT.backfillStarted, attributes: { [ATTRIBUTE.backfillName]: 'name_keys' } },
			{
				event: EVENT.backfillCompleted,
				attributes: {
					[ATTRIBUTE.backfillName]: 'name_keys',
					[ATTRIBUTE.backfillCount]: 3,
					[ATTRIBUTE.backfillUsers]: 1,
					[ATTRIBUTE.backfillRowsMerged]: 2,
					[ATTRIBUTE.backfillRepointed]: 5
				}
			}
		]);
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
