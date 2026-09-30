import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import { buildBackupExport } from './export';
import { restoreBackup } from './import';
import { backupExportSchema, type BackupExport } from './schema';

/**
 * The remembered accounts (#599) and the backup, against a real engine.
 *
 * 1. The export carries NONE of them: the key is bound to this instance's secret and the fragment
 *    is #468's data class. Asserted on the serialised file, for the key and the fragment alike.
 * 2. The restore PURGES them explicitly, before the accounts, so the erasure does not ride on a
 *    cascade somebody could later change.
 * 3. A file written before 1.2 may still carry `importSourceSignatures` rows. It restores, and those
 *    rows write nothing: the shape memory is retired.
 *
 * See vitest.db.config.ts for how to run this.
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

/** Distinctive enough that finding it in a serialised file is not a coincidence. */
const FRAGMENT = 'Q7Z4';
const IDENTIFIER_KEY = 'e5'.repeat(32);

const createdUserIds: string[] = [];

async function freshUser(): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `remembered-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	return user.id;
}

async function seedRemembered(userId: string) {
	const account = await prisma.account.create({
		data: { userId, name: 'Compte courant', currency: 'EUR', exponent: 2, source: 'csv' },
		select: { id: true }
	});
	await prisma.rememberedAccount.create({
		data: { userId, identifierKey: IDENTIFIER_KEY, fragment: FRAGMENT, accountId: account.id }
	});
	return account.id;
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'e5'.repeat(32);
});

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

describe('remembered accounts and the backup', () => {
	it('exports none of them, neither the key nor the fragment', async () => {
		// SEPARATES « the export leaves the memory behind » FROM « it carries it in some key ». The
		// row is asserted present first, so an empty export cannot pass for a filtered one.
		const userId = await freshUser();
		await seedRemembered(userId);
		expect(await prisma.rememberedAccount.count({ where: { userId } })).toBe(1);

		const payload = await buildBackupExport(userId);
		const text = JSON.stringify(payload);

		expect(payload.importSourceSignatures).toStrictEqual([]);
		expect(text.includes(IDENTIFIER_KEY)).toBe(false);
		expect(text.includes(FRAGMENT)).toBe(false);
	});

	it('purges them on restore', async () => {
		const userId = await freshUser();
		await seedRemembered(userId);
		const payload = await buildBackupExport(userId);

		await restoreBackup(userId, payload as BackupExport);

		expect(await prisma.rememberedAccount.count({ where: { userId } })).toBe(0);
	});

	it('restores a file written before 1.2 that still carries the retired shape memory', async () => {
		// SEPARATES « a legacy file restores and its retired rows write nothing » FROM « the strict
		// schema refuses every backup written since #480 » and FROM « the rows come back as memory ».
		const userId = await freshUser();
		const accountId = await seedRemembered(userId);
		const current = await buildBackupExport(userId);
		const legacy = backupExportSchema.parse({
			...current,
			importSourceSignatures: [{ fingerprint: 'a'.repeat(64), accountId, useCount: 3 }]
		});

		await restoreBackup(userId, legacy);

		expect(await prisma.account.count({ where: { userId } })).toBe(1);
		expect(await prisma.rememberedAccount.count({ where: { userId } })).toBe(0);
	});
});
