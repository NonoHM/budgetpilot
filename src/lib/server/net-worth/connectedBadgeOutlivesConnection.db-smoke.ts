import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { deleteBankConnection } from '$lib/server/banking/sync/service';
import { readNetWorthAccounts, setManualAccountNetWorthLink } from './service';

/**
 * The « Connecté » badge on /net-worth survives disconnecting the bank account that earned it.
 *
 * MEASURED on 0.14.0 against a real engine, three rows and the third is the one that explains it:
 *
 *   before disconnect  _count.accounts=1 connected=true  bankConnectionId=set   netWorthAccountId=set
 *   after  disconnect  _count.accounts=1 connected=true  bankConnectionId=null  netWorthAccountId=set
 *
 * `connected` is NOT stale. `service.ts` recomputes it on every load as `_count.accounts > 0`, so
 * it is a verdict on the present and it is telling the truth about a link that no code path
 * clears. `Account.bankConnectionId` is `SetNull` on purpose, because losing a connection must
 * never delete transactions; nothing was ever written to clear the sibling `netWorthAccountId`
 * beside it. The badge is the symptom, the surviving link is the defect.
 *
 * ## Why a db-smoke and not a unit spec
 *
 * The whole mechanism is `onDelete: SetNull` plus a relation `_count`, which is the database's
 * behaviour and not the application's. A unit spec's fake decides what `findFirst` returns, so
 * removing the clearing clause would leave it green. That exact green is why the IDOR battery is
 * against a real engine (AGENTS.md), and it applies here for the same reason.
 *
 * ## What this file deliberately does NOT claim
 *
 * It does not claim the stale link was unreachable. `accounts/service.ts`'s `linkNetWorthAccount`,
 * reached from /settings, writes this column with no `bankConnectionId` restriction, so a reader
 * who knows where to look can clear it in two clicks on another screen. The defect is a false
 * badge with a non-obvious manual repair elsewhere, not a trap, and the first draft of this work
 * said otherwise.
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
	// `crypto.randomUUID`, never `Date.now()`. See #483: half the db-smoke files derive uniqueness
	// from the clock and collide on a second run under a pinned one.
	const user = await prisma.user.create({
		data: {
			email: `nw-badge-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
});

/** A net worth account of a type that may carry a bank link. */
async function makeNetWorthAccount(name: string): Promise<string> {
	const account = await prisma.netWorthAccount.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			name,
			type: 'checking',
			balanceCents: 120_000n
		},
		select: { id: true }
	});
	return account.id;
}

/**
 * A bank-sync bucket as the sync path builds one: a connection, a `providerAccountId` (null on
 * every CSV bucket, see `import/dedupeRecompute.ts`), and the link to a net worth account.
 */
async function makeSyncedBucket(input: {
	netWorthAccountId: string | null;
	name: string;
}): Promise<{ bucketId: string; connectionId: string }> {
	const connection = await prisma.bankConnection.create({
		data: { userId, provider: 'mock', aspspName: 'Banque Imaginaire', status: 'active' },
		select: { id: true }
	});
	const bucket = await prisma.account.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			name: input.name,
			nameKey: computeNameKey(input.name),
			source: 'mock_connector',
			bankConnectionId: connection.id,
			providerAccountId: `provider-${crypto.randomUUID()}`,
			netWorthAccountId: input.netWorthAccountId
		},
		select: { id: true }
	});
	return { bucketId: bucket.id, connectionId: connection.id };
}

async function connectedOf(netWorthAccountId: string): Promise<boolean> {
	const accounts = await readNetWorthAccounts(userId);
	const record = accounts.find((account) => account.id === netWorthAccountId);
	if (!record) throw new Error('the net worth account under test was not returned by the read');
	return record.connected;
}

