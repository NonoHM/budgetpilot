import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY } from '$lib/server/logging/events';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

/**
 * #758's read-only boot report: rows written before the range existed.
 *
 * A fake whose ONLY methods are the six `count`s: any write, or a read of an id or a value, is a
 * TypeError the report's own guard would swallow into its « could not run » line, which the first
 * test below would then see instead of the counts. So the fake is the no-write assertion.
 *
 * Breaks, each separately: the log event carrying a value instead of a count (red on the
 * no-value assertion); the report run when every count is 0 (red on the silence test,
 * separating « silent on a clean install » from « a line on every boot »); a column dropped from
 * the list (red on the six-column assertion).
 */
const counts = vi.hoisted(() => ({ values: [0, 0, 0, 0, 0, 0] }));
const calls = vi.hoisted(() => ({ wheres: [] as Array<{ model: string; where: unknown }> }));

vi.mock('$lib/server/db', () => {
	const model = (name: string, index: number) => ({
		count: vi.fn(async ({ where }: { where: unknown }) => {
			calls.wheres.push({ model: name, where });
			return counts.values[index];
		})
	});
	return {
		prisma: {
			transaction: model('transaction', 0),
			importBatch: {
				count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
					calls.wheres.push({ model: 'importBatch', where });
					return 'periodStart' in where ? counts.values[1] : counts.values[2];
				})
			},
			savingsGoal: model('savingsGoal', 3),
			netWorthSnapshot: model('netWorthSnapshot', 4),
			recurringStreamAction: model('recurringStreamAction', 5)
		}
	};
});

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

const { reportDatesOutsideStorableRange } = await import('./storableDatesBoot');

beforeEach(() => {
	calls.wheres.length = 0;
	counts.values = [0, 0, 0, 0, 0, 0];
	logged.length = 0;
});

describe('reportDatesOutsideStorableRange', () => {
	it('counts six columns below the first storable day, and returns the counts', async () => {
		expect.assertions(2);
		counts.values = [3, 1, 0, 2, 0, 0];

		const result = await reportDatesOutsideStorableRange();

		expect(result).toEqual({
			'Transaction.date': 3,
			'ImportBatch.periodStart': 1,
			'ImportBatch.periodEnd': 0,
			'SavingsGoal.targetDate': 2,
			'NetWorthSnapshot.capturedAt': 0,
			'RecurringStreamAction.dueDate': 0
		});
		// Every count asks the same bound, the first storable day at midnight UTC.
		expect(
			calls.wheres.map(({ where }) => JSON.stringify(Object.values(where as object)[0]))
		).toEqual(Array(6).fill(JSON.stringify({ lt: new Date('1000-01-01T00:00:00.000Z') })));
	});

	it('logs one event of counts, saying nothing was changed, and no value', async () => {
		expect.assertions(3);
		counts.values = [3, 1, 0, 2, 0, 0];

		await reportDatesOutsideStorableRange();

		expect(logged).toEqual([
			{
				event: EVENT.datesOutsideStorableRange,
				attributes: {
					[ATTRIBUTE.datesTotal]: 6,
					[ATTRIBUTE.datesCounts]:
						'Transaction.date=3,ImportBatch.periodStart=1,SavingsGoal.targetDate=2',
					[ATTRIBUTE.datesFirstStorableYear]: 1000
				}
			}
		]);
		expect(REGISTRY[EVENT.datesOutsideStorableRange].body).toMatch(/Nothing was changed\./);
		expect(JSON.stringify(logged)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});

	it('is silent on an install with no such row', async () => {
		expect.assertions(1);
		await reportDatesOutsideStorableRange();
		expect(logged).toEqual([]);
	});
});
