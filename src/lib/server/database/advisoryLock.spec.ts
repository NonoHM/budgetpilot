import { describe, expect, it, vi } from 'vitest';
import { mysqlLockName, postgresLockKeys, withBootBackfillLock } from './advisoryLock';

/**
 * A stand-in for the dedicated Prisma client the lock builds.
 *
 * Records the SQL of every call with its interpolated values, so a test can assert what was sent
 * without depending on a real engine. `answers` is consulted in order for the acquire polls.
 */
function fakeClient(answers: unknown[][] = [[{ locked: true }]]) {
	const calls: { sql: string; values: unknown[] }[] = [];
	let acquireCount = 0;

	const client = {
		$queryRaw: (template: TemplateStringsArray, ...values: unknown[]) => {
			const sql = template.join('?');
			calls.push({ sql, values });

			if (sql.includes('DATABASE()')) return Promise.resolve([{ name: 'budgetpilot' }]);
			if (sql.includes('pg_try_advisory_lock') || sql.includes('GET_LOCK')) {
				const answer = answers[Math.min(acquireCount, answers.length - 1)];
				acquireCount += 1;
				return Promise.resolve(answer);
			}
			return Promise.resolve([{ released: true }]);
		},
		$disconnect: vi.fn(() => Promise.resolve())
	};

	return { client, calls, disconnect: client.$disconnect };
}

const fast = { waitSeconds: 0.05, pollIntervalMs: 1 };

