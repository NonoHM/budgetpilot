import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { accountsForPicker } from '$lib/server/accounts/projection';
import { runStatementAccountBackfill } from '$lib/server/import/accountBackfill';
import { buildBackupExport } from './export';
import { restoreBackup } from './import';
import { backupExportSchema } from './schema';

/**
 * An account's archived state and institution through a backup and back, against a real engine
 * (#1176, #1102).
 *
 * Both columns change what the application DOES with the account after a restore, which is what
 * these tests assert: `archivedAt` decides whether the account is offered as an import
 * destination, and a null `institution` on a bank's bucket puts it back in the boot backfill,
 * which renames it to the bank's name. Asserting the columns alone would miss the second.
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

const createdUserIds: string[] = [];

async function freshUser(): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `account-round-trip-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	return user.id;
}

async function account(
	userId: string,
	fields: { name: string; source: string; institution?: string | null; archivedAt?: Date | null }
) {
	return prisma.account.create({
		data: {
			userId,
			currency: 'EUR',
			exponent: 2,
			nameKey: computeNameKey(fields.name),
			...fields
		},
		select: { id: true }
	});
}

type BackupFile = { accounts: Record<string, unknown>[] } & Record<string, unknown>;

/** The user's data as the downloaded file, before any upload. */
async function exportedFile(userId: string): Promise<BackupFile> {
	return JSON.parse(JSON.stringify(await buildBackupExport(userId)));
}

async function restore(userId: string, file: BackupFile): Promise<void> {
	await restoreBackup(userId, backupExportSchema.parse(file));
}

async function restoredAccounts(userId: string) {
	return prisma.account.findMany({
		where: { userId },
		select: { name: true, source: true, institution: true, archivedAt: true }
	});
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET ??= 'c7'.repeat(32);
});

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

describe('an account through a backup', () => {
	it('comes back archived, at the same instant, and out of the import picker', async () => {
		// SEPARATES « archivedAt is carried » FROM « the restore writes the column default », which
		// is null and puts the account back among the import destinations it had left.
		const userId = await freshUser();
		const archivedAt = new Date(Date.UTC(2026, 3, 7, 9, 30, 15, 250));
		await account(userId, { name: 'Ancien compte', source: 'csv' });
		expect(
			accountsForPicker(await restoredAccounts(userId)),
			'calibration: an unarchived csv account is a destination'
		).toHaveLength(1);
		await prisma.account.updateMany({ where: { userId }, data: { archivedAt } });

		await restore(userId, await exportedFile(userId));

		const [restored] = await restoredAccounts(userId);
		expect(restored.archivedAt?.toISOString()).toBe(archivedAt.toISOString());
		expect(accountsForPicker([restored])).toHaveLength(0);
	});

	it('keeps the name a member gave a bank account through a restore and the next backfill', async () => {
		// SEPARATES « institution is carried » FROM « restored as null », where the boot backfill
		// selects the bucket again and renames it to the bank's name, since that name is free.
		const userId = await freshUser();
		await account(userId, { name: 'Joint Revolut', source: 'revolut', institution: 'Revolut' });

		await restore(userId, await exportedFile(userId));
		await runStatementAccountBackfill({ prisma });

		const [restored] = await restoredAccounts(userId);
		expect({ name: restored.name, institution: restored.institution }).toEqual({
			name: 'Joint Revolut',
			institution: 'Revolut'
		});
	});

	it('restores a file written before these fields with both left empty', async () => {
		// A backup downloaded from an older install has neither key. It must still restore.
		const userId = await freshUser();
		await account(userId, {
			name: 'Banque Populaire',
			source: 'banque_populaire',
			institution: 'Banque Populaire',
			archivedAt: new Date(Date.UTC(2026, 0, 2))
		});
		const file = await exportedFile(userId);
		for (const row of file.accounts) {
			delete row.archivedAt;
			delete row.institution;
		}

		await restore(userId, file);

		const [restored] = await restoredAccounts(userId);
		expect({ institution: restored.institution, archivedAt: restored.archivedAt }).toEqual({
			institution: null,
			archivedAt: null
		});
	});

	it('stores no institution the account source does not name', async () => {
		// Every writer derives `institution` from `institutionForSource(source)` or writes null, so
		// a file pairing another value with a source is hand edited. SEPARATES « the restore keeps
		// only the derived value » FROM « it stores whatever the file says ». One row per source
		// kind: a source naming no bank, and a bank's source naming another value.
		const userId = await freshUser();
		await account(userId, { name: 'Compte manuel', source: 'csv' });
		await account(userId, { name: 'Revolut', source: 'revolut', institution: 'Revolut' });
		const file = await exportedFile(userId);
		for (const row of file.accounts) {
			row.institution = row.source === 'csv' ? 'Revolut' : 'Autre banque';
		}

		await restore(userId, file);

		const bySource = Object.fromEntries(
			(await restoredAccounts(userId)).map((row) => [row.source, row.institution])
		);
		expect(bySource).toEqual({ csv: null, revolut: null });
	});
});
