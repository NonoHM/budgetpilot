import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { POST } from './+server';

/**
 * THE CREATE ENDPOINT, AND THE TWO THINGS A ONE-FIELD FORM HIDES.
 *
 * ## Mass assignment, which is exactly where nobody looks for it
 *
 * The sheet shows ONE field. That is an affordance, not a control: a request is a request whatever
 * the screen offered, and the fields this endpoint does not read are the ones an attacker would
 * want. `source` decides whether the row is a destination at all, `netWorthAccountId` reaches
 * another table, `archivedAt` hides a row from its owner, `institution` is written only by paths
 * that know the bank without asking, and `discriminant` is the fragment rank 1 later treats as
 * CERTAIN. A posted fragment would let a caller claim the identity of a statement they do not hold.
 *
 * Validated POSITIVELY, against a closed allow list at the server boundary, rather than by
 * stripping a deny list: a deny list is a claim about every field that exists today.
 *
 * ## Why it is `db-smoke`
 *
 * The assertions are about the ROW that was written, and about a row another user holds. A fake
 * decides what it returns, so « the create wrote only `name` » and « the fake ignored the rest »
 * are the same green. Only a real engine can be asked what is actually in the column.
 *
 * ## The 5xx standard
 *
 * The last audit drove 49 actions through two hostile passes with zero 5xx. Every refusal below is
 * a status the client can render and a sentence the user can act on. The final test asserts that as
 * a property over the whole battery rather than case by case, because the case that regresses is
 * the one nobody thought to list.
 */

let mine = '';
let other = '';
let foreignNetWorthAccountId = '';

/** A file whose fourth column is a constant eight-digit run, which is rank 1's grammar. */
const FILE_WITH_IDENTIFIER = [
	'Date;Libelle;Montant;Compte',
	'01/07/2026;CARREFOUR;-12,50;12345678',
	'02/07/2026;SNCF;-40,00;12345678'
].join('\n');

function fileOf(text: string): File {
	return new File([text], 'releve.csv', { type: 'text/csv' });
}

function requestOf(fields: Record<string, string | File>): Request {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return new Request('http://localhost/import/accounts', { method: 'POST', body });
}

function eventOf(userId: string, fields: Record<string, string | File>) {
	return { locals: { user: { id: userId } }, request: requestOf(fields) } as unknown as Parameters<
		typeof POST
	>[0];
}

async function bodyOf(response: Response): Promise<{ error?: string; account?: { id: string } }> {
	return (await response.json()) as { error?: string; account?: { id: string } };
}

