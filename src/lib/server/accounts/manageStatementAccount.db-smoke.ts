import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import type { NetWorthAccountType } from '$lib/domain/netWorth';
import { accountsForList, accountsForPicker } from './projection';
import {
	AccountWriteError,
	archiveStatementAccount,
	createStatementAccount,
	linkNetWorthAccount,
	renameStatementAccount
} from './service';

/**
 * RENAME, ARCHIVE AND LINK ARE THREE NEW WRITE PATHS, AND THIS IS THE BATTERY THEY OWE.
 *
 * ## Why `db-smoke` rather than a unit spec, restated because it decides the whole file
 *
 * Every ownership assertion here separates « the statement named `userId` » from « the fake
 * returned what it was told to », and a hand-written mock produces the identical green for both:
 * Prisma treats a `where` key it does not recognise as NO FILTER, and no fake models that. Piece 3
 * of this chantier shipped exactly that green, and Task 6 shipped it again. The break-checks in
 * `/tmp` for this task confirm it a third time: removing the `userId` clause from any of the three
 * functions reddens tests HERE and nothing anywhere else.
 *
 * `nameKey` is the sharper case again. It is an app-computed hash because a collation decides what
 * equals what, and MySQL's default answers differently from SQLite's; a fake has no collation and
 * can neither confirm nor refute the duplicate-name rule.
 *
 * ## The two isolation tests Task 7 deleted are reinstated here
 *
 * Rejecting a net worth account id belonging to another user, and rejecting one of a non-linkable
 * type, were asserted on `/import`'s destination control. Task 7 removed that control and its
 * tests. The link is set HERE now, so the assertions live here, against a real engine holding a
 * real foreign row rather than against a fake that was told one exists.
 *
 * ASVS 5.0.0 `v5.0.0-8.2.2` (authorisation on every object reference) and `v5.0.0-2.2.1` (positive
 * validation against an allow list), as of the 2026-08-13 assessment of commit `d9c116c`: verified
 * by attack rather than by inspection.
 */

let mine = '';
let other = '';
let myNetWorth = '';
let foreignNetWorth = '';
let myHouse = '';

async function makeNetWorthAccount(
	userId: string,
	name: string,
	type: NetWorthAccountType
): Promise<string> {
	const created = await prisma.netWorthAccount.create({
		data: {
			userId,
			name,
			nameKey: computeNameKey(name),
			type,
			balanceCents: 0n,
			currency: 'EUR',
			exponent: 2
		},
		select: { id: true }
	});
	return created.id;
}

