import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { resolveDatabaseProvider } from '$lib/server/database/provider';

/**
 * A write the app reported as saved stays saved, even when somebody else's transaction is open
 * at the time and then rolls back (#889).
 *
 * On SQLite it did not. `@prisma/adapter-better-sqlite3` runs every query on ONE connection and
 * only `startTransaction` takes its mutex, so a plain query issued while an interactive
 * transaction was open ran INSIDE it and was undone by its rollback. First measurement, before
 * the fix, with the probe in the first describe block below:
 *
 * | Engine        | outside write finished while open | inside rolled back | outside survived |
 * | ------------- | --------------------------------- | ------------------ | ---------------- |
 * | SQLite        | yes                               | yes                | NO               |
 * | PostgreSQL 17 | yes                               | yes                | yes              |
 * | MariaDB 11    | yes                               | yes                | yes              |
 *
 * PostgreSQL and MariaDB are the CALIBRATION: they prove this probe can read « survived » when
 * the engine isolates the two callers, so a red on SQLite is about the engine and not the probe.
 * The fix is `serializedSqliteAdapter.ts`; its own spec carries the same property against the real
 * driver in the unit suite, because CI's db-matrix runs this file on PostgreSQL and MariaDB only.
 *
 * Users are the isolation boundary between tests, and each scenario touches a column nothing
 * else in the app reads (`aiIncludeLabels`, default false) on rows it created.
 *
 * See vitest.db.config.ts for how to run it.
 */

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a ' +
			'server engine) to a throwaway database explicitly. It refuses to fall back to the ' +
			'default local SQLite file.'
	);
}
if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const provider = resolveDatabaseProvider(process.env);
const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `tx-isolation-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	return user.id;
}

async function flag(userId: string): Promise<boolean> {
	const row = await prisma.user.findUniqueOrThrow({
		where: { id: userId },
		select: { aiIncludeLabels: true }
	});
	return row.aiIncludeLabels;
}

/** Rejects with a named reason if `work` has not settled within `ms`, instead of hanging. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * How long the transaction stays open waiting for the outside caller. Long enough that an outside
 * query which is NOT held back finishes well inside it on every engine (they take single-digit
 * milliseconds here), short enough to keep the suite quick. A held-back query does not finish
 * inside it, and that is the point: the transaction then gives up waiting and rolls back.
 */
const OPEN_WINDOW_MS = 500;

/**
 * Opens a transaction that writes `insideUserId`, runs `outside` against the plain client while
 * it is open, then throws so the transaction rolls back. The outside caller is never awaited by
 * the transaction: it gets `OPEN_WINDOW_MS` to finish, so an engine that makes it WAIT cannot
 * deadlock the probe.
 */
async function runBesideRollback<T>(
	insideUserId: string,
	outside: () => Promise<T>
): Promise<{ outsideFinishedWhileOpen: boolean; outsideResult: T; transactionRejected: boolean }> {
	let markInsideWritten!: () => void;
	const insideWritten = new Promise<void>((resolve) => (markInsideWritten = resolve));
	let open = false;
	let outsideFinished = false;
	let outsideFinishedWhileOpen = false;

	const outsideRun = (async () => {
		await insideWritten;
		const result = await outside();
		outsideFinished = true;
		outsideFinishedWhileOpen = open;
		return result;
	})();

	const transactionRejected = await prisma
		.$transaction(
			async (tx) => {
				open = true;
				await tx.user.update({ where: { id: insideUserId }, data: { aiIncludeLabels: true } });
				markInsideWritten();
				const start = Date.now();
				while (!outsideFinished && Date.now() - start < OPEN_WINDOW_MS) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				open = false;
				throw new Error('rollback on purpose');
			},
			{ timeout: 10_000 }
		)
		.then(
			() => false,
			(error: unknown) => error instanceof Error && error.message === 'rollback on purpose'
		);

	const outsideResult = await within(10_000, 'the outside caller', outsideRun);
	return { outsideFinishedWhileOpen, outsideResult, transactionRejected };
}

afterAll(async () => {
	await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe('a write made outside an open transaction, which then rolls back', () => {
	let figures: {
		outsideFinishedWhileOpen: boolean;
		transactionRejected: boolean;
		insideRolledBack: boolean;
		outsideSurvived: boolean;
	};

	// One run, several figures, each asserted in its own test: an assertion placed after another is
	// never evaluated while the first is red, so the figures are split rather than chained.
	beforeAll(async () => {
		const insideUserId = await createUser();
		const outsideUserId = await createUser();

		const run = await runBesideRollback(insideUserId, () =>
			prisma.user.update({ where: { id: outsideUserId }, data: { aiIncludeLabels: true } })
		);

		figures = {
			outsideFinishedWhileOpen: run.outsideFinishedWhileOpen,
			transactionRejected: run.transactionRejected,
			insideRolledBack: (await flag(insideUserId)) === false,
			outsideSurvived: (await flag(outsideUserId)) === true
		};
	});

	it('rolled the transaction back, so the probe measured a rollback at all', () => {
		expect.assertions(2);

		// The precondition for the figure below: without a rollback, « survived » is trivially true.
		expect(figures.transactionRejected).toBe(true);
		expect(figures.insideRolledBack).toBe(true);
	});

	it('keeps the outside write after the rollback, on every engine', () => {
		expect.assertions(1);

		// THE property of #889. Separates « the outside write ran beside the transaction » from
		// « it ran inside it and was undone ». Red on SQLite without serializedSqliteAdapter.ts.
		expect(figures.outsideSurvived).toBe(true);
	});

	it('makes the outside write wait on SQLite, and nowhere else', () => {
		expect.assertions(1);

		// The mechanism, stated per engine because it differs. SQLite has one connection, so the
		// only way to keep the write out of the transaction is to hold it until the transaction
		// ends. PostgreSQL and MariaDB give it its own connection and a different row, so it does
		// not wait there.
		expect(figures.outsideFinishedWhileOpen).toBe(provider !== 'sqlite');
	});
});

describe('a read made outside an open transaction', () => {
	it('never sees that transaction’s uncommitted write', async () => {
		expect.assertions(1);

		// Separates a dirty read (the read ran inside the transaction, so it saw `true`, a value
		// that was then rolled back and never existed) from an isolated one. Red on SQLite without
		// serializedSqliteAdapter.ts.
		const insideUserId = await createUser();
		const run = await runBesideRollback(insideUserId, () => flag(insideUserId));

		expect(run.outsideResult).toBe(false);
	});
});

describe('a batch transaction built on the plain client', () => {
	it('completes, with both writes, rather than waiting on the lock it is built beside', async () => {
		expect.assertions(1);

		// The shape `deleteImportBatch` and the category delete use: the elements are built on the
		// global client, not on a `tx`. Prisma runs them on the transaction it opens, so they must
		// not queue behind that transaction's own hold. Bounded so a deadlock reads as a reason.
		const first = await createUser();
		const second = await createUser();

		await within(
			5_000,
			'the batch transaction',
			prisma.$transaction([
				prisma.user.update({ where: { id: first }, data: { aiIncludeLabels: true } }),
				prisma.user.update({ where: { id: second }, data: { aiIncludeLabels: true } })
			])
		);

		expect([await flag(first), await flag(second)]).toEqual([true, true]);
	});
});

describe('the global client used INSIDE a transaction callback', () => {
	/**
	 * The one shape the fix could make worse, so it is measured rather than argued. No production
	 * callback does this (a sweep of every `$transaction(` site found none), but a future one could.
	 * On SQLite the global query waits for the transaction that is waiting for it. Prisma's own
	 * interactive-transaction timeout then rolls the transaction back, which releases the hold, and
	 * the caller gets the timeout error. It fails loudly at the timeout; it does not hang.
	 */
	const TIMEOUT_MS = 1_000;
	let outcome: {
		rejectedWith: string | null;
		elapsedMs: number;
		insideRolledBack: boolean;
		globalWriteLanded: boolean;
	};

	beforeAll(async () => {
		const insideUserId = await createUser();
		const globalUserId = await createUser();
		const start = Date.now();

		const rejectedWith = await within(
			TIMEOUT_MS + 10_000,
			'the transaction using the global client',
			prisma.$transaction(
				async (tx) => {
					await tx.user.update({ where: { id: insideUserId }, data: { aiIncludeLabels: true } });
					await prisma.user.update({
						where: { id: globalUserId },
						data: { aiIncludeLabels: true }
					});
				},
				{ timeout: TIMEOUT_MS }
			)
		).then(
			() => null,
			(error: unknown) => (error instanceof Error ? error.message : String(error))
		);

		outcome = {
			rejectedWith,
			elapsedMs: Date.now() - start,
			insideRolledBack: (await flag(insideUserId)) === false,
			globalWriteLanded: (await flag(globalUserId)) === true
		};
	});

	it('fails with the transaction timeout on SQLite, and commits elsewhere', () => {
		expect.assertions(1);

		if (provider === 'sqlite') {
			expect(outcome.rejectedWith).toMatch(/expired transaction/);
		} else {
			expect(outcome.rejectedWith).toBeNull();
		}
	});

	it('settles no later than the timeout plus a bounded margin', () => {
		expect.assertions(1);

		// Measured on SQLite with the fix: the rejection arrives just after TIMEOUT_MS. The margin
		// is generous on purpose; what it separates is « fails at the timeout » from « hangs ».
		expect(outcome.elapsedMs).toBeLessThan(TIMEOUT_MS + 2_000);
	});

	it('rolls the inside write back on SQLite, where the transaction timed out', () => {
		expect.assertions(1);

		expect(outcome.insideRolledBack).toBe(provider === 'sqlite');
	});

	it('lets the global write land on every engine, as its own statement', () => {
		expect.assertions(1);

		// After the timeout's rollback releases the hold, the waiting global write runs outside any
		// transaction and commits, which is what PostgreSQL and MariaDB do with it from the start.
		expect(outcome.globalWriteLanded).toBe(true);
	});
});
