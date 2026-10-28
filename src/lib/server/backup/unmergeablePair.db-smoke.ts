import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { MAX_ACCOUNT_NAME_LENGTH } from '$lib/domain/account';
import { buildBackupExport } from './export';
import { restoreBackup } from './import';
import { backupExportSchema, type BackupExport } from './schema';

/**
 * #1090: a restore must not fold two file accounts whose names share a key.
 *
 * The pair is the state the concurrent-rename race leaves (#1089, measured 40 of 40 on SQLite):
 * two accounts of one source whose names differ only by case. Measured before the fix: the
 * currency pair came back as one EUR account holding `1000 EUR, 500 USD`, the linked pair as one
 * unlinked account.
 *
 * The NAMES ARE WRITTEN INTO THE FILE, not into the seed. MySQL's collation refuses « Livret » and
 * « LIVRET » under `@@unique([userId, name, source])`, so the pair cannot be seeded there; a file
 * exported from SQLite or PostgreSQL carries it onto any engine, and that is the route this suite
 * takes on all three. See vitest.db.config.ts for how to run this.
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

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

interface SeedAccount {
	/** The name the FILE carries. The database row is seeded under a distinct placeholder. */
	name: string;
	currency: string;
	linked: boolean;
	amount: bigint;
	source?: string;
}

