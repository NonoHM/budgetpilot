import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { buildBackupExport } from '$lib/server/backup/export';
import { restoreBackup } from '$lib/server/backup/import';
import type { BackupExport } from '$lib/server/backup/schema';
import { contestedNetWorthLines } from '$lib/domain/netWorthLink';
import { hasContestedNetWorthLines, repairContestedNetWorthLinks } from './contestedRepair';

/**
 * THE HALF A WRITE-PATH FIX CANNOT REACH: installs that already carry a contested line.
 *
 * #501's rule now refuses the second synchronized bucket at every door, and that does nothing for a
 * database where both links are already written. `contestedRepair.ts` withdraws them at boot,
 * through the SAME `domain/netWorthLink` call the doors use, so the repair and the refusal cannot
 * disagree about what a contest is.
 *
 * ## Why this file exists rather than a data migration, which is what #505 shipped
 *
 * Two reasons, and the second is the one that decides it.
 *
 * A migration would be D4 restated in SQL, once per provider, with MySQL needing a derived table
 * where PostgreSQL and SQLite take a correlated subquery. Three hand-written statements of one rule
 * about money is the divergence #501 was, arriving in the fix for it.
 *
 * And NO CI JOB APPLIES A MIGRATION TO A DATABASE THAT ALREADY HOLDS ROWS. Both db-matrix legs and
 * `sqlite-migrations` are fresh installs, so #505's migration could only be verified by hand, per
 * engine, once, and nothing re-runs it. This file runs on every push against all three engines. The
 * difference is between a repair that IS tested and a repair that WAS tested.
 *
 * ## The fixture is written directly, and it has to be
 *
 * No door produces a contested line any more, which is the whole point of the change. So the rows
 * are created through Prisma rather than through a production function, and this file says so
 * rather than dressing it up: what it measures is a REPAIR of a state, and the state's provenance
 * is 0.14.1's /settings door, which no longer exists to be called.
 */

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

let userId: string;

