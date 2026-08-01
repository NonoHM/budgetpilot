import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '$lib/server/db';
import { resolveDatabaseProvider } from '$lib/server/database/provider';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { computeInertActionCutoff, recordStreamAction } from '$lib/server/upcoming-bills/service';

/**
 * What this file proves, and why the unit tests structurally cannot.
 *
 * `service.spec.ts` executes the prune's `where` through `applyPruneWhere`, a hand-written filter
 * that models what the clause is INTENDED to mean — including the one semantic that matters most,
 * that a NULL `dueDate` satisfies no comparison. Modelling it is not the same as observing it. If
 * the clause were ever refactored to `not: { gte }`, the emitted SQL would include NULL rows on
 * some connectors while the hand-written mock, updated to match the new shape, went on returning
 * green. What the clause MEANS to the engine is a question only the engine answers.
 *
 * The exact-boundary row is the second reason. `dueDate` at UTC midnight exactly on the cutoff must
 * SURVIVE (the predicate is a strict `lt`), and whether it does depends on a full round trip
 * through `datetime(3)` / integer milliseconds / `timestamptz` — three storage representations with
 * three rounding behaviours. A row that came back a millisecond early would be silently deleted,
 * and that row is a live decision.
 *
 * Nothing here is a claim about a defect. The `kind` conjunct alone protects EXCLUDE on every shape
 * a row can take (see `service.ts` for why the date bound covers only a subset), and an IGNORE with
 * a NULL `dueDate` is provably inert. This asserts the guarantees hold against a real engine.
 *
 * See vitest.db.config.ts for how to run it.
 */

// Same refusal as crossProvider.db-smoke.ts, for the same reason: the app's client falls back to
// `file:./dev.db`, a developer's real local database, and this suite deletes rows.
if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly. It refuses to fall back to the default local ' +
			'SQLite file.'
	);
}

if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const provider = resolveDatabaseProvider(process.env);
const MS_PER_DAY = 86_400_000;

const createdUserIds: string[] = [];

