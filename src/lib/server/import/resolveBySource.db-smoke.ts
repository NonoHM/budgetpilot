import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { GENERIC_BUCKET_STORED_NAME } from '$lib/domain/account';
import { findImportBucketAccountBySource, resolveImportBucketAccountBySource } from './persist';

/**
 * The AUTO path's destination, now that no bucket can be found by the name it used to carry.
 *
 * `/import` imports a recognised file without showing the designation screen, so there is no
 * account row to ask with. It used to resolve `(name: 'Compte import CSV', source)`, and the boot
 * backfill has since renamed the two buckets it can name: MEASURED on this branch, that lookup came
 * back empty, reported `created=true`, and produced `buckets=2` for one user's Banque Populaire
 * history. This function is what replaces it, and the tests below are the proof it cannot repeat.
 *
 * Against a real engine rather than a fake, for the reason `resolveByChosenId.db-smoke.ts` gives at
 * length: a hand-written mock decides what `findMany` returns, so « the query was scoped by userId »
 * and « the fake had nothing to return » are the same green.
 */

let mine = '';
let other = '';

beforeEach(async () => {
	const stamp = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
	const a = await prisma.user.create({
		data: { email: `src-mine-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const b = await prisma.user.create({
		data: { email: `src-other-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	mine = a.id;
	other = b.id;
});

function makeAccount(userId: string, name: string, source: string, archived = false) {
	return prisma.account.create({
		data: {
			userId,
			name,
			source,
			currency: 'EUR',
			exponent: 2,
			archivedAt: archived ? new Date('2026-01-01T00:00:00.000Z') : null
		},
		select: { id: true }
	});
}

describe('resolving the auto path’s destination by source', () => {
	it('uses the one account of that source, and creates nothing', async () => {
		// SEPARATES: « an existing bucket is reused » FROM « a second one is made beside it ». This
		// is the exact assertion the measured defect fails, and every install today is this case:
		// one bucket per source, whatever it is now named.
		expect.assertions(3);
		const existing = await makeAccount(mine, 'Banque Populaire', 'banque_populaire');
		const resolution = await resolveImportBucketAccountBySource({
			userId: mine,
			source: 'banque_populaire'
		});
		expect(resolution.kind).toBe('resolved');
		expect(resolution.kind === 'resolved' && resolution.bucket.accountId).toBe(existing.id);
		expect(await prisma.account.count({ where: { userId: mine } })).toBe(1);
	});

	it('creates the first bucket under the institution’s own name, not a machine name', async () => {
		// SEPARATES: « a new bucket is born correctly named » FROM « it is born as 'Compte import
		// CSV' and waits for a backfill to rename it ». The second reintroduces the defect this
		// piece removes, one account at a time, for every user who imports a new bank tomorrow.
		expect.assertions(2);
		const resolution = await resolveImportBucketAccountBySource({
			userId: mine,
			source: 'revolut'
		});
		expect(resolution.kind).toBe('resolved');
		const created = await prisma.account.findFirstOrThrow({ where: { userId: mine } });
		expect(created.name).toBe('Revolut');
	});

	it('creates the generic bucket under its STORED name, which is a key and not a sentence', async () => {
		// SEPARATES: « the generic bucket keeps the stored key » FROM « it is given a translated
		// display string ». A localised string in this column orphans every transaction of a user
		// whose locale changes, which is the measured instance behind the constant's docstring.
		expect.assertions(2);
		await resolveImportBucketAccountBySource({ userId: mine, source: 'csv' });
		const created = await prisma.account.findFirstOrThrow({ where: { userId: mine } });
		expect(created.name).toBe(GENERIC_BUCKET_STORED_NAME);
		expect(created.source).toBe('csv');
	});

	it('refuses to choose when the user has two accounts of that source, and writes nothing', async () => {
		// SEPARATES: « the ambiguity is handed back to be resolved by a human » FROM « the first row
		// wins ». Picking one is how a statement silently lands in the wrong account, and it is the
		// state this entire piece exists to make impossible. Creating a THIRD would be worse still.
		expect.assertions(2);
		await makeAccount(mine, 'BP · Compte courant', 'banque_populaire');
		await makeAccount(mine, 'BP · Livret A', 'banque_populaire');
		const resolution = await resolveImportBucketAccountBySource({
			userId: mine,
			source: 'banque_populaire'
		});
		expect(resolution.kind).toBe('ambiguous');
		expect(await prisma.account.count({ where: { userId: mine } })).toBe(2);
	});

	it('cannot see another user’s account of the same source', async () => {
		// SEPARATES: « the query named userId » FROM « it matched on source alone ». Source is not a
		// secret and every user of one bank shares it, so an unscoped query here would resolve onto
		// somebody else's account and file a statement into it. Only a real engine holds that row.
		expect.assertions(2);
		await makeAccount(other, 'Leur BP', 'banque_populaire');
		const resolution = await resolveImportBucketAccountBySource({
			userId: mine,
			source: 'banque_populaire'
		});
		expect(resolution.kind).toBe('resolved');
		expect(await prisma.account.count({ where: { userId: other } })).toBe(1);
	});

	it('does not count an archived account as a candidate', async () => {
		// SEPARATES: « archived means retired as a destination » FROM « archived means hidden from
		// the panel only ». An archived account still holds its past imports; what it must not do is
		// receive new ones behind the user's back on a path that shows them nothing.
		expect.assertions(2);
		const archived = await makeAccount(mine, 'Vieux BP', 'banque_populaire', true);
		const resolution = await resolveImportBucketAccountBySource({
			userId: mine,
			source: 'banque_populaire'
		});
		expect(resolution.kind).toBe('resolved');
		expect(resolution.kind === 'resolved' && resolution.bucket.accountId).not.toBe(archived.id);
	});

	it('hands back WHICH accounts are ambiguous, not only that they are', async () => {
		// SEPARATES: « the caller can check a file-named account against the accounts of THIS
		// source » FROM « the caller is told a count exceeded one and nothing else ». Without the
		// list, the auto path's rank 1 short-circuit would accept an account of a DIFFERENT bank
		// that happens to hold the same four-character fragment, and file a Banque Populaire
		// statement into a Revolut account with full confidence. The Revolut row below is what
		// makes that failure observable rather than argued.
		expect.assertions(3);
		const courant = await makeAccount(mine, 'BP · Compte courant', 'banque_populaire');
		const livret = await makeAccount(mine, 'BP · Livret A', 'banque_populaire');
		await makeAccount(mine, 'Revolut', 'revolut');
		const archived = await makeAccount(mine, 'Vieux BP', 'banque_populaire', true);

		const lookup = await findImportBucketAccountBySource({
			userId: mine,
			source: 'banque_populaire'
		});

		expect(lookup.kind).toBe('ambiguous');
		const ids = lookup.kind === 'ambiguous' ? lookup.candidates.map((c) => c.accountId) : [];
		expect([...ids].sort()).toEqual([courant.id, livret.id].sort());
		// Stated positively as well as by absence: an archived account is not a candidate here for
		// the same reason it is not one above, and an empty list would satisfy the line above alone.
		expect(ids).not.toContain(archived.id);
	});
});