describe('/net-worth — the Connecté badge does not outlive the connection', () => {
	/**
	 * The calibration, and it runs first on purpose. It separates "the badge answers the link" from
	 * "the badge is always true" and from "the read returned nothing", which the two assertions
	 * below cannot tell apart on their own. Without it, a fix that hard-coded `connected: false`
	 * would pass every other test in this file.
	 */
	it('is on while the connection is live, which is what makes the rest of this file mean anything', async () => {
		expect.assertions(1);

		const netWorthAccountId = await makeNetWorthAccount('Compte courant fictif');
		await makeSyncedBucket({ netWorthAccountId, name: 'Banque Imaginaire courant' });

		expect(await connectedOf(netWorthAccountId)).toBe(true);
	});

	/**
	 * The defect. Separates "the link went with the connection" from "the link outlived it", which
	 * is the state 0.14.0 shipped. Asserted on `connected`, the value the badge actually renders
	 * from, rather than on the column, so a fix that cleared the column and left the read wrong
	 * would not pass.
	 */
	it('goes off when the bank connection is deleted', async () => {
		expect.assertions(2);

		const netWorthAccountId = await makeNetWorthAccount('Compte courant fictif');
		const { connectionId } = await makeSyncedBucket({
			netWorthAccountId,
			name: 'Banque Imaginaire courant'
		});

		expect(await deleteBankConnection(userId, connectionId)).toBe(true);
		expect(await connectedOf(netWorthAccountId)).toBe(false);
	});

	/**
	 * The invariant the `SetNull` exists to protect, asserted here rather than assumed. Separates
	 * "the link was cleared" from "the bucket was deleted", and the second would be silent data
	 * loss: the schema comment on `bankConnectionId` says losing the connection must never delete
	 * transactions, and clearing a column beside it must not start doing so.
	 */
	it('keeps the bucket and its transactions', async () => {
		expect.assertions(3);

		const netWorthAccountId = await makeNetWorthAccount('Compte courant fictif');
		const { bucketId, connectionId } = await makeSyncedBucket({
			netWorthAccountId,
			name: 'Banque Imaginaire courant'
		});
		// `category` is a required relation on Transaction, so the row needs one to exist at all.
		// The sentinel, because what this test is about is the bucket surviving, not the category.
		const category = await prisma.category.create({
			data: { userId, name: UNCLASSIFIED_CATEGORY, nameKey: computeNameKey(UNCLASSIFIED_CATEGORY) },
			select: { id: true }
		});
		await prisma.transaction.create({
			data: {
				...DEFAULT_DENOMINATION,
				user: { connect: { id: userId } },
				account: { connect: { id: bucketId } },
				category: { connect: { id: category.id } },
				date: new Date('2026-07-12T00:00:00.000Z'),
				label: 'ABONNEMENT ZORGLUB',
				amountCents: -1990,
				type: 'expense',
				source: 'mock_connector'
			}
		});

		await deleteBankConnection(userId, connectionId);

		const bucket = await prisma.account.findUnique({
			where: { id: bucketId },
			select: { id: true, netWorthAccountId: true }
		});
		expect(bucket).not.toBeNull();
		expect(bucket?.netWorthAccountId).toBeNull();
		expect(await prisma.transaction.count({ where: { accountId: bucketId } })).toBe(1);
	});

	/**
	 * The over-clearing guard, and it is the assertion that decides whether the fix is aimed or
	 * merely destructive. A MANUAL bucket's link has nothing to do with any bank: it is set from
	 * the /net-worth modal's own switch, it carries no `providerAccountId`, and deleting somebody's
	 * bank connection must leave it exactly where it was.
	 *
	 * Two net worth accounts, so the assertion cannot pass by the fix happening to clear both: one
	 * must go off and the other must stay on, in the same read.
	 */
	it('leaves a manual link on another account untouched', async () => {
		expect.assertions(2);

		const bankLinked = await makeNetWorthAccount('Compte courant fictif');
		const manualLinked = await makeNetWorthAccount('Livret fictif');
		const { connectionId } = await makeSyncedBucket({
			netWorthAccountId: bankLinked,
			name: 'Banque Imaginaire courant'
		});
		await setManualAccountNetWorthLink(userId, manualLinked);

		await deleteBankConnection(userId, connectionId);

		expect(await connectedOf(bankLinked)).toBe(false);
		expect(await connectedOf(manualLinked)).toBe(true);
	});

	/**
	 * OWNERSHIP: another user's link survives a disconnect on this one.
	 *
	 * WHAT THIS TEST DOES NOT DO, stated because the break-check proved it rather than because it
	 * was suspected. Deleting `userId` from the clearing's `where` reddens NOTHING, before or after
	 * this test was written. That is the fourth of AGENTS.md's four green-break readings and here it
	 * is the true one: a `BankConnection` id is unique across the table, so `bankConnectionId`
	 * alone already selects exactly one user's buckets, and the two versions cannot be told apart
	 * through the production function. Separating them would need a fixture where two users share
	 * one connection id, which the schema cannot produce, and a test built on an impossible tuple
	 * reports on its own fixture rather than on the code.
	 *
	 * So the `userId` clause stays as defence in depth, because « scope every query by userId » is
	 * stated in AGENTS.md without an exception for ids that happen to be unique, and this comment
	 * is the record that it is unasserted rather than covered. What the test below DOES assert is
	 * real and was worth adding on its own: the blast radius stops at one tenant, which no other
	 * case in this file looks at.
	 */
	it('touches no other user’s link, even one on an identically shaped account', async () => {
		expect.assertions(2);

		const mine = await makeNetWorthAccount('Compte courant fictif');
		const { connectionId } = await makeSyncedBucket({
			netWorthAccountId: mine,
			name: 'Banque Imaginaire courant'
		});

		// A second tenant, built the same way, whose link must be exactly where it was afterwards.
		const otherUser = await prisma.user.create({
			data: {
				email: `nw-badge-other-${crypto.randomUUID()}@budgetpilot.invalid`,
				passwordHash: 'db-smoke-not-a-real-hash'
			},
			select: { id: true }
		});
		const theirNetWorth = await prisma.netWorthAccount.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: otherUser.id,
				name: 'Compte courant fictif',
				type: 'checking',
				balanceCents: 120_000n
			},
			select: { id: true }
		});
		const theirConnection = await prisma.bankConnection.create({
			data: { userId: otherUser.id, provider: 'mock', aspspName: 'Banque Imaginaire' },
			select: { id: true }
		});
		const theirBucket = await prisma.account.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: otherUser.id,
				name: 'Banque Imaginaire courant',
				nameKey: computeNameKey('Banque Imaginaire courant'),
				source: 'mock_connector',
				bankConnectionId: theirConnection.id,
				providerAccountId: `provider-${crypto.randomUUID()}`,
				netWorthAccountId: theirNetWorth.id
			},
			select: { id: true }
		});

		await deleteBankConnection(userId, connectionId);

		expect(await connectedOf(mine)).toBe(false);
		const theirs = await prisma.account.findUnique({
			where: { id: theirBucket.id },
			select: { netWorthAccountId: true }
		});
		expect(theirs?.netWorthAccountId).toBe(theirNetWorth.id);
	});

	/**
	 * The other half of the same guard, one table over. A bucket belonging to a DIFFERENT, still
	 * live connection must keep its link: the clearing is scoped to the connection being deleted,
	 * not to every synced bucket the user has.
	 */
	it('leaves another live connection’s bucket linked', async () => {
		expect.assertions(2);

		const doomed = await makeNetWorthAccount('Compte courant fictif');
		const survivor = await makeNetWorthAccount('Compte joint fictif');
		const { connectionId } = await makeSyncedBucket({
			netWorthAccountId: doomed,
			name: 'Banque Imaginaire courant'
		});
		await makeSyncedBucket({ netWorthAccountId: survivor, name: 'Banque Imaginaire joint' });

		await deleteBankConnection(userId, connectionId);

		expect(await connectedOf(doomed)).toBe(false);
		expect(await connectedOf(survivor)).toBe(true);
	});
});
