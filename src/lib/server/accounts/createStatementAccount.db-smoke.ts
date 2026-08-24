import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { isStatementAccount } from '$lib/domain/account';
import { AccountWriteError, createStatementAccount } from './service';

/**
 * THE CREATE SHEET IS A NEW WRITE PATH, AND THIS IS THE BATTERY IT OWES.
 *
 * ## Why this is `db-smoke` and not a unit spec, which is the whole point
 *
 * Every refusal below is a claim about what the DATABASE already holds. The two states each one
 * must separate are:
 *
 *   A. the query named `userId` and the folded key, so the row that exists was found
 *   B. the query did not, and the FAKE returned whatever it was told to
 *
 * Those produce the identical green in a unit spec, because a hand-written mock decides what
 * `findFirst` returns and Prisma's own semantics (an unknown `where` key is simply not applied) are
 * not modelled by it. That exact green happened in piece 3 of this chantier. Only a real engine
 * holds the other user's row and can hand it back.
 *
 * The folded-name refusal is the sharper case: `nameKey` is an app-computed hash precisely because
 * a collation decides what equals what, and MySQL's default collation answers differently from
 * SQLite's. A fake has no collation at all, so it can neither confirm nor refute the rule.
 *
 * ASVS 5.0.0 `v5.0.0-8.2.2`, as of the 2026-08-13 assessment of commit `d9c116c`: verified by
 * attack. The scoped where clause is the control; the foreign-name test below is the attack.
 */

let mine = '';
let other = '';

beforeAll(async () => {
	const stamp = Date.now();
	const a = await prisma.user.create({
		data: { email: `create-mine-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const b = await prisma.user.create({
		data: { email: `create-other-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	mine = a.id;
	other = b.id;
});

describe('creating the account a statement belongs to', () => {
	it('creates a destination the picker can offer, and nothing more', async () => {
		// SEPARATES: « the row is a statement account with only the field the sheet shows » FROM
		// « the row is created with fields nobody typed ». This is the calibration every refusal
		// below needs: without it they are equally explained by a function that always throws.
		expect.assertions(8);
		const created = await createStatementAccount({ userId: mine, name: 'Livret A' });
		const row = await prisma.account.findFirstOrThrow({
			where: { id: created.id, userId: mine }
		});
		expect(row.name).toBe('Livret A');
		// `csv` and not a new source value: `isStatementAccount` is an EXCLUSION set, so a source it
		// has never heard of would be offered as a destination by accident rather than by decision.
		expect(row.source).toBe('csv');
		expect(isStatementAccount(row)).toBe(true);
		expect(row.institution).toBeNull();
		expect(row.discriminant).toBeNull();
		expect(row.netWorthAccountId).toBeNull();
		expect(row.archivedAt).toBeNull();
		// The folded key is written at creation, because it is what the refusal below reads.
		expect(row.nameKey).not.toBeNull();
	});

	it('refuses a name this user already holds, folded rather than compared byte for byte', async () => {
		// SEPARATES: « the refusal reads the collation-independent key » FROM « the refusal compares
		// the two strings ». Two accounts named « Livret A » and « livret a » would make the panel
		// unreadable, which is the defect rebuilt inside its own repair. The folded pair is what
		// tells the two states apart: a byte comparison lets it through.
		expect.assertions(3);
		const error = await createStatementAccount({ userId: mine, name: '  livret a  ' }).catch(
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(AccountWriteError);
		expect((error as AccountWriteError).reason).toBe('name-taken');
		expect(await prisma.account.count({ where: { userId: mine } })).toBe(1);
	});

	it('does not refuse a name ANOTHER user holds', async () => {
		// SEPARATES: « the uniqueness query named userId » FROM « uniqueness is global ». A global
		// rule would let one user's account names tell another user which names are taken, which is
		// an enumeration oracle built out of a validation message.
		expect.assertions(2);
		const created = await createStatementAccount({ userId: other, name: 'Livret A' });
		expect(created.name).toBe('Livret A');
		expect(await prisma.account.count({ where: { userId: other, name: 'Livret A' } })).toBe(1);
	});

	it('refuses a discriminant another of MY accounts already holds', async () => {
		// SEPARATES: « two accounts can never share a fragment » FROM « they can, and rank 1 returns
		// two of them ». This is rank 1's precondition rather than a validation nicety: without it
		// `resolveStatementAccount` finds two holders, falls through, and its claim to certainty
		// collapses. 6h: « Impossible par construction ».
		expect.assertions(3);
		await createStatementAccount({ userId: mine, name: 'BP courant', discriminant: '4417' });
		const error = await createStatementAccount({
			userId: mine,
			name: 'BP livret',
			discriminant: '4417'
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AccountWriteError);
		expect((error as AccountWriteError).reason).toBe('discriminant-taken');
		// And the refusal never names the fragment. An error message travels, through a screenshot,
		// a ticket and a clipboard. ASVS 5.0.0 16.2.5.
		expect((error as AccountWriteError).message).not.toContain('4417');
	});

	it('lets another user hold the same discriminant', async () => {
		// SEPARATES: « the fragment query named userId » FROM « fragments are globally unique ».
		// Two holders at one bank legitimately share the last four characters of nothing at all, and
		// a global rule would refuse the second user an account for a reason about the first.
		expect.assertions(1);
		const created = await createStatementAccount({
			userId: other,
			name: 'BP courant',
			discriminant: '4417'
		});
		expect(created.discriminant).toBe('4417');
	});

	it('refuses an empty name and writes nothing on the way', async () => {
		// SEPARATES: « the refusal happened before any write » FROM « a row was created and then the
		// call threw ». A refusal that leaves a row behind only looks like one from the caller side.
		expect.assertions(3);
		const before = await prisma.account.count();
		const error = await createStatementAccount({ userId: mine, name: '   ' }).catch(
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(AccountWriteError);
		expect((error as AccountWriteError).reason).toBe('name-required');
		expect(await prisma.account.count()).toBe(before);
	});

	it('refuses a name longer than the column can hold rather than silently cutting it', async () => {
		// SEPARATES: « an over-long name is refused and the user is told » FROM « it is capped and
		// the user is told nothing ». The sheet's field carries a `maxlength`, so this is reachable
		// only by a hand-made request, which is exactly the case a form control cannot prevent.
		// Capping here would store a name the user never typed and can no longer recognise.
		expect.assertions(2);
		const error = await createStatementAccount({ userId: mine, name: 'x'.repeat(121) }).catch(
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(AccountWriteError);
		expect((error as AccountWriteError).reason).toBe('name-too-long');
	});
});
