import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import {
	accountMemoryKeyOf,
	forgetRememberedAccount,
	listRememberedAccounts,
	readRememberedAccount,
	rememberAnsweredAccount
} from './accountMemory';
import { resolveStatementAccount } from './sourceSignature';
import type { ParsedCsvRow } from './types';

/**
 * The remembered accounts (#599, #696) against a real engine: every read, write and delete is
 * scoped by `userId` in the SAME where clause (ASVS v5.0.0-8.2.2), proven with two real users who
 * import the SAME identifier, one reading under the other's key. A fake decides what `findFirst`
 * returns, so a dropped `userId` would leave a unit spec green; here it reads the other user's row.
 */

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly.'
	);
}

const createdUserIds: string[] = [];

async function freshUser(): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `memory-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	return user.id;
}

function account(userId: string, name: string, discriminant: string | null = null) {
	return prisma.account.create({
		data: { userId, name, currency: 'EUR', exponent: 2, source: 'csv', discriminant },
		select: { id: true, name: true, source: true, archivedAt: true, discriminant: true }
	});
}

/** A statement whose account column is constant: `identifier` is the whole value. */
function statement(identifier: string): ParsedCsvRow[] {
	return [
		{ cells: ['date', 'libelle', 'montant', 'compte'], line: 1 },
		{ cells: ['2026-08-01', 'CARTE MONOPRIX', '-32,10', identifier], line: 2 },
		{ cells: ['2026-08-02', 'VIR SALAIRE', '1850,00', identifier], line: 3 }
	];
}

const SILENT: ParsedCsvRow[] = [
	{ cells: ['date', 'libelle', 'montant'], line: 1 },
	{ cells: ['2026-08-01', 'CARTE MONOPRIX', '-32,10'], line: 2 }
];

const IDENTIFIER = '00012340185';

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'f6'.repeat(32);
});

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

describe('the writer', () => {
	it('remembers an answer once, and counts the same answer again on the same row', async () => {
		// SEPARATES « one row per identifier, counting uses » FROM « a row per import ».
		const userId = await freshUser();
		const courant = await account(userId, 'Compte courant', '4417');

		expect(
			await rememberAnsweredAccount({ userId, rows: statement(IDENTIFIER), accountId: courant.id })
		).toBe('remembered');
		expect(
			await rememberAnsweredAccount({ userId, rows: statement(IDENTIFIER), accountId: courant.id })
		).toBe('remembered');

		const rows = await prisma.rememberedAccount.findMany({ where: { userId } });
		expect(rows).toHaveLength(1);
		expect(rows[0].useCount).toBe(2);
		expect(rows[0].fragment).toBe('0185');
	});

	it('replaces the answer, count and date included, when the user answers another account', async () => {
		// SEPARATES « a correction replaces the answer » FROM « the withdrawn answer keeps its count ».
		const userId = await freshUser();
		const courant = await account(userId, 'Compte courant', '4417');
		const joint = await account(userId, 'Compte joint');
		await rememberAnsweredAccount({ userId, rows: statement(IDENTIFIER), accountId: courant.id });
		await rememberAnsweredAccount({ userId, rows: statement(IDENTIFIER), accountId: courant.id });

		await rememberAnsweredAccount({ userId, rows: statement(IDENTIFIER), accountId: joint.id });

		const rows = await prisma.rememberedAccount.findMany({ where: { userId } });
		expect(rows).toHaveLength(1);
		expect(rows[0].accountId).toBe(joint.id);
		expect(rows[0].useCount).toBe(1);
	});

	it('writes nothing for a file that names no account', async () => {
		const userId = await freshUser();
		const courant = await account(userId, 'Compte courant', '4417');

		expect(await rememberAnsweredAccount({ userId, rows: SILENT, accountId: courant.id })).toBe(
			'not-applicable'
		);
		expect(await prisma.rememberedAccount.count({ where: { userId } })).toBe(0);
	});

	it('writes nothing for a file whose identifier an account already holds', async () => {
		// EVIDENCE OUTRANKS MEMORY, on the write side: a row the reader would never consult is not
		// written. SEPARATES « one predicate for both sides » FROM « the writer stores what rank 1
		// will always answer instead ».
		const userId = await freshUser();
		await account(userId, 'Livret', '0185');
		const courant = await account(userId, 'Compte courant', '4417');

		expect(
			await rememberAnsweredAccount({ userId, rows: statement(IDENTIFIER), accountId: courant.id })
		).toBe('not-applicable');
		expect(await prisma.rememberedAccount.count({ where: { userId } })).toBe(0);
	});

	it("refuses to remember another user's account, and says only not-found", async () => {
		const mine = await freshUser();
		const theirs = await freshUser();
		await account(mine, 'Compte courant', '4417');
		const foreign = await account(theirs, 'Compte courant', '4417');

		expect(
			await rememberAnsweredAccount({
				userId: mine,
				rows: statement(IDENTIFIER),
				accountId: foreign.id
			})
		).toBe('not-found');
		expect(await prisma.rememberedAccount.count({ where: { userId: mine } })).toBe(0);
		expect(await prisma.rememberedAccount.count({ where: { userId: theirs } })).toBe(0);
	});
});

describe('the reader is scoped to its owner', () => {
	it('never answers with the other user, who imported the SAME identifier', async () => {
		// Their key under my user: the `userId` clause is the only thing separating the two.
		const mine = await freshUser();
		const theirs = await freshUser();
		const myAccount = await account(mine, 'Compte courant', '4417');
		const theirAccount = await account(theirs, 'Compte courant', '4417');
		await rememberAnsweredAccount({
			userId: theirs,
			rows: statement(IDENTIFIER),
			accountId: theirAccount.id
		});

		// Reading THEIR key under MY user: only the `userId` clause stands between the two.
		const theirKey = accountMemoryKeyOf(theirs, statement(IDENTIFIER), [theirAccount]);
		expect(await readRememberedAccount(mine, theirKey!)).toBeNull();
		expect(
			await resolveStatementAccount({
				userId: mine,
				rows: statement(IDENTIFIER),
				accounts: [myAccount]
			})
		).toStrictEqual({ rank: 3, kind: 'unknown' });
	});

	it('stores different keys for two users who hold the same account (joint accounts)', async () => {
		// SEPARATES « the key is bound to its user » FROM « two users holding one joint account
		// store the same key, so a database reader can link them » (contradiction pass).
		const mine = await freshUser();
		const theirs = await freshUser();
		const myAccount = await account(mine, 'Compte joint', '4417');
		const theirAccount = await account(theirs, 'Compte joint', '4417');
		for (const [userId, accountId] of [
			[mine, myAccount.id],
			[theirs, theirAccount.id]
		]) {
			await rememberAnsweredAccount({ userId, rows: statement(IDENTIFIER), accountId });
		}
		const keys = await prisma.rememberedAccount.findMany({
			where: { userId: { in: [mine, theirs] } },
			select: { identifierKey: true }
		});
		expect(keys).toHaveLength(2);
		expect(keys[0].identifierKey).not.toBe(keys[1].identifierKey);
	});

	it('answers each user with their own account for the same identifier', async () => {
		const mine = await freshUser();
		const theirs = await freshUser();
		const myAccount = await account(mine, 'Compte courant', '4417');
		const theirAccount = await account(theirs, 'Compte courant', '4417');
		await rememberAnsweredAccount({
			userId: mine,
			rows: statement(IDENTIFIER),
			accountId: myAccount.id
		});
		await rememberAnsweredAccount({
			userId: theirs,
			rows: statement(IDENTIFIER),
			accountId: theirAccount.id
		});

		expect(
			await resolveStatementAccount({
				userId: mine,
				rows: statement(IDENTIFIER),
				accounts: [myAccount]
			})
		).toStrictEqual({ rank: 3, kind: 'remembered', accountId: myAccount.id });
	});
});

describe('Settings: listed and forgotten, by the owner only', () => {
	it('lists only my remembered accounts, by the displayed account name', async () => {
		const mine = await freshUser();
		const theirs = await freshUser();
		const myAccount = await account(mine, 'Compte courant', '4417');
		const theirAccount = await account(theirs, 'Compte perso', '4417');
		await rememberAnsweredAccount({
			userId: mine,
			rows: statement(IDENTIFIER),
			accountId: myAccount.id
		});
		await rememberAnsweredAccount({
			userId: theirs,
			rows: statement(IDENTIFIER),
			accountId: theirAccount.id
		});

		const listed = await listRememberedAccounts(mine);
		expect(listed.map((row) => [row.fragment, row.accountName, row.useCount])).toStrictEqual([
			['0185', 'Compte courant', 1]
		]);
	});

	it("refuses to forget another user's row as not-found, and leaves it in place", async () => {
		// The IDOR case (ASVS v5.0.0-8.2.2): a foreign id posted to « Oublier ».
		const mine = await freshUser();
		const theirs = await freshUser();
		const theirAccount = await account(theirs, 'Compte perso', '4417');
		await rememberAnsweredAccount({
			userId: theirs,
			rows: statement(IDENTIFIER),
			accountId: theirAccount.id
		});
		const [theirRow] = await prisma.rememberedAccount.findMany({ where: { userId: theirs } });

		expect(await forgetRememberedAccount(mine, theirRow.id)).toBe('not-found');
		expect(await prisma.rememberedAccount.count({ where: { id: theirRow.id } })).toBe(1);
	});

	it('forgets my own row, after which the same identifier is unknown again', async () => {
		const mine = await freshUser();
		const myAccount = await account(mine, 'Compte courant', '4417');
		await rememberAnsweredAccount({
			userId: mine,
			rows: statement(IDENTIFIER),
			accountId: myAccount.id
		});
		const [row] = await prisma.rememberedAccount.findMany({ where: { userId: mine } });

		expect(await forgetRememberedAccount(mine, row.id)).toBe('forgotten');
		expect(
			await resolveStatementAccount({
				userId: mine,
				rows: statement(IDENTIFIER),
				accounts: [myAccount]
			})
		).toStrictEqual({ rank: 3, kind: 'unknown' });
	});

	it('goes with its account, through the foreign key', async () => {
		const mine = await freshUser();
		const myAccount = await account(mine, 'Compte courant', '4417');
		await rememberAnsweredAccount({
			userId: mine,
			rows: statement(IDENTIFIER),
			accountId: myAccount.id
		});

		await prisma.account.delete({ where: { id: myAccount.id } });

		expect(await prisma.rememberedAccount.count({ where: { userId: mine } })).toBe(0);
	});
});