async function freshUser(): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `prune-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	return user.id;
}

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
	await prisma.$disconnect();
});

describe(`upcoming-bills inert-decision prune (${provider})`, () => {
	let userId: string;
	let otherUserId: string;
	/** A transaction this user owns, so `recordStreamAction` accepts the anchor it is given. */
	let anchorId: string;
	let cutoff: Date;

	/**
	 * Per-test prefix on every seeded id. `id` is the table's primary key, so the readable names
	 * below would collide between tests on the second run of the file — and did, with a P2002 the
	 * first time this ran against a real engine.
	 */
	let idPrefix: string;

	/** Seeds one decision. Names are chosen so the assertions below read as a set. */
	async function seedAction(
		name: string,
		ownerId: string,
		kind: 'IGNORE' | 'PAID' | 'EXCLUDE',
		dueDate: Date | null
	) {
		await prisma.recurringStreamAction.create({
			data: {
				id: `${idPrefix}${name}`,
				userId: ownerId,
				kind,
				direction: 'expense',
				// Deliberately unrelated to the label the write path below uses, so the idempotence check
				// in `recordStreamAction` cannot match one of these and return before pruning.
				normalizedLabel: `seeded ${name}`,
				label: `SEEDED ${name}`,
				anchorTransactionIds: JSON.stringify([`seeded-anchor-${name}`]),
				dueDate
			}
		});
	}

	/** Surviving SEEDED rows, by name; rows created by the write path itself are excluded. */
	async function survivingNames(ownerId: string): Promise<string[]> {
		const rows = await prisma.recurringStreamAction.findMany({
			where: { userId: ownerId },
			select: { id: true },
			orderBy: { id: 'asc' }
		});
		return rows
			.filter((row) => row.id.startsWith(idPrefix))
			.map((row) => row.id.slice(idPrefix.length));
	}

	async function totalActions(ownerId: string): Promise<number> {
		return prisma.recurringStreamAction.count({ where: { userId: ownerId } });
	}

	beforeEach(async () => {
		// Freezes only `Date`, not `setTimeout`/`setInterval` — this suite makes real network calls to
		// the database and those still need real timers. `recordStreamAction` computes its own `now`
		// internally (no way to inject one) and this file computes `cutoff` from a separate `new
		// Date()` call; on the handful of days a year where the lookback subtraction crosses a UTC
		// month boundary between the two calls, `computeInertActionCutoff` returns a cutoff a month
		// apart for each, which fails the exact-boundary assertion below. Pinning `now` here makes both
		// calls read the same instant.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date());

		userId = await freshUser();
		otherUserId = await freshUser();
		cutoff = computeInertActionCutoff(new Date());
		idPrefix = `${crypto.randomUUID()}:`;

		const account = await prisma.account.create({
			data: {
				userId,
				name: 'Compte courant',
				nameKey: computeNameKey('Compte courant'),
				source: 'csv'
			},
			select: { id: true }
		});
		const category = await prisma.category.create({
			data: { userId, name: 'Abonnements', nameKey: computeNameKey('Abonnements') },
			select: { id: true }
		});
		const transaction = await prisma.transaction.create({
			data: {
				userId,
				accountId: account.id,
				categoryId: category.id,
				date: new Date(),
				label: 'CB ABONNEMENT NETFLIX 0712',
				amountCents: -1399,
				type: 'expense',
				source: 'csv'
			},
			select: { id: true }
		});
		anchorId = transaction.id;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('deletes exactly the inert ignore/paid rows and nothing else', async () => {
		await seedAction('old-ignore', userId, 'IGNORE', new Date(cutoff.getTime() - MS_PER_DAY));
		await seedAction('old-paid', userId, 'PAID', new Date(cutoff.getTime() - 30 * MS_PER_DAY));
		// The write path's own shape of an exclusion.
		await seedAction('exclude-null', userId, 'EXCLUDE', null);
		// The shape only `backup/import.ts` can produce: an exclusion carrying a stale due date. It is
		// a fully live exclusion, and the `kind` conjunct is the only thing keeping it.
		await seedAction(
			'exclude-dated',
			userId,
			'EXCLUDE',
			new Date(cutoff.getTime() - 365 * MS_PER_DAY)
		);
		// Exactly AT the cutoff. The predicate is a strict `lt`, so this row is one whose occurrence
		// can still be exactly the first renderable one — it must survive, and only a real round trip
		// through the column's storage type can settle it.
		await seedAction('at-cutoff', userId, 'IGNORE', new Date(cutoff.getTime()));
		await seedAction('live-ignore', userId, 'IGNORE', new Date());
		// Unreachable through the app, inert, and deliberately NOT swept.
		await seedAction('null-ignore', userId, 'IGNORE', null);
		await seedAction('other-user', otherUserId, 'IGNORE', new Date(cutoff.getTime() - MS_PER_DAY));

		await recordStreamAction(userId, {
			kind: 'ignore',
			direction: 'expense',
			label: 'CB ABONNEMENT NETFLIX 0712',
			dueDate: new Date().toISOString().slice(0, 10),
			anchorTransactionIds: [anchorId]
		});

		expect(await survivingNames(userId)).toEqual([
			'at-cutoff',
			'exclude-dated',
			'exclude-null',
			'live-ignore',
			'null-ignore'
		]);
		// Five survivors plus the row the call itself created.
		expect(await totalActions(userId)).toBe(6);

		// The prune is userId-scoped, and this is the engine confirming it rather than a mock.
		expect(await survivingNames(otherUserId)).toEqual(['other-user']);
	});

	it('leaves every exclusion in place even when the write path is exercised repeatedly', async () => {
		await seedAction('exclude-null', userId, 'EXCLUDE', null);
		await seedAction('exclude-dated', userId, 'EXCLUDE', new Date(cutoff.getTime() - MS_PER_DAY));

		for (const day of ['-01', '-02', '-03']) {
			await recordStreamAction(userId, {
				kind: 'ignore',
				direction: 'expense',
				label: `CB ABONNEMENT NETFLIX 0712${day}`,
				dueDate: `${new Date().toISOString().slice(0, 7)}${day}`,
				anchorTransactionIds: [anchorId]
			});
		}

		expect(await survivingNames(userId)).toEqual(['exclude-dated', 'exclude-null']);
	});
});
