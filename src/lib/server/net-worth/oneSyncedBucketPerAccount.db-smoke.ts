import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { AccountWriteError, linkNetWorthAccount } from '$lib/server/accounts/service';
import { linkBankAccountToNetWorth, setManualAccountNetWorthLink } from './service';

/**
 * D4 BELONGS TO THE COLUMN, NOT TO THE SCREEN THE WRITE CAME FROM.
 *
 * The rule: at most one SYNCHRONIZED bucket (`Account.bankConnectionId` set) may point at one
 * `NetWorthAccount`. `recordSyncedBalance` writes a provider balance once per synced bucket whose
 * `netWorthAccountId` is set, so two of them make two provider balances fight over one line and
 * the figure on /net-worth becomes whichever bucket synced last.
 *
 * MEASURED on 0.14.1 against a real engine, one user, one connection, two of its buckets, one net
 * worth account (#501 and its first comment):
 *
 *   linkBankAccountToNetWorth(courant -> nwa)   accepted
 *   linkBankAccountToNetWorth(livret  -> nwa)   REJECTED   <- D4, enforced as documented
 *   linkNetWorthAccount(livret -> nwa)          ACCEPTED   <- the door around it
 *
 * ONE CONNECTION IS ENOUGH, which is why this is not latent: `syncBankConnection` creates one
 * bucket per account the provider returns, so a bank exposing a current and a savings account
 * gives two synchronized buckets on the first sync.
 *
 * ## Why this file exercises BOTH doors
 *
 * Because the defect is not in either of them. It is in the rule having had one enforcement site
 * while the column had three writers, and a file testing one door would report on that door. The
 * calibration below runs the door that already enforced D4 and MUST stay green through the fix:
 * without it, a refusal that reddened every link everywhere would pass every other test here.
 *
 * ## Why db-smoke and not a unit spec
 *
 * The whole mechanism is a conflict read paired with a write in one transaction. A fake decides
 * what `findFirst` returns, so deleting the conflict clause leaves a unit spec green
 * (AGENTS.md, "Security boundaries"). Every assertion below separates two states that only a real
 * engine holding a real second row can tell apart.
 *
 * ## What is NOT asserted here, and why, rather than left to be discovered
 *
 * That the conflict read is scoped by `userId`. `NetWorthAccount.id` is unique across the table
 * and is validated against the caller before the conflict read runs, so every row pointing at it
 * already belongs to that user: removing the `userId` clause reddens nothing, and a test built on
 * a tuple the application cannot produce reports on its fixture. The clause stays as defence in
 * depth because AGENTS.md states "scope every query by userId" with no exception for ids that
 * happen to be unique, and this paragraph is the record that it is unasserted rather than covered.
 * Same reading, and the same reason, as the ownership note in
 * `connectedBadgeOutlivesConnection.db-smoke.ts`.
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
/** A second tenant, present in every test so an ownership assertion has a real foreign row. */
let otherUserId: string;

beforeEach(async () => {
	// `crypto.randomUUID`, never `Date.now()`: #483 records half the db-smoke files deriving
	// uniqueness from the clock and colliding on a second run under a pinned one.
	const user = await prisma.user.create({
		data: {
			email: `d4-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
	const other = await prisma.user.create({
		data: {
			email: `d4-other-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	otherUserId = other.id;
});

async function makeNetWorthAccount(name: string, owner: string = userId): Promise<string> {
	const account = await prisma.netWorthAccount.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: owner,
			name,
			nameKey: computeNameKey(name),
			type: 'checking',
			balanceCents: 100_000n
		},
		select: { id: true }
	});
	return account.id;
}

/** One bank authorisation. Several buckets hang off it, which is the ordinary case. */
async function makeConnection(owner: string = userId): Promise<string> {
	const connection = await prisma.bankConnection.create({
		data: { userId: owner, provider: 'mock', aspspName: 'Banque Imaginaire', status: 'active' },
		select: { id: true }
	});
	return connection.id;
}