/** Seeds the accounts and returns the user and the file whose accounts carry the given names. */
async function seed(accounts: SeedAccount[]): Promise<{ userId: string; file: BackupExport }> {
	const user = await prisma.user.create({
		data: {
			email: `pair-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	const userId = user.id;
	const category = await prisma.category.create({
		data: { userId, name: 'Divers', nameKey: computeNameKey('Divers') },
		select: { id: true }
	});
	const netWorth = await prisma.netWorthAccount.create({
		data: {
			userId,
			name: 'Livret A',
			nameKey: computeNameKey('Livret A'),
			type: 'savings',
			balanceCents: 0n,
			currency: 'EUR',
			exponent: 2
		},
		select: { id: true }
	});
	const fileName = new Map<string, string>();
	for (const [i, a] of accounts.entries()) {
		const placeholder = `Seed ${i}`;
		const account = await prisma.account.create({
			data: {
				userId,
				name: placeholder,
				nameKey: computeNameKey(placeholder),
				source: a.source ?? 'csv',
				currency: a.currency,
				exponent: 2,
				netWorthAccountId: a.linked ? netWorth.id : null
			},
			select: { id: true }
		});
		fileName.set(account.id, a.name);
		await prisma.transaction.create({
			data: {
				userId,
				accountId: account.id,
				categoryId: category.id,
				date: new Date(Date.UTC(2026, 0, 10 + i)),
				label: `Row ${i}`,
				amountCents: a.amount,
				currency: a.currency,
				exponent: 2,
				source: 'csv'
			}
		});
	}
	const exported = (await buildBackupExport(userId)) as BackupExport;
	// Parsed, so no fixture here can hold a file the restore route would refuse. In SEED order,
	// because the export has no orderBy and which account keeps the bare name follows file order.
	const order = [...fileName.keys()];
	const file = backupExportSchema.parse({
		...exported,
		accounts: exported.accounts
			.map((row) => ({ ...row, name: fileName.get(row.id)! }))
			.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
	});
	return { userId, file };
}

/** Each account by what it holds, sorted on its rows, which are distinct per seeded account. */
async function holdings(userId: string) {
	const rows = await prisma.account.findMany({
		where: { userId },
		select: {
			currency: true,
			netWorthAccountId: true,
			transactions: { select: { amountCents: true, currency: true } }
		}
	});
	return rows
		.map((row) => ({
			currency: row.currency,
			linked: row.netWorthAccountId !== null,
			transactions: row.transactions
				.map((t) => `${t.amountCents} ${t.currency}`)
				.sort()
				.join(', ')
		}))
		.sort((a, b) => a.transactions.localeCompare(b.transactions));
}

async function names(userId: string) {
	return prisma.account.findMany({ where: { userId }, select: { name: true, nameKey: true } });
}

const LIVRET = { name: 'Livret', currency: 'EUR', linked: false, amount: 1000n };
const LIVRET_USD = { name: 'LIVRET', currency: 'USD', linked: false, amount: 500n };

describe('a restore and two file accounts whose names share a key (#1090)', () => {
	it('keeps two accounts of different currencies apart, each holding its own rows', async () => {
		// SEPARATES « the restore keeps the pair » FROM « it files USD rows under the EUR account ».
		const { userId, file } = await seed([LIVRET, LIVRET_USD]);
		const before = await holdings(userId);
		expect(before).toHaveLength(2);

		await restoreBackup(userId, file);

		expect(await holdings(userId)).toStrictEqual(before);
	});

	it('keeps two accounts apart when only one is linked to net worth, keeping the link', async () => {
		// SEPARATES « the link survives with its own rows » FROM « the second account's link is
		// dropped and its rows land on the unlinked first one ».
		const { userId, file } = await seed([
			LIVRET,
			{ name: 'LIVRET', currency: 'EUR', linked: true, amount: 500n }
		]);
		const before = await holdings(userId);
		expect(before).toHaveLength(2);

		await restoreBackup(userId, file);

		expect(await holdings(userId)).toStrictEqual(before);
	});

	it('restores the second under a suffixed name, so no two accounts share a key', async () => {
		// SEPARATES « two accounts, two keys » FROM « two accounts recreated under one key », the
		// state the app's own writers refuse (persist.ts resolves by key).
		const { userId, file } = await seed([LIVRET, LIVRET_USD]);

		await restoreBackup(userId, file);

		const restored = await names(userId);
		expect(restored.map((row) => row.name)).toContain('Livret');
		expect(restored.find((row) => row.name !== 'Livret')!.name).toMatch(/^LIVRET · [0-9a-f]+$/);
		expect(new Set(restored.map((row) => row.nameKey)).size).toBe(2);
	});

	it('gives the same names when the same file is restored twice', async () => {
		// SEPARATES « the suffix is a function of the file » FROM « it reads a clock or a random
		// source », which would rename the account on every restore of one backup.
		const { userId, file } = await seed([LIVRET, LIVRET_USD]);

		await restoreBackup(userId, file);
		const first = (await names(userId)).map((row) => row.name).sort();
		await restoreBackup(userId, file);

		expect((await names(userId)).map((row) => row.name).sort()).toStrictEqual(first);
	});

	it('keeps both bare names when the two accounts come from different imports', async () => {
		// SEPARATES « a key is taken per source » FROM « per user », which would suffix a CSV
		// « Livret » for sitting beside a Revolut « LIVRET ». Per source, as persist.ts resolves.
		const { userId, file } = await seed([LIVRET, { ...LIVRET_USD, source: 'revolut' }]);

		await restoreBackup(userId, file);

		expect((await names(userId)).map((row) => row.name).sort()).toStrictEqual(['LIVRET', 'Livret']);
	});

	it('suffixes again when a later file account already holds the suffixed name', async () => {
		// SEPARATES « a generated name registers its own key » FROM « only file names are tracked »,
		// where the third create hits @@unique([userId, name, source]) and aborts the restore, and
		// FROM « the next candidate is built from the previous one » (« X · h0 · h1 »).
		const { userId, file } = await seed([LIVRET, LIVRET_USD]);
		await restoreBackup(userId, file);
		const generated = (await names(userId)).find((row) => row.name.includes(' · '))!.name;
		// Pinned to EUR so the USD account, the one that is suffixed, can be found by currency.
		const third = {
			...file.accounts[0],
			id: 'third-account',
			name: generated,
			currency: 'EUR',
			exponent: 2
		};

		for (const accounts of [
			[...file.accounts, third],
			[third, ...file.accounts]
		]) {
			await restoreBackup(userId, { ...file, accounts });

			const restored = await names(userId);
			expect(restored).toHaveLength(3);
			expect(new Set(restored.map((row) => row.nameKey)).size).toBe(3);
			const usd = await prisma.account.findFirstOrThrow({
				where: { userId, currency: 'USD' },
				select: { name: true }
			});
			expect(usd.name).toMatch(/^LIVRET · [0-9a-f]+$/);
		}
	});

	it('cuts a long name by characters so the suffixed name fits and keeps whole characters', async () => {
		// SEPARATES « cut on code points » FROM « cut on UTF-16 units », and FROM « no cut », which
		// exceeds the name cap. The name is 70 emoji then ASCII: 120 code points in 190 units,
		// inside the file's 200-unit bound. A code-point cut keeps all 70 emoji; a unit cut keeps at
		// most 112 units, so at most 56 of them, whatever the suffix length (`hashFingerprint` is not
		// zero padded). Asserted on what the base IS, because a lone surrogate reads back as U+FFFD.
		const long = `${'🏦'.repeat(70)}${'b'.repeat(MAX_ACCOUNT_NAME_LENGTH - 71)}`;
		const { userId, file } = await seed([
			{ ...LIVRET, name: `${long}A` },
			{ ...LIVRET_USD, name: `${long}a` }
		]);

		await restoreBackup(userId, file);

		const restored = await names(userId);
		expect(restored).toHaveLength(2);
		const suffixed = restored.find((row) => row.name.includes(' · '))!.name;
		expect(Array.from(suffixed).length).toBeLessThanOrEqual(MAX_ACCOUNT_NAME_LENGTH);
		expect(suffixed.startsWith('🏦'.repeat(70))).toBe(true);
		expect(suffixed).toMatch(/^(?:🏦)+b* · [0-9a-f]+$/u);
		expect(new Set(restored.map((row) => row.nameKey)).size).toBe(2);
	});
});
