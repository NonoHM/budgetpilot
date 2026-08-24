import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { TRANSACTION_CSV_HEADER } from '$lib/server/transactions/exportCsv';
import { GET } from './+server';

/**
 * THE `compte` COLUMN, ASSERTED THROUGH THE ROUTE THAT SERVES IT.
 *
 * ## Why through the route, and this is the whole reason the file exists
 *
 * `exportCsv.spec.ts` covers the column exhaustively and every one of its tests calls
 * `buildTransactionsCsv` DIRECTLY, handing it the `accountName` option. The route did not pass it.
 * So the builder was tested and correct, the column shipped EMPTY for every user, and no unit test
 * could see it, because the seam under test is precisely the argument the caller omits.
 *
 * Same family as the component-versus-page rule this repository already records: a component whose
 * every state is asserted says nothing about whether the page puts it into one. Here it arrives in
 * an export, which is the surface a user opens in a spreadsheet and reads as a statement of fact
 * about their own data.
 *
 * ## And why `db-smoke` rather than a mocked route spec
 *
 * The route decides whether the scope is ONE account by reading the rows it collected. A fake
 * decides what those rows are, so « the route grouped the real rows » and « the fake returned rows
 * that happen to agree » are the same green. The two-account case below is the one that matters and
 * it cannot be posed at all without two accounts really existing.
 */

let mine = '';
let firstAccount = '';
let secondAccount = '';
let categoryId = '';
let secondRowId = '';

const COMPTE_INDEX = TRANSACTION_CSV_HEADER.split(';').indexOf('compte');

function eventOf(userId: string, search = '') {
	return {
		locals: { user: { id: userId } },
		url: new URL(`http://localhost/transactions/export${search}`)
	} as unknown as Parameters<typeof GET>[0];
}

/** The `compte` cell of every data line, read by INDEX off the served header rather than by eye. */
async function comptesOf(response: Response): Promise<string[]> {
	const text = await response.text();
	return (
		text
			.split('\n')
			.slice(1)
			.filter((line) => line.trim().length > 0)
			// `\r` stripped: the file is served with CRLF endings, so the last cell of every line carries
			// one and a raw comparison would fail for a reason about the line terminator.
			.map((line) => (line.split(';')[COMPTE_INDEX] ?? '').replace(/\r$/, ''))
	);
}

async function seedTransaction(accountId: string, label: string): Promise<string> {
	const created = await prisma.transaction.create({
		data: {
			userId: mine,
			accountId,
			categoryId,
			date: new Date('2026-07-01T00:00:00.000Z'),
			label,
			amountCents: -1250n,
			currency: 'EUR',
			exponent: 2,
			type: 'expense',
			source: 'csv'
		},
		select: { id: true }
	});
	return created.id;
}

beforeAll(async () => {
	const stamp = Date.now();
	const user = await prisma.user.create({
		data: { email: `export-account-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	mine = user.id;
	const category = await prisma.category.create({
		data: { userId: mine, name: 'Courses', nameKey: `courses-${stamp}` },
		select: { id: true }
	});
	categoryId = category.id;
	const a = await prisma.account.create({
		data: { userId: mine, name: 'BP Compte courant', source: 'csv', currency: 'EUR', exponent: 2 },
		select: { id: true }
	});
	const b = await prisma.account.create({
		data: { userId: mine, name: 'Livret A', source: 'csv', currency: 'EUR', exponent: 2 },
		select: { id: true }
	});
	firstAccount = a.id;
	secondAccount = b.id;
});

describe('the export names the account its rows came from', () => {
	it('serves the header the parser recognises, which is the calibration', async () => {
		// SEPARATES: « the route served OUR v3 export » FROM « it served something else and the cells
		// below are being read out of the wrong file ». Every assertion after this reads a column by
		// its index in this header, so an unrecognised header would silently move every figure.
		expect.assertions(2);
		const response = await GET(eventOf(mine));
		expect(response.status).toBe(200);
		expect((await response.text()).split('\n')[0].trim()).toBe(TRANSACTION_CSV_HEADER);
	});

	it('writes the account name into every line when the rows come from ONE account', async () => {
		// SEPARATES: « the route passed the name it established » FROM « the route passed nothing and
		// the column ships empty ». Both produce a well-formed file with the right header and the
		// right number of columns, which is why nothing caught the second for a whole task.
		expect.assertions(2);
		await seedTransaction(firstAccount, 'CARREFOUR');
		await seedTransaction(firstAccount, 'SNCF');
		const comptes = await comptesOf(await GET(eventOf(mine)));
		// The absolute figure beside the claim: two lines were read, not zero.
		expect(comptes).toHaveLength(2);
		expect(new Set(comptes)).toStrictEqual(new Set(['BP Compte courant']));
	});

	it('names NO account once the rows come from two of them', async () => {
		// SEPARATES: « the route established that the scope is one account » FROM « the route named
		// whichever account it saw first ». The second is worse than an empty column: it tells the
		// user their Livret A rows belong to their current account, and a re-import would file them
		// there. `readMaisonV3Account` refuses a non-constant column for the same reason.
		expect.assertions(2);
		secondRowId = await seedTransaction(secondAccount, 'EDF');
		const comptes = await comptesOf(await GET(eventOf(mine)));
		expect(comptes).toHaveLength(3);
		expect(new Set(comptes)).toStrictEqual(new Set(['']));
	});

	it('names the account again once a filter narrows the scope back to one', async () => {
		// SEPARATES: « the name follows the SCOPE the user exported » FROM « the name follows the
		// user's whole history ». A filtered export must read like the screen it came from, and the
		// screen showing one account's rows is a file that can say which account they are.
		//
		// Narrowed by `ids` rather than by an account filter, because there ISN'T one: the
		// transactions screen carries no per-account filter today. Named rather than worked around,
		// so the next reader does not go looking for a parameter this route never accepted.
		expect.assertions(2);
		const comptes = await comptesOf(await GET(eventOf(mine, `?ids=${secondRowId}`)));
		expect(comptes).toHaveLength(1);
		expect(new Set(comptes)).toStrictEqual(new Set(['Livret A']));
	});

	it('never names an account belonging to someone else', async () => {
		// SEPARATES: « the account lookup named userId » FROM « it resolved the id it found on the
		// rows ». The rows are already scoped, so this looks redundant and is not: the second lookup
		// takes an id off a row and asks the database for a name, which is the shape that leaks a
		// name across users the moment the row scoping is loosened anywhere upstream.
		expect.assertions(2);
		const stamp = Date.now();
		const other = await prisma.user.create({
			data: { email: `export-other-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
		});
		const comptes = await comptesOf(await GET(eventOf(other.id)));
		expect(comptes).toHaveLength(0);
		expect(comptes.join('')).not.toContain('BP Compte courant');
	});
});
