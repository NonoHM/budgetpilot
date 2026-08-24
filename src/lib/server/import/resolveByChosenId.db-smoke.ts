import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { ImportBucketAccountError, resolveImportBucketAccountById } from './persist';

/**
 * `accountId` IS THE FIRST CLIENT-SUPPLIED OBJECT REFERENCE THIS CHANTIER ADDS, and it is treated
 * as one rather than as a form field.
 *
 * `AGENTS.md` says never accept a `userId` from the client and derive it from `locals.user.id`.
 * This is the same class one object over: the id decides which account a statement is filed into,
 * and it arrives in a POST body. A reference a client posts is a claim, not a fact.
 *
 * ## WHY THIS FILE IS `db-smoke` AND NOT A UNIT SPEC, WHICH IS THE WHOLE POINT
 *
 * The two states an ownership assertion must separate are:
 *
 *   A. the query named `userId` in its where clause, so a foreign row was never returned
 *   B. the query did not, and the FAKE returned nothing anyway
 *
 * **Those produce the identical green in a unit spec**, because a hand-written mock decides what
 * `findFirst` returns and Prisma's own semantics (an unknown `where` key is simply not applied) are
 * not modelled by it. Removing the `userId` clause leaves such a spec passing. That exact green
 * happened in piece 3 of this chantier, which is why the IDOR battery is against a real engine:
 * only a real engine holds the other user's row and can hand it back.
 *
 * A break-check on this file proves the assertion CAN redden. It does not by itself prove it
 * reddens for the reason it names, so each test below states which two states it separates.
 *
 * ASVS 5.0.0 `v5.0.0-8.2.2`, as of the 2026-08-13 assessment of commit `d9c116c`: verified by
 * attack. The scoped where clause is the control; this is the attack.
 */

let mine = '';
let other = '';
let myAccount = '';
let theirAccount = '';

beforeAll(async () => {
	const stamp = Date.now();
	const a = await prisma.user.create({
		data: { email: `chosen-mine-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const b = await prisma.user.create({
		data: { email: `chosen-other-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	mine = a.id;
	other = b.id;
	const own = await prisma.account.create({
		data: { userId: mine, name: 'Mon compte', source: 'csv', currency: 'EUR', exponent: 2 },
		select: { id: true }
	});
	const theirs = await prisma.account.create({
		data: { userId: other, name: 'Leur compte', source: 'csv', currency: 'EUR', exponent: 2 },
		select: { id: true }
	});
	myAccount = own.id;
	theirAccount = theirs.id;
});

describe('resolving the import bucket by the id the user chose', () => {
	it('returns my own account, which is the calibration the refusals below need', async () => {
		// SEPARATES: « the lookup works and is scoped » FROM « the lookup refuses everything ».
		// Without this, every refusal below is equally explained by a function that always throws.
		expect.assertions(2);
		const bucket = await resolveImportBucketAccountById({ userId: mine, accountId: myAccount });
		expect(bucket.accountId).toBe(myAccount);
		// The FULL bucket shape, not just the id, and the reason is a caller rather than tidiness:
		// the collision check on the designation route builds an incoming-batch fingerprint against
		// the destination account and needs its currency, exponent and provider account. Returning
		// the id alone would make that caller do a second lookup for the same row, and
		// `ImportBucketAccount`'s own comment gives the rule: one shape for every lookup, so a
		// caller cannot get a bucket that answers fewer questions depending on which query found it.
		expect(bucket).toStrictEqual({
			accountId: myAccount,
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null,
			bankConnectionId: null
		});
	});

	it('refuses an account belonging to another user', async () => {
		// SEPARATES: « the where clause named userId, so the row was never returned » FROM « the
		// row was not there to return ». The calibration is what tells those apart, and it is the
		// assertion a unit spec cannot make: its fake has no other user's row at all.
		expect.assertions(2);
		expect(await prisma.account.count({ where: { id: theirAccount, userId: other } })).toBe(1);
		await expect(
			resolveImportBucketAccountById({ userId: mine, accountId: theirAccount })
		).rejects.toThrow(/not found/i);
	});

	it('answers a foreign id and a nonexistent id with the SAME refusal', async () => {
		// SEPARATES: « the refusal discloses nothing about existence » FROM « the refusal tells an
		// attacker which ids are real ». Two different messages here would turn this endpoint into
		// an oracle enumerating other users' account ids, which is a disclosure even though
		// neither call returns data.
		expect.assertions(2);
		const foreign = await resolveImportBucketAccountById({
			userId: mine,
			accountId: theirAccount
		}).catch((error: Error) => error.message);
		const absent = await resolveImportBucketAccountById({
			userId: mine,
			accountId: 'clbogus000000000000000000'
		}).catch((error: Error) => error.message);
		expect(foreign).toBe(absent);
		// And neither names the id, because an error message travels. ASVS 5.0.0 16.2.5.
		expect(foreign).not.toContain(theirAccount);
	});

	it('writes nothing on the way to refusing', async () => {
		// SEPARATES: « the refusal happened before any write » FROM « something was created and
		// then the call threw ». A refusal that leaves a row behind is a refusal that only looks
		// like one from the caller's side.
		expect.assertions(2);
		const before = await prisma.account.count();
		await expect(
			resolveImportBucketAccountById({ userId: mine, accountId: theirAccount })
		).rejects.toThrow();
		expect(await prisma.account.count()).toBe(before);
	});

	it('still finds a renamed account, because nothing looks one up by name any more', async () => {
		// SEPARATES: « resolution is by id » FROM « resolution is by name and the name happened to
		// match ». This is the measured hazard made impossible: renaming a bucket while name
		// resolution was live produced created=true, a second bucket, and the same statement
		// imported twice.
		expect.assertions(2);
		await prisma.account.update({ where: { id: myAccount }, data: { name: 'Banque Populaire' } });
		const bucket = await resolveImportBucketAccountById({ userId: mine, accountId: myAccount });
		expect(bucket.accountId).toBe(myAccount);
		expect(await prisma.account.count({ where: { userId: mine } })).toBe(1);
	});
	it('refuses an ARCHIVED account of my own, and says so rather than saying not-found', async () => {
		// SEPARATES: « the account exists, is mine, and is archived » FROM « the account is not mine
		// or not there ». Those are the same answer to an ATTACKER and must not be the same answer
		// to the OWNER: telling me my own account is archived discloses nothing I do not own, and it
		// is the only version of the sentence that says what to do about it. The plate keeps an
		// archived account off the panel, so reaching this needs a hand-made request, which is
		// exactly the case a form control cannot be trusted to prevent.
		expect.assertions(3);
		const archived = await prisma.account.create({
			data: {
				userId: mine,
				name: 'Vieux compte',
				source: 'csv',
				currency: 'EUR',
				exponent: 2,
				archivedAt: new Date('2026-01-01T00:00:00.000Z')
			},
			select: { id: true }
		});
		const error = await resolveImportBucketAccountById({
			userId: mine,
			accountId: archived.id
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ImportBucketAccountError);
		expect((error as ImportBucketAccountError).reason).toBe('archived');
		// And it still does not name the id, for the same reason the refusals above do not.
		expect((error as ImportBucketAccountError).message).not.toContain(archived.id);
	});
});
