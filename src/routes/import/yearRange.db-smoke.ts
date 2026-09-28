import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import { answerKeyFor } from '$lib/server/import/answerBinding';
import { createStatementAccount } from '$lib/server/accounts/service';
import * as m from '$lib/paraglide/messages';
import { actions as importActions } from './+page.server';
import { actions as columnsActions } from './columns/+page.server';

/**
 * #758 THROUGH THE ROUTES, the same functions a browser POST reaches.
 *
 * ## What this separates, and why at the route
 *
 * On PostgreSQL a year 0000 date throws `22008` at the first statement that carries it, and on the
 * unfixed tree that statement is a READ: `findCollidingBatch` (`collision.ts`) queries by the
 * file's period before `createImportBatch` writes anything, so `/import` answered with the
 * framework's error page. `storableYears.db-smoke.ts` covers the write; this covers every read and
 * write a door performs, because the refusal has to happen at the parse, before any of them.
 *
 * Two files per door: one whose every row is out of range (it must come back as a refusal, never
 * a 500), and one mixing an out-of-range row with an ordinary one
 * (the ordinary row imports, the other is refused, and nothing is stored under another year).
 *
 * Break: `isStorableYear` answering true for every year, which is the pre-fix tree on every path at
 * once. On PostgreSQL every test throws `22008` out of the action (the 500); on MariaDB the mixed
 * file stores `2000-01-16` beside `2026-06-14`; on SQLite the year 0000 row is stored.
 */

const ALL_OUT_OF_RANGE = [
	'date,label,amount',
	'0000-01-16,Boulangerie Mercier,-4.20',
	'0000-03-01,Virement salaire,1850.00'
].join('\n');

const MIXED = [
	'date,label,amount',
	'0000-01-16,Boulangerie Mercier,-4.20',
	'2026-06-14,Virement salaire,1850.00'
].join('\n');

/** Headers no profile recognises, so the file reaches `/import/columns` as a designation. */
function opaque(text: string): string {
	return text.replace('date,label,amount', 'poste_1,poste_2,poste_3');
}

function fileOf(text: string): File {
	return new File([text], 'releve.csv', { type: 'text/csv' });
}

function eventOf(userId: string, fields: Record<string, string | File>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		locals: { user: { id: userId } },
		request: new Request('http://localhost/import', { method: 'POST', body }),
		// One address per user: the import limiter counts per address (see declaredCurrency.db-smoke).
		getClientAddress: () => `client-${userId}`
	} as unknown as Parameters<NonNullable<typeof importActions.default>>[0];
}

type ActionOutcome = {
	status?: number;
	data?: { importResult?: { invalidRowDetails?: Array<{ fact: { code: string } }> } };
	importResult?: { invalidRowDetails?: Array<{ fact: { code: string } }> };
};

const DOORS = [
	{
		name: '/import, generic',
		post: async (userId: string, accountId: string, text: string) => {
			const file = fileOf(text);
			return (await importActions.default!(
				eventOf(userId, { csvFile: file, accountId, answersFor: await answerKeyFor(file) })
			)) as ActionOutcome;
		}
	},
	{
		name: '/import/columns, mapped (the designation and correction door)',
		post: async (userId: string, accountId: string, text: string) =>
			(await columnsActions.default!(
				eventOf(userId, {
					csvFile: fileOf(opaque(text)),
					dateIndex: '0',
					labelIndex: '1',
					amountIndex: '2',
					remember: 'false',
					accountId
				})
			)) as ActionOutcome
	}
] as const;

async function seedUser(tag: string) {
	const user = await prisma.user.create({
		data: {
			email: `years-route-${tag}-${Date.now()}@example.test`,
			passwordHash: 'x',
			role: 'USER'
		}
	});
	const account = await createStatementAccount({ userId: user.id, name: 'Compte courant' });
	return { userId: user.id, accountId: account.id };
}

function refusalCodes(outcome: ActionOutcome): string[] {
	const result = outcome.data?.importResult ?? outcome.importResult;
	return (result?.invalidRowDetails ?? []).map((detail) => detail.fact.code);
}

async function storedDates(userId: string): Promise<string[]> {
	const rows = await prisma.transaction.findMany({ where: { userId }, select: { date: true } });
	return rows.map((row) => row.date.toISOString().slice(0, 10)).sort();
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'b2'.repeat(32);
});

describe(`#758 through the routes, on ${process.env.DATABASE_PROVIDER ?? 'the configured engine'}`, () => {
	/**
	 * Separates « the file comes back as two row refusals naming the range » from « the action
	 * throws » (PostgreSQL's `22008`, the 500) and from « imported ». Awaiting the action IS the
	 * first assertion: a throw fails the test before any expectation runs.
	 */
	it('/import: a file of year 0000 rows returns the row refusals', async () => {
		expect.assertions(3);
		const { userId, accountId } = await seedUser('all-import');

		const outcome = await DOORS[0].post(userId, accountId, ALL_OUT_OF_RANGE);

		expect(outcome.status).toBe(400);
		expect(refusalCodes(outcome)).toEqual(['date-out-of-range', 'date-out-of-range']);
		expect(await storedDates(userId)).toEqual([]);
	});

	/**
	 * `/import/columns` does not list row refusals on an empty parse, by design (#343: its banner
	 * names FILE-level reasons only), so what separates the fixed tree here is « the designation
	 * comes back with the ordinary no-valid-rows sentence » from « the action throws ». That this
	 * door says nothing more specific about a row refusal is not new to #758; it is recorded as a
	 * finding rather than changed here.
	 */
	it('/import/columns: a file of year 0000 rows comes back to the designation, not a 500', async () => {
		expect.assertions(3);
		const { userId, accountId } = await seedUser('all-columns');

		const outcome = (await DOORS[1].post(userId, accountId, ALL_OUT_OF_RANGE)) as {
			status?: number;
			data?: { error?: string; keepDesignation?: boolean };
		};

		expect(outcome.status).toBe(400);
		expect(outcome.data).toEqual({
			error: m.import_error_no_valid_transactions(),
			keepDesignation: true
		});
		expect(await storedDates(userId)).toEqual([]);
	});

	/**
	 * Separates « the ordinary row stores as written and the year 0000 row stores nowhere » from
	 * MariaDB's `2000-01-16` beside it and from PostgreSQL's whole-file failure.
	 */
	it.each(DOORS)('$name: a mixed file stores only the storable row', async (door) => {
		expect.assertions(2);
		const { userId, accountId } = await seedUser(`mixed-${door.name}`);

		const outcome = await door.post(userId, accountId, MIXED);

		expect(refusalCodes(outcome)).toEqual(['date-out-of-range']);
		expect(await storedDates(userId)).toEqual(['2026-06-14']);
	});
});