/**
 * A bucket as the sync path builds one: a connection and a `providerAccountId`. Created unlinked,
 * so every link in this file is performed by a production function rather than by the fixture.
 */
async function makeSyncedBucket(
	connectionId: string,
	name: string,
	owner: string = userId
): Promise<string> {
	const bucket = await prisma.account.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: owner,
			name,
			nameKey: computeNameKey(name),
			source: 'mock_connector',
			bankConnectionId: connectionId,
			providerAccountId: `provider-${crypto.randomUUID()}`
		},
		select: { id: true }
	});
	return bucket.id;
}

/** A CSV bucket: no connection, no provider account. It never writes a balance snapshot. */
async function makeCsvBucket(name: string): Promise<string> {
	const bucket = await prisma.account.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			name,
			nameKey: computeNameKey(name),
			source: 'csv'
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

async function syncedBucketCountOn(netWorthAccountId: string): Promise<number> {
	return prisma.account.count({
		where: { userId, netWorthAccountId, bankConnectionId: { not: null } }
	});
}

/** The status of the refusal /imports/bank-connections renders, or a throw if none happened. */
async function httpStatusOf(run: () => Promise<unknown>): Promise<number> {
	try {
		await run();
	} catch (caught) {
		expect(isHttpError(caught)).toBe(true);
		return isHttpError(caught) ? caught.status : 0;
	}
	throw new Error('the call was expected to be refused and returned instead');
}

/** The reason /settings renders a sentence from, or a throw if no refusal happened. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (caught) {
		expect(caught).toBeInstanceOf(AccountWriteError);
		return (caught as AccountWriteError).reason;
	}
	throw new Error('the call was expected to be refused and returned instead');
}

describe('D4 — one synchronized bucket per net worth account, whichever door the write comes from', () => {
	/**
	 * THE CALIBRATION, first on purpose and it must be green on both sides of the fix.
	 *
	 * SEPARATES: « D4 is enforced on the door that documents it » FROM « this fixture cannot build
	 * a conflict at all ». Every refusal below is worth nothing until a refusal is known to be
	 * producible here, and a fixture that quietly failed to make two synchronized buckets would
	 * make each of them pass by having nothing to catch.
	 */
	it('refuses the second synchronized bucket on the bank-connections door', async () => {
		expect.assertions(3);

		const connectionId = await makeConnection();
		const courant = await makeSyncedBucket(connectionId, 'Banque Imaginaire courant');
		const livret = await makeSyncedBucket(connectionId, 'Banque Imaginaire livret');
		const line = await makeNetWorthAccount('Livret fictif');

		await linkBankAccountToNetWorth(userId, courant, line);
		expect(await httpStatusOf(() => linkBankAccountToNetWorth(userId, livret, line))).toBe(409);
		expect(await linkOf(livret)).toBeNull();
	});

	/**
	 * THE DEFECT. Red on 0.14.1: this call was ACCEPTED and produced the state the calibration
	 * above proves the other door refuses.
	 *
	 * SEPARATES: « the rule belongs to the column » FROM « the rule belongs to
	 * /imports/bank-connections ». One user, ONE connection, two of its buckets: the second
	 * connection is not a precondition, it is only the loudest case.
	 *
	 * Asserts the REASON rather than that a refusal happened, because `not-found` and
	 * `net-worth-not-found` are both reachable from this call and both would satisfy « it threw ».
	 */
	it('refuses the second synchronized bucket on the settings door', async () => {
		expect.assertions(4);

		const connectionId = await makeConnection();
		const courant = await makeSyncedBucket(connectionId, 'Banque Imaginaire courant');
		const livret = await makeSyncedBucket(connectionId, 'Banque Imaginaire livret');
		const line = await makeNetWorthAccount('Livret fictif');

		await linkBankAccountToNetWorth(userId, courant, line);
		expect(
			await refusalOf(() =>
				linkNetWorthAccount({ userId, accountId: livret, netWorthAccountId: line })
			)
		).toBe('net-worth-already-synced');
		expect(await linkOf(livret)).toBeNull();
		// The absolute figure beside the refusal: one, not "no new one". A refusal that had also
		// cleared the bucket that legitimately holds the line would satisfy the assertion above.
		expect(await syncedBucketCountOn(line)).toBe(1);
	});

	/**
	 * THE LOSS, and it is the path this change must not take with it.
	 *
	 * SEPARATES: « the refusal is the conflict » FROM « the settings door stopped linking
	 * synchronized buckets ». A closed door is easy to close too far, and a user whose bank bucket
	 * can no longer reach any net worth line has lost the feature rather than gained a rule.
	 */
	it('still links a synchronized bucket to a line no other synchronized bucket holds', async () => {
		expect.assertions(2);

		const connectionId = await makeConnection();
		const livret = await makeSyncedBucket(connectionId, 'Banque Imaginaire livret');
		const line = await makeNetWorthAccount('Livret fictif');

		await linkNetWorthAccount({ userId, accountId: livret, netWorthAccountId: line });
		expect(await linkOf(livret)).toBe(line);
		expect(await syncedBucketCountOn(line)).toBe(1);
	});

	/**
	 * SEPARATES: « the conflict read excludes the bucket being written » FROM « any existing
	 * synchronized link on the target is a conflict ». Without the exclusion a bucket collides with
	 * itself, so re-submitting the select on its current value would refuse, and /settings submits
	 * that select on change.
	 */
	it('lets a synchronized bucket keep the line it already holds', async () => {
		expect.assertions(2);

		const connectionId = await makeConnection();
		const livret = await makeSyncedBucket(connectionId, 'Banque Imaginaire livret');
		const line = await makeNetWorthAccount('Livret fictif');

		await linkNetWorthAccount({ userId, accountId: livret, netWorthAccountId: line });
		await linkNetWorthAccount({ userId, accountId: livret, netWorthAccountId: line });
		expect(await linkOf(livret)).toBe(line);
		expect(await syncedBucketCountOn(line)).toBe(1);
	});

	/**
	 * SEPARATES: « clearing is exempt from the conflict rule » FROM « the rule runs on every
	 * write ». There is no reference to authorise and nothing to double-book when the target is
	 * null, and clearing is how a user moves a line from one bucket to another: a refusal here
	 * would make the two buckets permanent.
	 */
	it('never refuses a clear', async () => {
		expect.assertions(3);

		const connectionId = await makeConnection();
		const courant = await makeSyncedBucket(connectionId, 'Banque Imaginaire courant');
		const livret = await makeSyncedBucket(connectionId, 'Banque Imaginaire livret');
		const line = await makeNetWorthAccount('Livret fictif');

		await linkNetWorthAccount({ userId, accountId: courant, netWorthAccountId: line });
		await linkNetWorthAccount({ userId, accountId: courant, netWorthAccountId: null });
		expect(await linkOf(courant)).toBeNull();

		// And the line is free again, which is the half that makes the clear worth anything.
		await linkNetWorthAccount({ userId, accountId: livret, netWorthAccountId: line });
		expect(await linkOf(livret)).toBe(line);
		expect(await syncedBucketCountOn(line)).toBe(1);
	});

	/**
	 * SEPARATES: « only SYNCHRONIZED buckets are counted » FROM « any second bucket is a conflict ».
	 * This is D4's own carve-out and it is load-bearing: a CSV bucket never writes a balance
	 * snapshot, so it has nothing to fight with. A fix that refused this would break the ordinary
	 * case of a user who imports statements for the same account they also connected.
	 */
	it('does not treat a CSV bucket on the same line as a conflict, in either direction', async () => {
		expect.assertions(3);

		const connectionId = await makeConnection();
		const synced = await makeSyncedBucket(connectionId, 'Banque Imaginaire courant');
		const csv = await makeCsvBucket('Relevés Banque Imaginaire');
		const line = await makeNetWorthAccount('Compte courant fictif');

		await linkNetWorthAccount({ userId, accountId: synced, netWorthAccountId: line });
		await linkNetWorthAccount({ userId, accountId: csv, netWorthAccountId: line });
		expect(await linkOf(csv)).toBe(line);
		expect(await syncedBucketCountOn(line)).toBe(1);

		// And the other direction, because "the CSV bucket got there first" is the same state
		// reached by a different order and must answer the same way.
		const otherLine = await makeNetWorthAccount('Livret fictif');
		const otherCsv = await makeCsvBucket('Relevés livret');
		await linkNetWorthAccount({ userId, accountId: otherCsv, netWorthAccountId: otherLine });
		await linkBankAccountToNetWorth(userId, synced, otherLine);
		expect(await linkOf(synced)).toBe(otherLine);
	});

	/**
	 * IDOR, THE BANK DOOR, AGAINST A REAL ENGINE FOR THE FIRST TIME.
	 *
	 * `linkBankAccountToNetWorth`'s ownership assertions lived in `service.spec.ts` against a fake
	 * `tx`, and that green means nothing by this repository's own rule: Prisma treats a `where` key
	 * it does not recognise as NO FILTER, and no fake models that, so deleting the `userId` clause
	 * leaves a unit spec passing. Both refusals below are reinstated here, where the foreign row
	 * really exists.
	 *
	 * SEPARATES: « both object references are authorised » FROM « one of them is taken on trust ».
	 * Two claims arrive in one call and a function validating one looks exactly like a function
	 * validating both. ASVS 5.0.0 `v5.0.0-8.2.2`, as of the 2026-08-13 assessment of commit
	 * `d9c116c`: verified by attack rather than by inspection.
	 */
	it("refuses another tenant's bucket and another tenant's line, on the bank door", async () => {
		expect.assertions(6);

		const theirConnection = await makeConnection(otherUserId);
		const theirBucket = await makeSyncedBucket(theirConnection, 'Leur courant', otherUserId);
		const theirLine = await makeNetWorthAccount('Leur livret', otherUserId);
		const myConnection = await makeConnection();
		const myBucket = await makeSyncedBucket(myConnection, 'Mon courant');
		const myLine = await makeNetWorthAccount('Mon livret');

		// Their bucket, my line.
		expect(await httpStatusOf(() => linkBankAccountToNetWorth(userId, theirBucket, myLine))).toBe(
			404
		);
		expect(await linkOf(theirBucket)).toBeNull();
		// My bucket, their line.
		expect(await httpStatusOf(() => linkBankAccountToNetWorth(userId, myBucket, theirLine))).toBe(
			404
		);
		expect(await linkOf(myBucket)).toBeNull();
	});

	/** The same pair on the settings door, which reports a reason rather than a status. */
	it("refuses another tenant's bucket and another tenant's line, on the settings door", async () => {
		expect.assertions(6);

		const theirConnection = await makeConnection(otherUserId);
		const theirBucket = await makeSyncedBucket(theirConnection, 'Leur courant', otherUserId);
		const theirLine = await makeNetWorthAccount('Leur livret', otherUserId);
		const myConnection = await makeConnection();
		const myBucket = await makeSyncedBucket(myConnection, 'Mon courant');
		const myLine = await makeNetWorthAccount('Mon livret');

		expect(
			await refusalOf(() =>
				linkNetWorthAccount({ userId, accountId: theirBucket, netWorthAccountId: myLine })
			)
		).toBe('not-found');
		expect(await linkOf(theirBucket)).toBeNull();
		expect(
			await refusalOf(() =>
				linkNetWorthAccount({ userId, accountId: myBucket, netWorthAccountId: theirLine })
			)
		).toBe('net-worth-not-found');
		expect(await linkOf(myBucket)).toBeNull();
	});

	/**
	 * THE CONFLICT READ IS NOT SCOPED BY TENANT, AND THIS IS THE ASSERTION THAT SAYS SO.
	 *
	 * SEPARATES: « the count asks how many buckets feed this line » FROM « the count asks how many
	 * of MY buckets feed it ». The two agree on every state the application can produce and disagree
	 * on exactly one: a bucket of another tenant pointing at my line, which no path should create
	 * and which, if it exists, is writing a foreign bank's balance into my net worth today.
	 *
	 * Scoping the read by `userId` reads as the safer choice and is the wrong one here: it would
	 * filter the evidence out of the count and let a second writer join a line that already has one.
	 * The two authorising reads above keep their `userId` clause; this one is a count about a line
	 * the caller has already been shown to own, so it answers one boolean and leaks nothing.
	 *
	 * The fixture is written directly rather than through a door, because no door can produce it.
	 * That is the point of the test, and it is why this state is worth refusing rather than assuming
	 * away.
	 */
	it('refuses a link to a line a foreign synchronized bucket is already feeding', async () => {
		expect.assertions(4);

		const myLine = await makeNetWorthAccount('Mon livret');
		const theirConnection = await makeConnection(otherUserId);
		const trespasser = await prisma.account.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: otherUserId,
				name: 'Bucket intrus',
				nameKey: computeNameKey('Bucket intrus'),
				source: 'mock_connector',
				bankConnectionId: theirConnection,
				providerAccountId: `provider-${crypto.randomUUID()}`,
				netWorthAccountId: myLine
			},
			select: { id: true }
		});

		const myConnection = await makeConnection();
		const myBucket = await makeSyncedBucket(myConnection, 'Mon courant');

		expect(
			await refusalOf(() =>
				linkNetWorthAccount({ userId, accountId: myBucket, netWorthAccountId: myLine })
			)
		).toBe('net-worth-already-synced');
		expect(await linkOf(myBucket)).toBeNull();
		// The foreign row is left exactly where it was: this door refuses, it does not repair. The
		// boot repair is what withdraws both, and it is asserted in `contestedLinkRepair.db-smoke.ts`.
		expect(await linkOf(trespasser.id)).toBe(myLine);
	});

	/**
	 * THE EXEMPTION'S PREMISE, ASSERTED RATHER THAN COMMENTED.
	 *
	 * `setManualAccountNetWorthLink` is the third writer of this column and it does not run the
	 * conflict read. It is exempt because the row it writes can never be a D4 participant, and that
	 * is a claim about `ensureManualAccount` rather than about this function: it upserts on
	 * `source: 'manual'` and no writer of `bankConnectionId` targets a manual-sourced row.
	 *
	 * SEPARATES: « the manual bucket is unsynchronized, so the exemption is structural » FROM « the
	 * exemption is an oversight that happens to be harmless today ». The second assertion is the
	 * one that would catch a manual bucket acquiring a connection, which is the only way the
	 * exemption could ever become false.
	 */
	it('lets the manual bucket share a line with a synchronized bucket, and stays unsynchronized', async () => {
		expect.assertions(3);

		const connectionId = await makeConnection();
		const synced = await makeSyncedBucket(connectionId, 'Banque Imaginaire courant');
		const line = await makeNetWorthAccount('Compte courant fictif');

		await linkBankAccountToNetWorth(userId, synced, line);
		await setManualAccountNetWorthLink(userId, line);

		const manual = await prisma.account.findFirstOrThrow({
			where: { userId, source: 'manual' },
			select: { netWorthAccountId: true, bankConnectionId: true }
		});
		expect(manual.netWorthAccountId).toBe(line);
		expect(manual.bankConnectionId).toBeNull();
		expect(await syncedBucketCountOn(line)).toBe(1);
	});
});