describe('withBootBackfillLock', () => {
	it('runs the work without touching the database on sqlite', async () => {
		const createClient = vi.fn();

		const result = await withBootBackfillLock('name-keys', async () => 'done', {
			env: { DATABASE_PROVIDER: 'sqlite' },
			createClient
		});

		expect(result).toBe('done');
		// SQLite admits one writer, so the lock has nothing to add and must not pay for a
		// second connection at every boot that has work to do.
		expect(createClient).not.toHaveBeenCalled();
	});

	it('takes, holds and releases a PostgreSQL advisory lock around the work', async () => {
		const { client, calls, disconnect } = fakeClient();
		const order: string[] = [];

		const result = await withBootBackfillLock(
			'name-keys',
			async () => {
				order.push('work');
				return 42;
			},
			{
				env: { DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://u:p@h:5432/b' },
				createClient: () => client as never,
				...fast
			}
		);

		expect(result).toBe(42);
		expect(calls[0].sql).toContain('pg_try_advisory_lock');
		expect(calls[0].values).toEqual(postgresLockKeys('name-keys'));
		expect(order).toEqual(['work']);
		expect(calls[1].sql).toContain('pg_advisory_unlock');
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it('keeps polling PostgreSQL until the other instance lets go', async () => {
		const { client, calls } = fakeClient([
			[{ locked: false }],
			[{ locked: false }],
			[{ locked: true }]
		]);

		await withBootBackfillLock('name-keys', async () => undefined, {
			env: { DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://u:p@h:5432/b' },
			createClient: () => client as never,
			waitSeconds: 60,
			pollIntervalMs: 1
		});

		expect(calls.filter((call) => call.sql.includes('pg_try_advisory_lock'))).toHaveLength(3);
	});

	it('raises rather than running unlocked when PostgreSQL never grants the lock', async () => {
		const { client, disconnect } = fakeClient([[{ locked: false }]]);
		const work = vi.fn();

		await expect(
			withBootBackfillLock('name-keys', work, {
				env: { DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://u:p@h:5432/b' },
				createClient: () => client as never,
				...fast
			})
		).rejects.toThrow(/startup lock/);

		// The whole point: a backfill that cannot be serialized must not run at all.
		expect(work).not.toHaveBeenCalled();
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it('asks MySQL for a lock named after the database it is connected to', async () => {
		const { client, calls } = fakeClient([[{ locked: 1 }]]);

		await withBootBackfillLock('dedupe-keys', async () => undefined, {
			env: { DATABASE_PROVIDER: 'mysql', DATABASE_URL: 'mysql://u:p@h:3306/b' },
			createClient: () => client as never,
			...fast
		});

		const acquire = calls.find((call) => call.sql.includes('GET_LOCK'));
		// GET_LOCK is scoped to the whole server, so two BudgetPilot databases on one MariaDB
		// must not queue behind each other.
		expect(acquire?.values[0]).toBe(mysqlLockName('budgetpilot', 'dedupe-keys'));
		expect(calls.some((call) => call.sql.includes('RELEASE_LOCK'))).toBe(true);
	});

	it('treats MySQL answering 0 as a timeout', async () => {
		const { client } = fakeClient([[{ locked: 0 }]]);
		const work = vi.fn();

		await expect(
			withBootBackfillLock('dedupe-keys', work, {
				env: { DATABASE_PROVIDER: 'mysql', DATABASE_URL: 'mysql://u:p@h:3306/b' },
				createClient: () => client as never,
				...fast
			})
		).rejects.toThrow(/startup lock/);
		expect(work).not.toHaveBeenCalled();
	});

	it('disconnects even when the work throws', async () => {
		const { client, disconnect } = fakeClient();

		await expect(
			withBootBackfillLock(
				'name-keys',
				async () => {
					throw new Error('backfill exploded');
				},
				{
					env: { DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://u:p@h:5432/b' },
					createClient: () => client as never,
					...fast
				}
			)
		).rejects.toThrow('backfill exploded');

		// Disconnecting is what actually ends the session holding the lock, so it can never be
		// skipped: a leaked lock would block every other instance for its full wait.
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it('keeps the lock connection busy for as long as the work runs', async () => {
		const { client, calls } = fakeClient();

		await withBootBackfillLock(
			'name-keys',
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
			},
			{
				env: { DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://u:p@h:5432/b' },
				createClient: () => client as never,
				...fast,
				keepAliveIntervalMs: 5
			}
		);

		// A lock nobody touches is a lock that goes away: pg's pool closes a connection idle for
		// ten seconds and PostgreSQL then drops every advisory lock that session held. Observed
		// on a real server, where the lock disappeared partway through the backfill it protected.
		expect(calls.filter((call) => call.sql.includes('SELECT 1')).length).toBeGreaterThan(0);
	});

	it('stops touching the connection once the work is done', async () => {
		const { client, calls } = fakeClient();

		await withBootBackfillLock('name-keys', async () => undefined, {
			env: { DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://u:p@h:5432/b' },
			createClient: () => client as never,
			...fast,
			keepAliveIntervalMs: 5
		});

		const afterWork = calls.filter((call) => call.sql.includes('SELECT 1')).length;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(calls.filter((call) => call.sql.includes('SELECT 1'))).toHaveLength(afterWork);
	});

	it('asks for a connection pinned to one session', async () => {
		const { client } = fakeClient();
		const createClient = vi.fn(() => client as never);

		await withBootBackfillLock('name-keys', async () => undefined, {
			env: { DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://u:p@h:5432/b' },
			createClient,
			...fast
		});

		// Without this the pool reaps the idle connection and the lock goes with it.
		expect(createClient).toHaveBeenCalledWith(expect.anything(), { singleConnection: true });
	});

	it('still disconnects when the release query fails', async () => {
		const disconnect = vi.fn(() => Promise.resolve());
		const client = {
			$queryRaw: (template: TemplateStringsArray) => {
				const sql = template.join('?');
				if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ locked: true }]);
				return Promise.reject(new Error('connection reset'));
			},
			$disconnect: disconnect
		};

		await expect(
			withBootBackfillLock('name-keys', async () => 'ok', {
				env: { DATABASE_PROVIDER: 'postgresql', DATABASE_URL: 'postgresql://u:p@h:5432/b' },
				createClient: () => client as never,
				...fast
			})
		).resolves.toBe('ok');
		expect(disconnect).toHaveBeenCalledOnce();
	});
});

describe('lock names', () => {
	it('derives two int32 PostgreSQL keys, stable per name and different across names', () => {
		const [high, low] = postgresLockKeys('name-keys');

		expect(Number.isInteger(high) && Number.isInteger(low)).toBe(true);
		expect(high).toBeGreaterThanOrEqual(-(2 ** 31));
		expect(low).toBeLessThanOrEqual(2 ** 31 - 1);
		expect(postgresLockKeys('name-keys')).toEqual([high, low]);
		expect(postgresLockKeys('dedupe-keys')).not.toEqual([high, low]);
	});

	it('keeps the MySQL lock name inside the 64-character limit whatever the database is called', () => {
		const long = mysqlLockName('a'.repeat(500), 'name-keys');

		expect(long.length).toBeLessThanOrEqual(64);
		// Truncating an assembled "budgetpilot:<database>:<lock>" would merge two locks that
		// have to stay apart; hashing keeps them distinct at any length.
		expect(long).not.toBe(mysqlLockName('a'.repeat(499), 'name-keys'));
		expect(mysqlLockName('budgetpilot', 'name-keys')).not.toBe(
			mysqlLockName('budgetpilot', 'dedupe-keys')
		);
	});
});