beforeAll(async () => {
	const stamp = Date.now();
	const a = await prisma.user.create({
		data: { email: `endpoint-mine-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const b = await prisma.user.create({
		data: { email: `endpoint-other-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	mine = a.id;
	other = b.id;
	const theirNetWorth = await prisma.netWorthAccount.create({
		data: {
			userId: other,
			name: 'Leur patrimoine',
			type: 'checking',
			balanceCents: 0n,
			currency: 'EUR',
			exponent: 2
		},
		select: { id: true }
	});
	foreignNetWorthAccountId = theirNetWorth.id;
});

describe('creating an account from the designation screen', () => {
	it('creates the account and hands back the option the panel will show', async () => {
		// SEPARATES: « the endpoint creates and answers with the row » FROM « it creates and the
		// caller has to go looking ». The panel appends what comes back, so a missing figure here is
		// an option rendering an empty count rather than a failure anything catches.
		expect.assertions(4);
		const response = await POST(eventOf(mine, { name: 'Livret A' }));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			account: { id: string; name: string; discriminant: string | null; transactionCount: number };
		};
		expect(body.account.name).toBe('Livret A');
		expect(body.account.transactionCount).toBe(0);
		expect(await prisma.account.count({ where: { userId: mine, name: 'Livret A' } })).toBe(1);
	});

	it('cannot set a field the sheet does not show', async () => {
		// SEPARATES: « the create wrote only the name » FROM « a posted field reached the column ».
		// The calibration is the first assertion: the row EXISTS, so the nulls below are refusals
		// rather than the absence of a row, which would satisfy every one of them for free.
		expect.assertions(7);
		await POST(
			eventOf(mine, {
				name: 'Compte pirate',
				source: 'enablebanking',
				discriminant: '4417',
				netWorthAccountId: foreignNetWorthAccountId,
				archivedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
				institution: 'Banque de France'
			})
		);
		const created = await prisma.account.findFirstOrThrow({
			where: { userId: mine, name: 'Compte pirate' }
		});
		expect(created.name).toBe('Compte pirate');
		expect(created.source).toBe('csv');
		expect(created.discriminant).toBeNull();
		expect(created.netWorthAccountId).toBeNull();
		expect(created.archivedAt).toBeNull();
		expect(created.institution).toBeNull();
		// And the foreign row it named is untouched, which is the assertion that says the reference
		// was never followed rather than merely never stored.
		expect(
			await prisma.netWorthAccount.count({ where: { id: foreignNetWorthAccountId, userId: other } })
		).toBe(1);
	});

	it('takes the fragment from the FILE it read, never from the field that names one', async () => {
		// SEPARATES: « the server derived the fragment from the bytes it parsed » FROM « the server
		// believed the request ». Both produce an account with a discriminant, and only one of them
		// can be trusted by rank 1, which treats the fragment as certain. The posted value is
		// deliberately DIFFERENT from the file's, so the two states have different answers.
		expect.assertions(2);
		await POST(
			eventOf(mine, {
				name: 'Compte lu',
				discriminant: '9999',
				csvFile: fileOf(FILE_WITH_IDENTIFIER)
			})
		);
		const created = await prisma.account.findFirstOrThrow({
			where: { userId: mine, name: 'Compte lu' }
		});
		expect(created.discriminant).toBe('5678');
		expect(created.discriminant).not.toBe('9999');
	});

	it('refuses a missing name, and says what to do', async () => {
		// SEPARATES: « the refusal is readable and the status is a client error » FROM « the field
		// was absent and something threw ». A 500 here is the regression this test exists to catch.
		expect.assertions(3);
		const response = await POST(eventOf(mine, {}));
		expect(response.status).toBe(400);
		const body = await bodyOf(response);
		expect(body.error).toBeTruthy();
		expect(body.account).toBeUndefined();
	});

	it('refuses a malformed body without reaching the database', async () => {
		// SEPARATES: « a body that is not a form is refused at the boundary » FROM « it reaches
		// `formData()` and throws ». `request.formData()` rejects on a body it cannot parse, and an
		// unhandled rejection in an endpoint is a 500.
		expect.assertions(2);
		const before = await prisma.account.count();
		const response = await POST({
			locals: { user: { id: mine } },
			request: new Request('http://localhost/import/accounts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{"name":"x"'
			})
		} as unknown as Parameters<typeof POST>[0]);
		expect(response.status).toBe(400);
		expect(await prisma.account.count()).toBe(before);
	});

	it('refuses a name this user already holds, folded', async () => {
		// SEPARATES: « the endpoint reports the service's refusal » FROM « it reports a generic
		// failure ». The sentence a user reads for a name they can fix must not be the sentence for
		// a failure they cannot, and only the reason carried through tells the two apart.
		expect.assertions(2);
		const response = await POST(eventOf(mine, { name: '  livret a  ' }));
		expect(response.status).toBe(400);
		expect(await prisma.account.count({ where: { userId: mine, name: '  livret a  ' } })).toBe(0);
	});

	it('refuses a fragment another of MY accounts already holds', async () => {
		// SEPARATES: « two accounts can never share a fragment » FROM « they can ». Rank 1's
		// precondition, asserted at the boundary that could break it: the same file read twice
		// creates one account and refuses the second.
		expect.assertions(2);
		const response = await POST(
			eventOf(mine, { name: 'Compte lu bis', csvFile: fileOf(FILE_WITH_IDENTIFIER) })
		);
		expect(response.status).toBe(400);
		expect(await prisma.account.count({ where: { userId: mine, discriminant: '5678' } })).toBe(1);
	});

	it('never answers a refusal with a server error, over the whole battery', async () => {
		// SEPARATES: « every refusal is a status the client renders » FROM « one of them is a 500 ».
		// Written as a property over the cases rather than case by case, because the case that
		// regresses is the one nobody thought to list. The last audit drove 49 actions through two
		// hostile passes with zero 5xx and that standard does not regress.
		expect.assertions(2);
		const hostile: Record<string, string | File>[] = [
			{},
			{ name: '' },
			{ name: '   ' },
			{ name: 'x'.repeat(500) },
			{ name: 'Livret A' },
			{ name: 'Compte lu bis', csvFile: fileOf(FILE_WITH_IDENTIFIER) },
			{ name: 'Fichier vide', csvFile: fileOf('') },
			{ name: 'Fichier blanc', csvFile: fileOf('   ') },
			{ name: 'Nom nul' },
			{ name: '=SOMME(A1)' }
		];
		const statuses: number[] = [];
		for (const fields of hostile) {
			statuses.push((await POST(eventOf(mine, fields))).status);
		}
		// The absolute figure beside the emptiness claim: a loop that ran zero times reports zero
		// 5xx just as loudly as one that ran ten.
		expect(statuses).toHaveLength(10);
		expect(statuses.filter((status) => status >= 500)).toStrictEqual([]);
	});
});
