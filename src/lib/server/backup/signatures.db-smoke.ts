import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { buildBackupExport } from './export';
import { restoreBackup } from './import';
import type { BackupExport } from './schema';

/**
 * Three claims about the import memory that a fake Prisma structurally cannot answer.
 *
 * 1. `where: { discriminant: null }` is a filter the ENGINE applies, and the fake applies a
 *    predicate somebody wrote by hand beside the one under test. Same source, so it can only
 *    agree with itself.
 * 2. The restore writes several fragment-free rows that SHARE a fingerprint, and whether that is
 *    legal is decided by `@@unique([userId, fingerprint, discriminant])` under NULL, which no fake
 *    has an opinion about. The model documents the case ("a NULL-discriminant fingerprint may be
 *    the only entry or one of several"), so an engine that refused it would make a user's own
 *    export unrestorable and nothing else in this repository would notice.
 * 3. The purge is an explicit `deleteMany` rather than a cascade, and a real foreign key is what
 *    tells a working purge from one the cascade was quietly doing.
 *
 * See vitest.db.config.ts for how to run this.
 */

// Same guard as volume.db-smoke.ts, and for the same reason: the app's client falls back to
// `file:./dev.db` when DATABASE_URL is unset, and this suite writes and deletes real rows.
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

/** Full length, because the column holds the whole SHA-256 of a header row, never truncated. */
const SHARED_FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);
/**
 * The four characters a statement would carry. Written once, and asserted absent from the two
 * exported arrays whose tables hold a discriminant column, never from the export as a whole (#740).
 */
const FRAGMENT = '4417';

const createdUserIds: string[] = [];

async function freshUser(emailPrefix = 'signatures'): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `${emailPrefix}-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	return user.id;
}

async function seedAccount(userId: string, name: string, discriminant: string | null) {
	return prisma.account.create({
		data: { userId, name, currency: 'EUR', exponent: 2, source: 'csv', discriminant },
		select: { id: true }
	});
}

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

describe('the import memory through a real engine', () => {
	it('exports the fragment-free rows only, even when the email spells the fragment', async () => {
		// The email spells the fragment ON PURPOSE, and this is the regression for #740. The
		// assertion here used to be `not.toContain(FRAGMENT)` over `JSON.stringify(payload)`, a
		// haystack that concatenates the email and every cuid, so it went red whenever a random
		// value happened to spell the fragment (once in CI, on a UUID ending in the fragment). With
		// the email pinned to contain it, that shape is red on EVERY run instead of on a rare one,
		// and only assertions on the elements themselves can pass. AGENTS.md « Before writing »
		// names the shape.
		const userId = await freshUser(`signatures-${FRAGMENT}`);
		const plain = await seedAccount(userId, 'Compte courant', null);
		const bearing = await seedAccount(userId, 'Compte joint', FRAGMENT);
		await prisma.importSourceSignature.createMany({
			data: [
				{ userId, fingerprint: SHARED_FINGERPRINT, discriminant: null, accountId: plain.id },
				{ userId, fingerprint: OTHER_FINGERPRINT, discriminant: FRAGMENT, accountId: bearing.id }
			]
		});

		const payload = await buildBackupExport(userId);

		// The companion to the emptiness assertions: this user really owns two rows, one of which
		// really carries a fragment, so "one is exported" is a filter working rather than a query
		// finding nothing.
		expect(await prisma.importSourceSignature.count({ where: { userId } })).toBe(2);
		// The two tables with a discriminant column are Account and ImportSourceSignature, so their
		// two arrays are where the fragment could leave, and each is asserted to BE the expected
		// fragment-free rows. Whole rows rather than a missing key: a field added to either export
		// select turns this red, which is the moment to decide whether it can carry a fragment.
		// Break checks (#740): dropping the export's `discriminant: null` filter separates "the
		// engine filtered the signatures" from "every row was read out"; selecting the account's
		// `discriminant` separates "column left behind" from "column exported".
		expect(payload.importSourceSignatures).toEqual([
			{ fingerprint: SHARED_FINGERPRINT, accountId: plain.id, useCount: 0 }
		]);
		const accountRow = { currency: 'EUR', exponent: 2, source: 'csv' };
		const noLinks = {
			netWorthAccountId: null,
			bankConnectionId: null,
			providerAccountId: null,
			providerCashAccountType: null
		};
		expect([...payload.accounts].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
			{ id: plain.id, name: 'Compte courant', ...accountRow, ...noLinks },
			{ id: bearing.id, name: 'Compte joint', ...accountRow, ...noLinks }
		]);
		// The pinned email really is in the export, so the concatenation this replaced cannot pass.
		// Break check: unpinning the email separates a haystack that spells the fragment from one
		// that does not, and only this line sees it.
		expect(payload.userEmail).toContain(FRAGMENT);
	});

	it('restores two fragment-free rows sharing one fingerprint, which the unique index permits', async () => {
		const source = await freshUser();
		const target = await freshUser();
		const first = await seedAccount(source, 'Compte courant', null);
		const second = await seedAccount(source, 'Livret', null);
		// The shape the middle option would MANUFACTURE from two fragment-bearing rows, and the
		// shape a user reaches legitimately by feeding one file layout to two accounts. If the
		// index treated NULLs as equal, this restore would abort and their own export would be
		// unrestorable.
		await prisma.importSourceSignature.createMany({
			data: [
				{
					userId: source,
					fingerprint: SHARED_FINGERPRINT,
					discriminant: null,
					accountId: first.id
				},
				{
					userId: source,
					fingerprint: SHARED_FINGERPRINT,
					discriminant: null,
					accountId: second.id
				}
			]
		});

		const payload = await buildBackupExport(source);
		expect(payload.importSourceSignatures).toHaveLength(2);

		await restoreBackup(target, payload as BackupExport);

		const restored = await prisma.importSourceSignature.findMany({
			where: { userId: target },
			select: { fingerprint: true, discriminant: true, accountId: true }
		});
		expect(restored).toHaveLength(2);
		expect(restored.every((row) => row.discriminant === null)).toBe(true);
		// Two DIFFERENT accounts, regenerated: the pair did not collapse onto one bucket, which is
		// the failure the fake cannot see because it has no unique index.
		expect(new Set(restored.map((row) => row.accountId)).size).toBe(2);
		const sourceAccountIds = new Set([first.id, second.id]);
		expect(restored.some((row) => sourceAccountIds.has(row.accountId))).toBe(false);
	});

	it('purges the fragment-bearing rows a restore cannot put back', async () => {
		const userId = await freshUser();
		const account = await seedAccount(userId, 'Compte courant', FRAGMENT);
		await prisma.importSourceSignature.create({
			data: {
				userId,
				fingerprint: SHARED_FINGERPRINT,
				discriminant: FRAGMENT,
				accountId: account.id
			}
		});
		const payload = await buildBackupExport(userId);
		// The row exists and is NOT in the file: both halves, so the assertion below is about a
		// purge rather than about an export that happened to be empty.
		expect(await prisma.importSourceSignature.count({ where: { userId } })).toBe(1);
		expect(payload.importSourceSignatures).toHaveLength(0);

		await restoreBackup(userId, payload as BackupExport);

		expect(await prisma.importSourceSignature.count({ where: { userId } })).toBe(0);
	});
});