beforeEach(async () => {
	// Every row this file can see is created by it, and the repair is deliberately NOT scoped by
	// user, so a leftover contested row from another suite would be repaired here and counted. The
	// assertions below therefore name the rows they expect rather than totals across the database.
	const user = await prisma.user.create({
		data: {
			email: `d4-repair-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
});

async function makeNetWorthAccount(name: string): Promise<string> {
	const account = await prisma.netWorthAccount.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			name,
			nameKey: computeNameKey(name),
			type: 'checking',
			balanceCents: 100_000n
		},
		select: { id: true }
	});
	return account.id;
}

async function makeConnection(): Promise<string> {
	const connection = await prisma.bankConnection.create({
		data: { userId, provider: 'mock', aspspName: 'Banque Imaginaire', status: 'active' },
		select: { id: true }
	});
	return connection.id;
}

/** A bucket as 0.14.1 could leave one: synchronized, and already pointing at a line. */
async function makeSyncedBucket(input: {
	connectionId: string;
	name: string;
	netWorthAccountId: string | null;
}): Promise<string> {
	const bucket = await prisma.account.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			name: input.name,
			nameKey: computeNameKey(input.name),
			source: 'mock_connector',
			bankConnectionId: input.connectionId,
			providerAccountId: `provider-${crypto.randomUUID()}`,
			netWorthAccountId: input.netWorthAccountId
		},
		select: { id: true }
	});
	return bucket.id;
}

async function makeCsvBucket(name: string, netWorthAccountId: string | null): Promise<string> {
	const bucket = await prisma.account.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			name,
			nameKey: computeNameKey(name),
			source: 'csv',
			netWorthAccountId
		},
		select: { id: true }
	});
	return bucket.id;
}

async function linkOf(accountId: string): Promise<string | null> {
	const row = await prisma.account.findUniqueOrThrow({
		where: { id: accountId },
		select: { netWorthAccountId: true }
	});
	return row.netWorthAccountId;
}

describe('withdrawing net worth links that more than one synchronized bucket holds', () => {
	/**
	 * THE CALIBRATION, and it runs first. Every other assertion in this file is about a repair
	 * happening; this one is about the repair NOT happening, and without it a function that cleared
	 * every link in the database unconditionally would pass all of them.
	 *
	 * SEPARATES: « the repair reads the rule » FROM « the repair clears bank links ».
	 */
	it('leaves a line one synchronized bucket feeds exactly alone', async () => {
		expect.assertions(4);

		const line = await makeNetWorthAccount('Compte courant fictif');
		const connectionId = await makeConnection();
		const synced = await makeSyncedBucket({ connectionId, name: 'Courant', netWorthAccountId: line });
		// A CSV bucket on the same line is D4's own carve-out: it never writes a balance snapshot, so
		// it is not a second claimant and must survive.
		const csv = await makeCsvBucket('Relevés', line);

		expect(await hasContestedNetWorthLines(prisma)).toBe(false);
		const report = await repairContestedNetWorthLinks(prisma);
		expect(report).toEqual({ linesContested: 0, cleared: 0 });
		expect(await linkOf(synced)).toBe(line);
		expect(await linkOf(csv)).toBe(line);
	});

	/**
	 * THE REPAIR. Two synchronized buckets of ONE connection on one line, which is the state #501
	 * measured and needs no second bank to reach.
	 *
	 * SEPARATES: « both claims are withdrawn » FROM « one is kept ». Both, deliberately: nothing in
	 * the data says which bucket the user meant, so keeping one would leave the line showing a
	 * plausible balance from an arbitrary account with nothing on any screen able to say so. A line
	 * that is visibly unfed is the failure a user can see and correct.
	 */
	it('withdraws every claim on a contested line, and reports what it did', async () => {
		expect.assertions(5);

		const line = await makeNetWorthAccount('Livret fictif');
		const connectionId = await makeConnection();
		const courant = await makeSyncedBucket({
			connectionId,
			name: 'Courant',
			netWorthAccountId: line
		});
		const livret = await makeSyncedBucket({ connectionId, name: 'Livret', netWorthAccountId: line });

		expect(await hasContestedNetWorthLines(prisma)).toBe(true);
		const report = await repairContestedNetWorthLinks(prisma);
		expect(report.linesContested).toBeGreaterThanOrEqual(1);
		expect(report.cleared).toBeGreaterThanOrEqual(2);
		expect(await linkOf(courant)).toBeNull();
		expect(await linkOf(livret)).toBeNull();
	});

	/**
	 * SEPARATES: « the repair is scoped to the contested line » FROM « the repair clears links ».
	 * Two lines in one database, one contested and one not, read in the same pass: a repair that
	 * cleared both would satisfy the test above and fail here.
	 */
	it('leaves an uncontested line untouched in the same pass', async () => {
		expect.assertions(4);

		const contested = await makeNetWorthAccount('Livret contesté');
		const healthy = await makeNetWorthAccount('Compte courant sain');
		const connectionId = await makeConnection();
		const a = await makeSyncedBucket({ connectionId, name: 'A', netWorthAccountId: contested });
		const b = await makeSyncedBucket({ connectionId, name: 'B', netWorthAccountId: contested });
		const c = await makeSyncedBucket({ connectionId, name: 'C', netWorthAccountId: healthy });

		await repairContestedNetWorthLinks(prisma);

		expect(await linkOf(a)).toBeNull();
		expect(await linkOf(b)).toBeNull();
		expect(await linkOf(c)).toBe(healthy);
		expect(await hasContestedNetWorthLines(prisma)).toBe(false);
	});

	/**
	 * SEPARATES: « the repair deletes nothing » FROM « the repair removes the bucket ». The whole
	 * point of a link column is that losing the link must never cost the rows behind it, and this
	 * repository has one measured instance of a bank column being `SetNull` precisely so a
	 * disconnect cannot delete transactions.
	 */
	it('deletes no bucket, no transaction and no net worth account', async () => {
		expect.assertions(4);

		const line = await makeNetWorthAccount('Livret fictif');
		const connectionId = await makeConnection();
		const first = await makeSyncedBucket({ connectionId, name: 'A', netWorthAccountId: line });
		const second = await makeSyncedBucket({ connectionId, name: 'B', netWorthAccountId: line });
		const category = await prisma.category.create({
			data: { userId, name: 'Divers', nameKey: computeNameKey('Divers') },
			select: { id: true }
		});
		await prisma.transaction.create({
			data: {
				...DEFAULT_DENOMINATION,
				user: { connect: { id: userId } },
				account: { connect: { id: first } },
				category: { connect: { id: category.id } },
				date: new Date('2026-07-12T00:00:00.000Z'),
				label: 'ABONNEMENT ZORGLUB',
				amountCents: -1990,
				type: 'expense',
				source: 'mock_connector'
			}
		});

		await repairContestedNetWorthLinks(prisma);

		expect(await prisma.account.count({ where: { id: { in: [first, second] } } })).toBe(2);
		expect(await prisma.transaction.count({ where: { accountId: first } })).toBe(1);
		expect(await prisma.netWorthAccount.count({ where: { id: line } })).toBe(1);
		expect(await prisma.bankConnection.count({ where: { id: connectionId } })).toBe(1);
	});

	/**
	 * IDEMPOTENCE, ASSERTED RATHER THAN DESCRIBED, and it is what `contestedBoot.ts` claims when it
	 * says a second instance redoes no work.
	 *
	 * SEPARATES: « a second pass finds nothing » FROM « a second pass is harmless ». The figure is
	 * the point: `cleared: 0` is a stronger statement than "no error", and it is the one that makes
	 * two application instances sharing a database safe rather than merely lucky.
	 */
	it('is a no-op on the second pass, which is what a boot check is allowed to assume', async () => {
		expect.assertions(3);

		const line = await makeNetWorthAccount('Livret fictif');
		const connectionId = await makeConnection();
		await makeSyncedBucket({ connectionId, name: 'A', netWorthAccountId: line });
		await makeSyncedBucket({ connectionId, name: 'B', netWorthAccountId: line });

		const first = await repairContestedNetWorthLinks(prisma);
		expect(first.cleared).toBeGreaterThanOrEqual(2);

		const second = await repairContestedNetWorthLinks(prisma);
		expect(second).toEqual({ linesContested: 0, cleared: 0 });
		expect(await hasContestedNetWorthLines(prisma)).toBe(false);
	});

	/**
	 * THE CROSS-TENANT CASE, which is the one the repair's unscoped read exists for.
	 *
	 * SEPARATES: « a line is one line whoever points at it » FROM « a contest is counted per user ».
	 * Partitioning by tenant would report no contest here and leave a foreign bank's balance being
	 * written into this user's net worth on every sync. No path produces this state, which is
	 * exactly why nothing would notice it.
	 */
	it('withdraws a foreign tenant claim on a line, which a per-user count would miss', async () => {
		expect.assertions(3);

		const line = await makeNetWorthAccount('Mon livret');
		const mine = await makeSyncedBucket({
			connectionId: await makeConnection(),
			name: 'Le mien',
			netWorthAccountId: line
		});
		const otherUser = await prisma.user.create({
			data: {
				email: `d4-repair-other-${crypto.randomUUID()}@budgetpilot.invalid`,
				passwordHash: 'db-smoke-not-a-real-hash'
			},
			select: { id: true }
		});
		const theirConnection = await prisma.bankConnection.create({
			data: { userId: otherUser.id, provider: 'mock', aspspName: 'Autre', status: 'active' },
			select: { id: true }
		});
		const theirs = await prisma.account.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: otherUser.id,
				name: 'Intrus',
				nameKey: computeNameKey('Intrus'),
				source: 'mock_connector',
				bankConnectionId: theirConnection.id,
				providerAccountId: `provider-${crypto.randomUUID()}`,
				netWorthAccountId: line
			},
			select: { id: true }
		});

		expect(await hasContestedNetWorthLines(prisma)).toBe(true);
		await repairContestedNetWorthLinks(prisma);
		expect(await linkOf(mine)).toBeNull();
		expect(await linkOf(theirs.id)).toBeNull();
	});
});

/**
 * THE THIRD SITE, AND IT IS THE ONE THE ENFORCEMENT RULE SAYS IS HABITUALLY MISSED.
 *
 * An invariant enforced on "the" write path is only enforced if every path is that one, and RESTORE
 * habitually is not. A backup taken before #501 carries a line fed by two synchronized buckets: the
 * code fix cannot reach a file, and the boot repair runs at startup rather than after a restore, so
 * without this the state comes straight back on the next import of the user's own export.
 *
 * `backup/import.ts` calls the SAME `accountsToUnlinkForContest` the boot repair calls, so what
 * counts as a contest cannot differ between them.
 */
describe('a restore does not reintroduce a contested line', () => {
	/**
	 * SEPARATES: « the restore applies the rule » FROM « the restore copies the file ». The source
	 * user is left in the pre-fix state deliberately, so the payload really carries two synchronized
	 * buckets on one line rather than a file somebody hoped carried one.
	 */
	it('withdraws both claims while restoring everything else', async () => {
		const source = await prisma.user.create({
			data: {
				email: `d4-restore-src-${crypto.randomUUID()}@budgetpilot.invalid`,
				passwordHash: 'db-smoke-not-a-real-hash'
			},
			select: { id: true }
		});
		const target = await prisma.user.create({
			data: {
				email: `d4-restore-dst-${crypto.randomUUID()}@budgetpilot.invalid`,
				passwordHash: 'db-smoke-not-a-real-hash'
			},
			select: { id: true }
		});

		const line = await prisma.netWorthAccount.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: source.id,
				name: 'Livret contesté',
				nameKey: computeNameKey('Livret contesté'),
				type: 'checking',
				balanceCents: 100_000n
			},
			select: { id: true }
		});
		const healthy = await prisma.netWorthAccount.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: source.id,
				name: 'Compte sain',
				nameKey: computeNameKey('Compte sain'),
				type: 'checking',
				balanceCents: 50_000n
			},
			select: { id: true }
		});
		const connection = await prisma.bankConnection.create({
			data: { userId: source.id, provider: 'mock', aspspName: 'Banque', status: 'active' },
			select: { id: true }
		});
		for (const name of ['Courant', 'Livret']) {
			await prisma.account.create({
				data: {
					...DEFAULT_DENOMINATION,
					userId: source.id,
					name,
					nameKey: computeNameKey(name),
					source: 'mock_connector',
					bankConnectionId: connection.id,
					providerAccountId: `provider-${crypto.randomUUID()}`,
					netWorthAccountId: line.id
				}
			});
		}
		// The control, and it is what makes the assertion below a rule rather than a blanket clear:
		// one synchronized bucket on its own line must round-trip with its link intact.
		await prisma.account.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: source.id,
				name: 'Épargne',
				nameKey: computeNameKey('Épargne'),
				source: 'mock_connector',
				bankConnectionId: connection.id,
				providerAccountId: `provider-${crypto.randomUUID()}`,
				netWorthAccountId: healthy.id
			}
		});

		const payload = await buildBackupExport(source.id);
		// The payload really carries the defect, asserted rather than assumed: a file with one link
		// would make the restore's refusal a fact about the fixture.
		expect(payload.accounts.filter((a) => a.netWorthAccountId === line.id)).toHaveLength(2);

		await restoreBackup(target.id, payload as BackupExport);

		const restored = await prisma.account.findMany({
			where: { userId: target.id },
			select: { name: true, netWorthAccountId: true }
		});
		const byName = new Map(restored.map((row) => [row.name, row.netWorthAccountId]));
		// Nothing was dropped: three buckets in, three buckets out.
		expect(restored).toHaveLength(3);
		expect(byName.get('Courant')).toBeNull();
		expect(byName.get('Livret')).toBeNull();
		// And the uncontested one kept its line, remapped to the restored net worth account.
		expect(byName.get('Épargne')).not.toBeNull();
		// SCOPED TO THE RESTORED TENANT, and the first draft of this line was not, which the run
		// caught: `hasContestedNetWorthLines` reads the whole database on purpose, and the SOURCE
		// user is still sitting in the pre-fix state this test deliberately put them in. A global
		// assertion here would have been reporting on the fixture rather than on the restore.
		const restoredRows = await prisma.account.findMany({
			where: { userId: target.id },
			select: { id: true, netWorthAccountId: true, bankConnectionId: true }
		});
		expect(
			contestedNetWorthLines(
				restoredRows.map((row) => ({
					accountId: row.id,
					netWorthAccountId: row.netWorthAccountId,
					synchronized: row.bankConnectionId !== null
				}))
			)
		).toEqual([]);
	});
});