beforeAll(async () => {
	const stamp = Date.now();
	const a = await prisma.user.create({
		data: { email: `manage-mine-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const b = await prisma.user.create({
		data: { email: `manage-other-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	mine = a.id;
	other = b.id;
	myNetWorth = await makeNetWorthAccount(mine, `Courant ${stamp}`, 'checking');
	foreignNetWorth = await makeNetWorthAccount(other, `Courant autre ${stamp}`, 'checking');
	myHouse = await makeNetWorthAccount(mine, `Maison ${stamp}`, 'real_estate');
});

/** A fresh account of this user, named uniquely so the tests never collide on the name rule. */
async function freshAccount(userId: string, label: string): Promise<string> {
	const created = await createStatementAccount({ userId, name: `${label} ${Date.now()}` });
	return created.id;
}

async function refusalOf(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (caught) {
		expect(caught).toBeInstanceOf(AccountWriteError);
		return (caught as AccountWriteError).reason;
	}
	throw new Error('the call was expected to be refused and returned instead');
}

describe('renaming an account', () => {
	it('writes the name AND the folded key, so the next comparison agrees with this one', async () => {
		// SEPARATES: « the rename kept the key in step with the name » FROM « it wrote the name
		// alone ». A stale key is invisible on screen and decides every later uniqueness question,
		// so the row would keep answering « taken » for the name it no longer has, and « free » for
		// the one it does. It is also what makes the invitation self-clearing.
		expect.assertions(3);
		const id = await freshAccount(mine, 'Avant');
		await renameStatementAccount({ userId: mine, accountId: id, name: 'Livret bleu' });
		const row = await prisma.account.findFirstOrThrow({ where: { id, userId: mine } });
		expect(row.name).toBe('Livret bleu');
		expect(row.nameKey).toBe(computeNameKey('Livret bleu'));
		// The calibration: a rename that silently did nothing would also leave a readable row.
		expect(row.updatedAt).toBeInstanceOf(Date);
	});

	it("refuses to rename another user's account, identically to one that does not exist", async () => {
		// SEPARATES: « the update named `userId` » FROM « it resolved the id and checked after, or
		// not at all ». Both refusals must be the SAME reason, or the response is an oracle telling
		// an attacker whether an id they guessed belongs to somebody.
		expect.assertions(5);
		const theirs = await freshAccount(other, 'Leur compte');
		expect(
			await refusalOf(() =>
				renameStatementAccount({ userId: mine, accountId: theirs, name: 'Pris' })
			)
		).toBe('not-found');
		expect(
			await refusalOf(() =>
				renameStatementAccount({ userId: mine, accountId: 'acc-does-not-exist', name: 'Pris' })
			)
		).toBe('not-found');
		// The attack's own calibration: the row is untouched, so the refusal is a refusal rather
		// than a write that happened to report an error afterwards.
		const row = await prisma.account.findFirstOrThrow({ where: { id: theirs } });
		expect(row.name).not.toBe('Pris');
	});

	it('refuses a name this user already holds, folded the way every other name is folded', async () => {
		// SEPARATES: « compared through `computeNameKey` » FROM « compared as two strings ». The
		// two differ on exactly this input: « LIVRET a » and « Livret A » are one name to the folding
		// and two to a binary collation, and the engine running this file decides which.
		expect.assertions(2);
		const stamp = Date.now();
		await createStatementAccount({ userId: mine, name: `Livret A ${stamp}` });
		const id = await freshAccount(mine, 'Autre');
		expect(
			await refusalOf(() =>
				renameStatementAccount({ userId: mine, accountId: id, name: `LIVRET a ${stamp}` })
			)
		).toBe('name-taken');
	});

	it('lets an account keep its own name, which is not a collision', async () => {
		// SEPARATES: « the uniqueness check excludes the row being renamed » FROM « it compares
		// against every row including this one ». Without the exclusion, correcting the casing of an
		// account's own name is refused as a duplicate of itself, which reads as a bug in the field.
		expect.assertions(2);
		const id = await freshAccount(mine, 'Idempotent');
		const before = await prisma.account.findFirstOrThrow({ where: { id } });
		await renameStatementAccount({ userId: mine, accountId: id, name: before.name });
		const after = await prisma.account.findFirstOrThrow({ where: { id } });
		expect(after.name).toBe(before.name);
		expect(after.nameKey).toBe(before.nameKey);
	});

	it('refuses an empty name and one past the cap, in code points', async () => {
		expect.assertions(4);
		const id = await freshAccount(mine, 'Bornes');
		expect(
			await refusalOf(() => renameStatementAccount({ userId: mine, accountId: id, name: '   ' }))
		).toBe('name-required');
		// 121 astral code points: 242 UTF-16 units, and the count that matters is the one the person
		// typing sees.
		expect(
			await refusalOf(() =>
				renameStatementAccount({ userId: mine, accountId: id, name: '🙂'.repeat(121) })
			)
		).toBe('name-too-long');
	});

	it('writes the name and NOTHING a request could have posted beside it', async () => {
		// SEPARATES: « rename writes one column plus its key » FROM « rename writes what it is
		// handed ». Mass assignment is the category and a one-field form is where nobody looks for
		// it: `source` decides whether the row is a destination at all, `discriminant` is what rank 1
		// treats as certain, `netWorthAccountId` reaches the patrimoine figures and `archivedAt`
		// decides whether the account is offered. None of them is a name.
		expect.assertions(5);
		const created = await createStatementAccount({
			userId: mine,
			name: `Intacte ${Date.now()}`,
			discriminant: '4417'
		});
		await linkNetWorthAccount({
			userId: mine,
			accountId: created.id,
			netWorthAccountId: myNetWorth
		});
		const before = await prisma.account.findFirstOrThrow({ where: { id: created.id } });
		await renameStatementAccount({
			userId: mine,
			accountId: created.id,
			name: `Renommée ${Date.now()}`
		});
		const after = await prisma.account.findFirstOrThrow({ where: { id: created.id } });
		expect(after.source).toBe(before.source);
		expect(after.discriminant).toBe(before.discriminant);
		expect(after.netWorthAccountId).toBe(before.netWorthAccountId);
		expect(after.archivedAt).toBe(before.archivedAt);
		expect(after.institution).toBe(before.institution);
	});
});

describe('archiving an account', () => {
	it('touches no transaction and leaves every row readable', async () => {
		// SEPARATES: « archiving is a fact about the ACCOUNT » FROM « archiving is a soft delete of
		// its history ». The user's money must still be on their screens afterwards; only the
		// destination list changes.
		expect.assertions(4);
		const id = await freshAccount(mine, 'Avec historique');
		const category = await prisma.category.create({
			data: {
				userId: mine,
				name: `Courses ${Date.now()}`,
				nameKey: computeNameKey(`c${Date.now()}`)
			},
			select: { id: true }
		});
		for (const label of ['A', 'B', 'C']) {
			await prisma.transaction.create({
				data: {
					userId: mine,
					accountId: id,
					categoryId: category.id,
					date: new Date('2026-07-01T00:00:00.000Z'),
					label,
					amountCents: -1000n,
					currency: 'EUR',
					exponent: 2,
					type: 'expense',
					source: 'csv'
				}
			});
		}
		// The calibration, and it is what makes the figure below mean anything: the account holds
		// rows to begin with. Three before and three after with zero before would be the same green.
		const before = await prisma.transaction.count({ where: { accountId: id } });
		expect(before).toBe(3);
		await archiveStatementAccount({ userId: mine, accountId: id });
		expect(await prisma.transaction.count({ where: { accountId: id } })).toBe(3);
		const row = await prisma.account.findFirstOrThrow({ where: { id } });
		expect(row.archivedAt).toBeInstanceOf(Date);
		expect(row.name).toBeTruthy();
	});

	it('drops the account out of the picker and keeps it on the management list', async () => {
		// SEPARATES: « the two projections disagree exactly on archived » FROM « archiving hides the
		// account everywhere ». A user who archived by mistake needs a screen on which to see it,
		// and the picker is the one screen that must not offer it.
		expect.assertions(2);
		const id = await freshAccount(mine, 'Rangée');
		await archiveStatementAccount({ userId: mine, accountId: id });
		const rows = await prisma.account.findMany({ where: { userId: mine } });
		expect(accountsForPicker(rows).map((account) => account.id)).not.toContain(id);
		expect(accountsForList(rows).map((account) => account.id)).toContain(id);
	});

	it("refuses to archive another user's account, identically to one that does not exist", async () => {
		expect.assertions(5);
		const theirs = await freshAccount(other, 'Leur autre compte');
		expect(
			await refusalOf(() => archiveStatementAccount({ userId: mine, accountId: theirs }))
		).toBe('not-found');
		expect(
			await refusalOf(() =>
				archiveStatementAccount({ userId: mine, accountId: 'acc-does-not-exist' })
			)
		).toBe('not-found');
		expect(
			(await prisma.account.findFirstOrThrow({ where: { id: theirs } })).archivedAt
		).toBeNull();
	});

	it('restores an archived account back into the picker', async () => {
		// SEPARATES: « archiving is reversible » FROM « archiving is a delete with a softer name ».
		// The screen offers the reverse, so the service has to.
		expect.assertions(2);
		const id = await freshAccount(mine, 'Aller-retour');
		await archiveStatementAccount({ userId: mine, accountId: id });
		await archiveStatementAccount({ userId: mine, accountId: id, archived: false });
		const rows = await prisma.account.findMany({ where: { userId: mine } });
		expect((await prisma.account.findFirstOrThrow({ where: { id } })).archivedAt).toBeNull();
		expect(accountsForPicker(rows).map((account) => account.id)).toContain(id);
	});
});

describe('linking an account to a net worth line', () => {
	it('sets the link, which is the thing Task 7 took off the import path', async () => {
		expect.assertions(2);
		const id = await freshAccount(mine, 'Reliée');
		await linkNetWorthAccount({ userId: mine, accountId: id, netWorthAccountId: myNetWorth });
		const row = await prisma.account.findFirstOrThrow({ where: { id } });
		expect(row.netWorthAccountId).toBe(myNetWorth);
		// And it can be undone, which the import path could not: the link was create-only there.
		await linkNetWorthAccount({ userId: mine, accountId: id, netWorthAccountId: null });
		expect((await prisma.account.findFirstOrThrow({ where: { id } })).netWorthAccountId).toBeNull();
	});

	// REINSTATED FROM TASK 7. This assertion lived on `/import`'s destination control and was
	// deleted with it. Same claim, new site, and a stronger one: the foreign row really exists here.
	it('refuses a net worth account belonging to another user, without writing', async () => {
		// SEPARATES: « the net worth lookup named `userId` » FROM « it took the posted id on trust ».
		// A link to somebody else's line is a cross-user write into the patrimoine figures, and it
		// is the shape a client-supplied foreign key always has.
		expect.assertions(3);
		const id = await freshAccount(mine, 'Convoitée');
		expect(
			await refusalOf(() =>
				linkNetWorthAccount({ userId: mine, accountId: id, netWorthAccountId: foreignNetWorth })
			)
		).toBe('net-worth-not-found');
		expect((await prisma.account.findFirstOrThrow({ where: { id } })).netWorthAccountId).toBeNull();
	});

	// REINSTATED FROM TASK 7, second of the two.
	it('refuses a net worth account of a type that cannot be linked', async () => {
		// SEPARATES: « the type is validated against the linkable set » FROM « any row of this user
		// is accepted ». A house is not a cash line, and filing a statement's transactions against
		// one would put spending into an asset's balance.
		expect.assertions(3);
		const id = await freshAccount(mine, 'Maisonnée');
		expect(
			await refusalOf(() =>
				linkNetWorthAccount({ userId: mine, accountId: id, netWorthAccountId: myHouse })
			)
		).toBe('net-worth-not-found');
		expect((await prisma.account.findFirstOrThrow({ where: { id } })).netWorthAccountId).toBeNull();
	});

	it('refuses a net worth account id that never existed', async () => {
		expect.assertions(2);
		const id = await freshAccount(mine, 'Fantôme');
		expect(
			await refusalOf(() =>
				linkNetWorthAccount({ userId: mine, accountId: id, netWorthAccountId: 'nwa-nope' })
			)
		).toBe('net-worth-not-found');
	});

	it("refuses to link another user's account, even to a net worth line this user owns", async () => {
		// SEPARATES: « BOTH references are authorised » FROM « the net worth id is checked and the
		// account id is taken on trust ». Two object references, two claims, and a function that
		// validates one of them looks exactly like a function that validates both.
		expect.assertions(3);
		const theirs = await freshAccount(other, 'Leur cible');
		expect(
			await refusalOf(() =>
				linkNetWorthAccount({ userId: mine, accountId: theirs, netWorthAccountId: myNetWorth })
			)
		).toBe('not-found');
		expect(
			(await prisma.account.findFirstOrThrow({ where: { id: theirs } })).netWorthAccountId
		).toBeNull();
	});
});
