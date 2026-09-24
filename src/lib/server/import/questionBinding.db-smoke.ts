import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import * as m from '$lib/paraglide/messages';
import { createStatementAccount } from '$lib/server/accounts/service';
import { actions } from '../../../routes/import/+page.server';

/**
 * THE TWO QUESTIONS ON ONE FILE, and THE FILE EACH ANSWER BELONGS TO, through the real `/import`
 * action against a real engine.
 *
 * `page.server.spec.ts` asserts the same journey over a hand-written fake, and a fake decides what
 * `findFirst` returns: removing the `userId` from the account lookup, or letting an answer keyed to
 * one file ride another, can stay green there. Here the rows are real, another user's account is
 * real, and what is asserted is where transactions LANDED, per account, on each engine.
 *
 * Tier 3 because the two answers decide which account rows are stored in and how their dates are
 * read, and the failure mode of the fix is an answer given for one file applied to another: data
 * written wrong that looks right.
 */

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly. It refuses to fall back to the default local ' +
			'SQLite file.'
	);
}

if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

/** Every date reads both ways (day and month at or below 12), so the file asks its reading. */
const AMBIGUOUS = 'date;label;amount;category\n06/01/2026;AUCHAN L1;-42,10;Autre';
/** Same bank, same header, same upload name: a different statement. */
const OTHER_AMBIGUOUS = 'date;label;amount;category\n07/02/2026;SNCF L1;-30,00;Autre';

let user: { id: string; email: string; role: string };
let courant = '';
let livret = '';
let theirs = '';
let caller = 0;

/**
 * The limiter's HMAC key as an explicit fixture, for the reason `createAccount.db-smoke.ts` gives:
 * `vitest.db.env-stub.ts` is empty on purpose, and `/import` is rate limited.
 */
beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'a1'.repeat(32);
});

beforeEach(async () => {
	const stamp = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
	const mine = await prisma.user.create({
		data: { email: `l1-mine-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const other = await prisma.user.create({
		data: { email: `l1-other-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	user = { id: mine.id, email: mine.email, role: 'USER' };
	courant = (await createStatementAccount({ userId: mine.id, name: `Courant ${stamp}` })).id;
	livret = (await createStatementAccount({ userId: mine.id, name: `Livret ${stamp}` })).id;
	theirs = (await createStatementAccount({ userId: other.id, name: `Leur compte ${stamp}` })).id;
	caller += 1;
});

type Reply = {
	status?: number;
	data?: {
		error?: string;
		account?: { options: { id: string }[] };
		reading?: { dateColumn: number };
		answers?: { key: string; accountId: string | null; dateOrder: string | null };
	};
	importResult?: { importedRows: number };
};

/** Drives the real action exactly as the page's form does. */
async function post(content: string, fields: Record<string, string> = {}): Promise<Reply> {
	const formData = new FormData();
	formData.set('csvFile', new File([content], 'releve.csv', { type: 'text/csv' }));
	for (const [key, value] of Object.entries(fields)) formData.set(key, value);
	return (await actions.default({
		locals: { user },
		request: new Request('http://localhost/import', { method: 'POST', body: formData }),
		// One caller per test, so the import limiter counts this test and no other.
		getClientAddress: () => `10.1.0.${caller % 250}`
	} as never)) as Reply;
}

async function landedIn(accountId: string) {
	return prisma.transaction.count({ where: { userId: user.id, accountId } });
}

describe('/import, two questions on one file, against a real engine', () => {
	it('asks the account, then the date, then imports into the account answered', async () => {
		const first = await post(AMBIGUOUS);
		expect(first.data?.account?.options.map((option) => option.id).sort()).toEqual(
			[courant, livret].sort()
		);
		const key = first.data?.answers?.key ?? '';

		const second = await post(AMBIGUOUS, { answersFor: key, accountId: livret });
		expect(second.data?.error).toBe(m.import_error_ambiguous_date_order());
		expect(second.data?.answers?.accountId).toBe(livret);

		const third = await post(AMBIGUOUS, {
			answersFor: key,
			accountId: livret,
			dateOrder: 'day-first'
		});
		expect(third.importResult?.importedRows).toBe(1);
		expect({ livret: await landedIn(livret), courant: await landedIn(courant) }).toStrictEqual({
			livret: 1,
			courant: 0
		});
		// The reading answered is the one stored, as a date and as the batch's audit fact.
		const row = await prisma.transaction.findFirstOrThrow({
			where: { userId: user.id, accountId: livret },
			select: { date: true, importBatch: { select: { dateOrder: true } } }
		});
		expect(row.date.toISOString().slice(0, 10)).toBe('2026-01-06');
		expect(row.importBatch?.dateOrder).toBe('day-first');
	});

	it('never applies an answer keyed to another file', async () => {
		// SEPARATES: « a stale answer is dropped and the new file is asked its own questions » FROM
		// « the first file's account files the second file's rows », on a real engine.
		const first = await post(AMBIGUOUS);
		const staleKey = first.data?.answers?.key ?? '';

		const second = await post(OTHER_AMBIGUOUS, {
			answersFor: staleKey,
			accountId: livret,
			dateOrder: 'day-first'
		});

		expect(second.status).toBe(400);
		expect(second.data?.error).toBe(m.import_account_error_ambiguous_auto());
		expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0);
	});

	it("refuses another user's account posted as the answer, bound to the right file", async () => {
		// ASVS v5.0.0-8.2.2 through the NEW path: an answer that survives the binding is still a
		// claim, resolved with `userId` in the same where clause. SEPARATES: « refused, nothing
		// written, their account untouched » FROM « used because it arrived bound ».
		const first = await post(AMBIGUOUS);
		const key = first.data?.answers?.key ?? '';

		const result = await post(AMBIGUOUS, {
			answersFor: key,
			accountId: theirs,
			dateOrder: 'day-first'
		});

		expect(result.status).toBe(400);
		expect(result.data?.error).toBe(m.import_account_error_required());
		expect(result.data?.answers?.accountId).toBeNull();
		expect(await landedIn(theirs)).toBe(0);
		expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0);
	});
});
