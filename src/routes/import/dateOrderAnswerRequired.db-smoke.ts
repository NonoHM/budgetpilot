import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import { createStatementAccount } from '$lib/server/accounts/service';
import * as m from '$lib/paraglide/messages';
import { actions as columnsActions } from './columns/+page.server';

/**
 * #1200 THROUGH THE ROUTE, against a real engine: `/import/columns` stores nothing for an
 * ambiguous date column that arrives without an answer.
 *
 * The door used to tell the parser the screen had already asked (`dateOrderPromptedClientSide`),
 * and two screen paths post no answer: a row arriving designated from a remembered mapping, and
 * Escape on the reading step. The file was then stored day-first, every date on a real day, with
 * nothing said. What is asserted is the ROWS, because a refusal sentence over a written batch is
 * the worst version of this defect.
 *
 * The answered month-first post is the positive control: it proves this detector reads stored
 * dates at all, so an empty `storedDates` in the refusal tests is not an empty query.
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

/** Opaque headers reach the designation door; every date reads both ways. */
const AMBIGUOUS = [
	'poste_1,poste_2,poste_3',
	'01/02/2026,Boulangerie Mercier,-4.20',
	'03/02/2026,Virement salaire,1850.00'
].join('\n');

type Outcome = { status?: number; data?: { error?: string; keepDesignation?: boolean } };

async function post(userId: string, accountId: string, extra: Record<string, string> = {}) {
	const body = new FormData();
	body.set('csvFile', new File([AMBIGUOUS], 'releve.csv', { type: 'text/csv' }));
	body.set('dateIndex', '0');
	body.set('labelIndex', '1');
	body.set('amountIndex', '2');
	body.set('remember', 'false');
	body.set('accountId', accountId);
	for (const [key, value] of Object.entries(extra)) body.set(key, value);
	return (await columnsActions.default!({
		locals: { user: { id: userId } },
		request: new Request('http://localhost/import/columns', { method: 'POST', body }),
		getClientAddress: () => `client-${userId}`
	} as unknown as Parameters<NonNullable<typeof columnsActions.default>>[0])) as Outcome;
}

async function seedUser(tag: string) {
	const user = await prisma.user.create({
		data: {
			email: `date-order-${tag}-${Date.now()}@example.test`,
			passwordHash: 'x',
			role: 'USER'
		}
	});
	const account = await createStatementAccount({ userId: user.id, name: 'Compte courant' });
	return { userId: user.id, accountId: account.id };
}

async function storedDates(userId: string): Promise<string[]> {
	const rows = await prisma.transaction.findMany({ where: { userId }, select: { date: true } });
	return rows.map((row) => row.date.toISOString().slice(0, 10)).sort();
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'c3'.repeat(32);
});

describe(`#1200 on ${process.env.DATABASE_PROVIDER ?? 'the configured engine'}`, () => {
	it('stores the month-first reading the member answered (positive control)', async () => {
		expect.assertions(2);
		const { userId, accountId } = await seedUser('answered');
		const outcome = await post(userId, accountId, { dateOrder: 'month-first' });
		expect(outcome.status).toBeUndefined();
		expect(await storedDates(userId)).toEqual(['2026-01-02', '2026-03-02']);
	});

	/**
	 * Separates « refused with the confirmation sentence, no row and no batch » from « stored
	 * day-first », which was the tree before #1200.
	 */
	it('refuses an unanswered ambiguous column and stores no row and no batch', async () => {
		expect.assertions(4);
		const { userId, accountId } = await seedUser('unanswered');
		const outcome = await post(userId, accountId);
		expect(outcome.status).toBe(400);
		expect(outcome.data?.error).toBe(m.import_error_ambiguous_date_order());
		expect(await storedDates(userId)).toEqual([]);
		expect(await prisma.importBatch.count({ where: { userId } })).toBe(0);
	});

	/** A value outside the two readings is no answer: same refusal, nothing stored. */
	it('refuses a reading outside the closed set and stores nothing', async () => {
		expect.assertions(3);
		const { userId, accountId } = await seedUser('hostile');
		const outcome = await post(userId, accountId, { dateOrder: 'Mois puis jour' });
		expect(outcome.status).toBe(400);
		expect(outcome.data?.error).toBe(m.import_error_ambiguous_date_order());
		expect(await storedDates(userId)).toEqual([]);
	});
});
