import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { hashFingerprint } from '$lib/server/import/utils/safety';
import { resolveImportBucketAccount, resolveImportBucketAccountBySource } from './persist';

/**
 * #1104. On MySQL and MariaDB the `userId_name_source` unique index compares `Account.name` under
 * `utf8mb4_unicode_ci`, which folds pairs `nameKey` keeps apart. The bucket upsert keyed on that
 * index then MATCHES another bucket instead of creating one, and reported `created: true` anyway.
 *
 * MEASURED on mariadb:11 before the fix: a second provider account named « Straße », « co₂ »,
 * « Ｒevolut » or « Livret 🐷 » next to « Strasse », « CO2 », « Revolut » or « Livret 🏦 » got the
 * first bucket's id and its provider id was never stored, so sync never fetched its rows. Every
 * character outside the BMP weighs the same under that collation, which is why the emoji pair is
 * the ordinary one. On SQLite and PostgreSQL these tests pass without the fix: the index compares
 * bytes there, so only the MySQL leg can redden them.
 */

const REFUSAL = 'Import bucket name is held by another account';

let userId = '';

beforeEach(async () => {
	const stamp = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
	const user = await prisma.user.create({
		data: { email: `coll-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	userId = user.id;
});

describe('the premise the resolver relies on', () => {
	it('an upsert matched through the index answers with the STORED name, not the requested one', async () => {
		// SEPARATES: « the returned row names itself » FROM « Prisma echoes the where clause ». The
		// resolver's detector compares the two, so if the second held it could never fire. On
		// SQLite and PostgreSQL the index compares bytes, the upsert creates, and the name is
		// the requested one: the assertion holds on every engine for its own reason.
		expect.assertions(1);
		const first = await prisma.account.create({
			data: { userId, name: 'Strasse', source: 'probe', currency: 'EUR', exponent: 2 }
		});
		const row = await prisma.account.upsert({
			where: { userId_name_source: { userId, name: 'Straße', source: 'probe' } },
			update: {},
			create: { userId, name: 'Straße', source: 'probe', currency: 'EUR', exponent: 2 }
		});
		// Matched (MySQL) must say 'Strasse'; created (SQLite, PostgreSQL) says 'Straße'.
		expect(row.name).toBe(row.id === first.id ? 'Strasse' : 'Straße');
	});
});

describe('a second provider account whose name only the collation matches', () => {
	for (const [first, second] of [
		['Strasse', 'Straße'],
		['CO2', 'co₂'],
		['Revolut', 'Ｒevolut'],
		['Livret 🏦', 'Livret 🐷']
	]) {
		it(`gets its own bucket carrying its provider id (« ${first} » then « ${second} »)`, async () => {
			// SEPARATES: « B has a bucket sync will fetch » FROM « B was answered with A's bucket ».
			expect.assertions(4);
			// The premise: these names are DIFFERENT names to the application, so the folded-name
			// lookup cannot be what joins them.
			expect(computeNameKey(first)).not.toBe(computeNameKey(second));
			const a = await resolveImportBucketAccount({
				userId,
				name: first,
				source: 'enable_banking',
				providerAccountId: 'prov-A'
			});
			const b = await resolveImportBucketAccount({
				userId,
				name: second,
				source: 'enable_banking',
				providerAccountId: 'prov-B'
			});
			expect(b.accountId).not.toBe(a.accountId);
			const bRow = await prisma.account.findUniqueOrThrow({
				where: { id: b.accountId },
				select: { providerAccountId: true }
			});
			expect(bRow.providerAccountId).toBe('prov-B');
			// And A's bucket still carries A, which a fix that relinked the matched row would break.
			const aRow = await prisma.account.findUniqueOrThrow({
				where: { id: a.accountId },
				select: { providerAccountId: true }
			});
			expect(aRow.providerAccountId).toBe('prov-A');
		});
	}
});

describe('a disambiguated name that ALSO collides never files the account into another bucket', () => {
	// Seeds a bucket whose name only the collation equates with the suffixed one. SEPARATES: « B is
	// in its own bucket, or refused » FROM « B was answered with the seeded bucket » (providerAccountId
	// null). On MySQL the first case refuses, the second re-suffixes into its own bucket (break B4
	// showed the refusal there bought nothing); on SQLite and PostgreSQL nothing collides.
	const onMysql = process.env.DATABASE_PROVIDER === 'mysql';
	for (const [label, existingName, bName, mysqlOutcome] of [
		['after a collation match', 'Strasse', 'Straße', REFUSAL],
		['after a folded-name match', 'Strasse', 'strasse', 'prov-B']
	]) {
		it(label, async () => {
			expect.assertions(1);
			await resolveImportBucketAccount({
				userId,
				name: existingName,
				source: 'enable_banking',
				providerAccountId: 'prov-A'
			});
			const suffix = hashFingerprint('prov-B');
			const seeded = `${bName === 'Straße' ? 'Strasse' : 'Straße'} · ${suffix.slice(0, 6)}`;
			await prisma.account.create({
				data: {
					userId,
					name: seeded,
					nameKey: computeNameKey(seeded),
					source: 'enable_banking',
					currency: 'EUR',
					exponent: 2
				}
			});
			const outcome = await resolveImportBucketAccount({
				userId,
				name: bName,
				source: 'enable_banking',
				providerAccountId: 'prov-B'
			}).then(
				async (b) =>
					(
						await prisma.account.findUniqueOrThrow({
							where: { id: b.accountId },
							select: { providerAccountId: true }
						})
					).providerAccountId,
				(error: Error) => error.message
			);
			// One outcome per engine, so a change between refusing and re-suffixing reddens.
			expect(outcome).toBe(onMysql ? mysqlOutcome : 'prov-B');
		});
	}
});

describe('a bucket already holding the exact disambiguated name, on every engine', () => {
	it('is not taken as the second provider account’s bucket', async () => {
		// SEPARATES: « B's bucket is the one carrying prov-B » FROM « B is answered with whatever row
		// holds the name it asked for ». Found by the round 1 code pass (F2): byte equality of the
		// name stood in for « this call created the row », and a renamed bucket, or two provider ids
		// sharing a 24-bit hash prefix, holds that exact name. No collation is involved, so this
		// reddens on SQLite and PostgreSQL too.
		expect.assertions(2);
		const a = await resolveImportBucketAccount({
			userId,
			name: 'Compte',
			source: 'enable_banking',
			providerAccountId: 'prov-A'
		});
		const seeded = `Compte · ${hashFingerprint('prov-B').slice(0, 6)}`;
		const squatter = await prisma.account.create({
			data: {
				userId,
				name: seeded,
				nameKey: computeNameKey(seeded),
				source: 'enable_banking',
				currency: 'EUR',
				exponent: 2
			}
		});
		const b = await resolveImportBucketAccount({
			userId,
			name: 'Compte',
			source: 'enable_banking',
			providerAccountId: 'prov-B'
		});
		expect([a.accountId, squatter.id]).not.toContain(b.accountId);
		const bRow = await prisma.account.findUniqueOrThrow({
			where: { id: b.accountId },
			select: { providerAccountId: true }
		});
		expect(bRow.providerAccountId).toBe('prov-B');
	});
});

describe('the auto path next to an archived account whose name only the collation matches', () => {
	it('hands the question back instead of filing into the archived account', async () => {
		// SEPARATES: « the archived account is refused » FROM « it receives the run, reported new ».
		expect.assertions(3);
		expect(computeNameKey('Ｒevolut')).not.toBe(computeNameKey('Revolut'));
		await prisma.account.create({
			data: {
				userId,
				name: 'Ｒevolut',
				nameKey: computeNameKey('Ｒevolut'),
				source: 'revolut',
				currency: 'EUR',
				exponent: 2,
				archivedAt: new Date('2026-01-01T00:00:00.000Z')
			}
		});
		const resolution = await resolveImportBucketAccountBySource({ userId, source: 'revolut' });
		// Engine-independent: SQLite and PostgreSQL legitimately create « Revolut » beside it, MySQL
		// cannot and must ask. Either way the destination is never the archived row.
		const destination =
			resolution.kind === 'resolved'
				? await prisma.account.findUniqueOrThrow({
						where: { id: resolution.bucket.accountId },
						select: { archivedAt: true }
					})
				: null;
		expect(destination?.archivedAt ?? null).toBeNull();
		expect(await prisma.account.count({ where: { userId, archivedAt: { not: null } } })).toBe(1);
	});
});
