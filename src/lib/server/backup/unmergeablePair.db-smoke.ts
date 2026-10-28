import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { MAX_ACCOUNT_NAME_LENGTH } from '$lib/domain/account';
import { buildBackupExport } from './export';
import { restoreBackup } from './import';
import type { BackupExport } from './schema';

/**
 * #1090: a restore must not fold two file accounts whose names share a key.
 *
 * The seeded pair is the state the concurrent-rename race leaves (#1089, measured 40 of 40 on
 * SQLite): two accounts of one source whose names differ only by case. The seed writes it
 * directly because the race is the route and is measured there; this suite measures what the
 * RESTORE does with a file holding it. Measured before the fix: the currency pair came back as
 * one EUR account holding `1000 EUR, 500 USD`, the linked pair as one unlinked account.
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

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

interface SeedAccount {
	name: string;
	currency: string;
	linked: boolean;
	amount: bigint;
}

async function seed(accounts: SeedAccount[]) {
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
	for (const [i, a] of accounts.entries()) {
		const account = await prisma.account.create({
			data: {
				userId,
				name: a.name,
				nameKey: computeNameKey(a.name),
				source: 'csv',
				currency: a.currency,
				exponent: 2,
				netWorthAccountId: a.linked ? netWorth.id : null
			},
			select: { id: true }
		});
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
	return userId;
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
	const rows = await prisma.account.findMany({
		where: { userId },
		select: { name: true, nameKey: true }
	});
	return rows;
}

async function roundTrip(userId: string) {
	await restoreBackup(userId, (await buildBackupExport(userId)) as BackupExport);
}

const LIVRET = { name: 'Livret', currency: 'EUR', linked: false, amount: 1000n };

describe('a restore and two file accounts whose names share a key (#1090)', () => {
	it('keeps two accounts of different currencies apart, each holding its own rows', async () => {
		// SEPARATES « the restore keeps the pair » FROM « it files USD rows under the EUR account ».
		const userId = await seed([
			LIVRET,
			{ name: 'LIVRET', currency: 'USD', linked: false, amount: 500n }
		]);
		const before = await holdings(userId);
		expect(before).toHaveLength(2);

		await roundTrip(userId);

		expect(await holdings(userId)).toStrictEqual(before);
	});

	it('keeps two accounts apart when only one is linked to net worth, keeping the link', async () => {
		// SEPARATES « the link survives with its own rows » FROM « the second account's link is
		// dropped and its rows land on the unlinked first one ».
		const userId = await seed([
			LIVRET,
			{ name: 'LIVRET', currency: 'EUR', linked: true, amount: 500n }
		]);
		const before = await holdings(userId);
		expect(before).toHaveLength(2);

		await roundTrip(userId);

		expect(await holdings(userId)).toStrictEqual(before);
	});

	it('restores the second under a suffixed name, so no two accounts share a key', async () => {
		// SEPARATES « two accounts, two keys » FROM « two accounts recreated under one key », the
		// state the app's own writers refuse (persist.ts resolves by key).
		const userId = await seed([
			LIVRET,
			{ name: 'LIVRET', currency: 'USD', linked: false, amount: 500n }
		]);

		await roundTrip(userId);

		const restored = await names(userId);
		expect(restored).toHaveLength(2);
		expect(new Set(restored.map((row) => row.nameKey)).size).toBe(2);
		const [bare, suffixed] = ['Livret', 'LIVRET'].includes(restored[0].name)
			? [restored[0], restored[1]]
			: [restored[1], restored[0]];
		expect(['Livret', 'LIVRET']).toContain(bare.name);
		expect(suffixed.name).toMatch(/^(Livret|LIVRET) · [0-9a-f]+$/);
		expect(suffixed.name.startsWith(bare.name)).toBe(false);
	});

	it('suffixes again when a later file account already holds the suffixed name', async () => {
		// SEPARATES « a generated name registers its own key » FROM « only file names are tracked »,
		// where the third create hits @@unique([userId, name, source]) and aborts the restore.
		const userId = await seed([
			LIVRET,
			{ name: 'LIVRET', currency: 'USD', linked: false, amount: 500n }
		]);
		const file = (await buildBackupExport(userId)) as BackupExport;
		await restoreBackup(userId, file);
		const generated = (await names(userId)).find((row) => row.name.includes(' · '))!.name;
		const third = { ...file.accounts[0], id: 'third-account', name: generated };

		for (const accounts of [
			[...file.accounts, third],
			[third, ...file.accounts]
		]) {
			await restoreBackup(userId, { ...file, accounts });

			const restored = await names(userId);
			expect(restored).toHaveLength(3);
			expect(new Set(restored.map((row) => row.nameKey)).size).toBe(3);
		}
	});

	it('cuts a long name by characters so the suffixed name fits and keeps whole characters', async () => {
		// SEPARATES « cut on code points » FROM « cut on UTF-16 units », and FROM « no cut », which
		// exceeds the name cap. A unit cut leaves a lone surrogate, which the driver stores as U+FFFD,
		// so the name reads back well formed: the assertion is on what the base IS, emoji only. Two
		// pairs, one shifted by a one-unit « x », so a unit cut lands mid-pair in one of them
		// whatever the length of the suffix (`hashFingerprint` is not zero padded).
		const long = '🏦'.repeat(MAX_ACCOUNT_NAME_LENGTH - 1);
		const userId = await seed([
			{ ...LIVRET, name: `${long}A` },
			{ name: `${long}a`, currency: 'USD', linked: false, amount: 500n },
			{ ...LIVRET, name: `x${long}A`, amount: 700n },
			{ name: `x${long}a`, currency: 'USD', linked: false, amount: 300n }
		]);

		await roundTrip(userId);

		const restored = await names(userId);
		expect(restored).toHaveLength(4);
		const suffixed = restored.filter((row) => row.name.includes(' · ')).map((row) => row.name);
		expect(suffixed).toHaveLength(2);
		for (const name of suffixed) {
			expect(Array.from(name).length).toBeLessThanOrEqual(MAX_ACCOUNT_NAME_LENGTH);
			expect(name).toMatch(/^x?(?:🏦)+ · [0-9a-f]+$/u);
		}
		expect(new Set(restored.map((row) => row.nameKey)).size).toBe(4);
	});
});
