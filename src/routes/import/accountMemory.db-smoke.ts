import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import * as m from '$lib/paraglide/messages';
import { answerKeyFor } from '$lib/server/import/answerBinding';
import { createStatementAccount } from '$lib/server/accounts/service';
import { forgetRememberedAccount } from '$lib/server/import/accountMemory';
import { actions as importActions } from './+page.server';
import { actions as columnsActions } from './columns/+page.server';

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly.'
	);
}

/**
 * #599 AND #696, THROUGH THE ROUTE ACTION A BROWSER POST REACHES.
 *
 * ## What was measured first, before anything changed (`main` at 5039858, SQLite)
 *
 * - #599: a user holding ONE statement account, which carries the fragment ···4417, uploads a
 *   statement whose account column names ···0185. `status=200`, 2 rows landed in the ···4417
 *   account, no question. Calibration in the same pass: the same file naming ···4417 landed its 2
 *   rows there too, status 200, so the harness separates the two files rather than always
 *   answering one way.
 * - #696: a user holding two statement accounts is asked (400), answers (200, 2 rows landed in
 *   the chosen account), and the memory table then held 0 rows for that user: the answer was
 *   never written, so the « Mémorisé » line could not appear on any install.
 *
 * Nothing in this file resolves a destination or writes a memory itself: every step is the route's.
 * The one exception is named where it happens (the forget, which is Settings' route and has its own
 * route-level test in `settings/rememberedAccounts.db-smoke.ts`).
 */

/**
 * Boursorama's recorded header row (`profiles/realHeaders.fixture.ts`), whose `accountNum` names
 * the HOLDER's account, with synthetic values. `identifier` is the whole column value; `day` makes
 * a second statement of the same account a different file.
 */
function statement(identifier: string, day = '01'): File {
	const text = [
		'dateOp;dateVal;label;category;categoryParent;supplierFound;amount;comment;accountNum;accountLabel;accountbalance',
		`2026-08-${day};2026-08-${day};CARTE MONOPRIX;Alimentation;Vie quotidienne;MONOPRIX;-32,10;;${identifier};CCJ;1500,00`,
		`2026-08-${day};2026-08-${day};VIR SALAIRE PAUL MERCIER;Revenus;Revenus;;1850,00;;${identifier};CCJ;3350,00`
	].join('\n');
	return new File([text], 'export.csv', { type: 'text/csv' });
}

const HELD = '00012344417';
const OTHER = '00012340185';

function eventOf(userId: string, fields: Record<string, string | File>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		locals: { user: { id: userId } },
		request: new Request('http://localhost/import', { method: 'POST', body }),
		getClientAddress: () => `client-${userId}`
	} as unknown as Parameters<NonNullable<typeof importActions.default>>[0];
}

type ActionOutcome = { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;
type Offer = {
	resolution: Record<string, unknown>;
	memory: { useCount: number; rememberedAt: string } | null;
	options: Array<{ id: string }>;
};

/** Posts the file with its answers BOUND to it, as the page does (`answerBinding.ts`). */
async function postImport(userId: string, fields: Record<string, string | File>) {
	const file = fields.csvFile as File;
	return (await importActions.default!(
		eventOf(userId, { ...fields, answersFor: await answerKeyFor(file) })
	)) as ActionOutcome;
}

async function seedUser(tag: string) {
	const stamp = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
	const user = await prisma.user.create({
		data: { email: `memory-${tag}-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	return user.id;
}

function landedIn(userId: string, accountId: string) {
	return prisma.transaction.count({ where: { userId, accountId } });
}

function offerOf(outcome: ActionOutcome): Offer | undefined {
	return outcome.data?.account as Offer | undefined;
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'c3'.repeat(32);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('#599: a file naming another account than the one its bank holds is asked about', () => {
	it('asks, writes nothing, and says what the row asks rather than « plusieurs comptes »', async () => {
		// SEPARATES « asked, nothing written » FROM what `main` did: status 200, 2 rows in ···4417.
		expect.assertions(4);
		const userId = await seedUser('599');
		const courant = await createStatementAccount({
			userId,
			name: 'Compte courant',
			discriminant: HELD
		});
		const outcome = await postImport(userId, { csvFile: statement(OTHER) });
		expect(outcome.status).toBe(400);
		expect(offerOf(outcome)?.options.map((option) => option.id)).toStrictEqual([courant.id]);
		// Compared whole (AGENTS.md: a substring passes over a doubled tail).
		expect(outcome.data?.error).toBe(m.import_account_error_required());
		expect(await landedIn(userId, courant.id)).toBe(0);
	});

	it('calibration: a file naming ···4417 lands in the account holding it, unasked', async () => {
		expect.assertions(2);
		const userId = await seedUser('599-cal');
		const courant = await createStatementAccount({
			userId,
			name: 'Compte courant',
			discriminant: HELD
		});
		const outcome = await postImport(userId, { csvFile: statement(HELD) });
		expect(outcome.status).toBeUndefined();
		expect(await landedIn(userId, courant.id)).toBe(2);
	});

	it('calibration of the sentence: two accounts of one bank still read « plusieurs comptes »', async () => {
		// SEPARATES « the banner follows the cause » FROM « every ask now says the new sentence ».
		expect.assertions(2);
		const userId = await seedUser('599-several');
		await createStatementAccount({ userId, name: 'Compte courant' });
		await createStatementAccount({ userId, name: 'Compte joint' });
		const outcome = await postImport(userId, { csvFile: statement(OTHER) });
		expect(outcome.status).toBe(400);
		expect(outcome.data?.error).toBe(m.import_account_error_ambiguous_auto());
	});
});

describe('#696: the answer to the account question is remembered, visibly, and forgotten', () => {
	it('remembers an answered account, keyed on the identifier, showing its last four', async () => {
		// SEPARATES « the route writes the memory on the answered path » FROM `main`'s 0 rows. The
		// calibration in the same test: the answer was asked for and imported.
		expect.assertions(5);
		const userId = await seedUser('696');
		await createStatementAccount({ userId, name: 'Compte courant' });
		const joint = await createStatementAccount({ userId, name: 'Compte joint' });
		const asked = await postImport(userId, { csvFile: statement(OTHER) });
		await postImport(userId, { csvFile: statement(OTHER), accountId: joint.id });
		expect(asked.status).toBe(400);
		expect(await landedIn(userId, joint.id)).toBe(2);
		const rows = await prisma.rememberedAccount.findMany({ where: { userId } });
		expect(rows.map((row) => [row.fragment, row.accountId, row.useCount])).toStrictEqual([
			['0185', joint.id, 1]
		]);
		// The key is not the identifier nor the fragment written in the clear.
		expect(rows[0].identifierKey).toMatch(/^[0-9a-f]{64}$/);
		expect(rows[0].identifierKey.includes(OTHER)).toBe(false);
	});

	it('pre-fills the next statement with the remembered account and its figures, then counts it', async () => {
		// SEPARATES « the memory PRE-FILLS the question on the next statement » FROM « it decides
		// unasked » (the import would land without the 400) and from « it is not read » (no
		// `remembered` resolution). Then the confirmed import counts a second use.
		expect.assertions(6);
		const userId = await seedUser('prefill');
		await createStatementAccount({ userId, name: 'Compte courant' });
		const joint = await createStatementAccount({ userId, name: 'Compte joint' });
		await postImport(userId, { csvFile: statement(OTHER), accountId: joint.id });

		const next = statement(OTHER, '15');
		const asked = await postImport(userId, { csvFile: next });
		expect(asked.status).toBe(400);
		expect(offerOf(asked)?.resolution).toStrictEqual({
			rank: 3,
			kind: 'remembered',
			accountId: joint.id
		});
		expect(offerOf(asked)?.memory?.useCount).toBe(1);
		expect(await landedIn(userId, joint.id)).toBe(2);

		const confirmed = await postImport(userId, { csvFile: next, accountId: joint.id });
		expect(confirmed.status).toBeUndefined();
		expect((await prisma.rememberedAccount.findFirstOrThrow({ where: { userId } })).useCount).toBe(
			2
		);
	});

	it('asks again, pre-filling nothing, once the answer is forgotten', async () => {
		expect.assertions(2);
		const userId = await seedUser('forgotten');
		await createStatementAccount({ userId, name: 'Compte courant' });
		const joint = await createStatementAccount({ userId, name: 'Compte joint' });
		await postImport(userId, { csvFile: statement(OTHER), accountId: joint.id });
		const row = await prisma.rememberedAccount.findFirstOrThrow({ where: { userId } });
		// Settings' own function, exercised through its route in `settings/rememberedAccounts.db-smoke.ts`.
		await forgetRememberedAccount(userId, row.id);

		const asked = await postImport(userId, { csvFile: statement(OTHER, '15') });
		expect(asked.status).toBe(400);
		expect(offerOf(asked)?.resolution).toStrictEqual({ rank: 3, kind: 'unknown' });
	});

	it('writes nothing when no answer decided the account', async () => {
		// SEPARATES « the writer runs on the ANSWERED path only » FROM « every import writes a
		// memory ». The fixture is one the writer's own predicate WOULD accept (the file names an
		// identifier no account holds), so only the route's « answered » condition keeps it out: the
		// one account of the source carries no fragment, so it is filed by source, unasked.
		expect.assertions(2);
		const userId = await seedUser('unanswered');
		const courant = await createStatementAccount({ userId, name: 'Compte courant' });
		await postImport(userId, { csvFile: statement(OTHER) });
		expect(await landedIn(userId, courant.id)).toBe(2);
		expect(await prisma.rememberedAccount.count({ where: { userId } })).toBe(0);
	});

	it('logs neither the identifier nor its fragment on the whole journey', async () => {
		// ASVS v5.0.0-16.2.5. The detector is calibrated in the same pass: it must find the fragment
		// in a planted call before its silence over the journey means anything.
		expect.assertions(3);
		const calls: unknown[][] = [];
		for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				calls.push(args);
			});
		}
		const mentions = (needle: string) =>
			calls.some((args) => args.some((arg) => String(arg).includes(needle)));

		console.warn(`planted ···${OTHER.slice(-4)}`);
		expect(mentions(OTHER.slice(-4))).toBe(true);
		calls.length = 0;

		const userId = await seedUser('logs');
		await createStatementAccount({ userId, name: 'Compte courant' });
		const joint = await createStatementAccount({ userId, name: 'Compte joint' });
		await postImport(userId, { csvFile: statement(OTHER) });
		await postImport(userId, { csvFile: statement(OTHER), accountId: joint.id });
		await postImport(userId, { csvFile: statement(OTHER, '15') });
		expect(mentions(OTHER.slice(-4))).toBe(false);
		expect(mentions(OTHER)).toBe(false);
	});
});

/** A generic statement that DECLARES its currency and names `identifier` in an account column. */
function declaring(identifier: string, currency: string): File {
	const text = [
		'date,label,amount,currency,compte',
		`2026-09-03,CARTE MONOPRIX,-32.10,${currency},${identifier}`,
		`2026-09-14,VIR SALAIRE PAUL MERCIER,1850.00,${currency},${identifier}`
	].join('\n');
	return new File([text], 'declaring.csv', { type: 'text/csv' });
}

describe('contradiction pass: the memory and the rest of the question', () => {
	it('M1: does not pre-fill a remembered account the file’s declared currency refuses', async () => {
		// SEPARATES « the ask offers the remembered account only where the file could land in it »
		// FROM « it pre-fills an account the next press is refused into ». The memory is written
		// through the route by a file declaring nothing, then a file declaring EUR asks.
		expect.assertions(3);
		const userId = await seedUser('m1');
		await createStatementAccount({ userId, name: 'Compte courant' });
		const usd = await createStatementAccount({
			userId,
			name: 'Compte USD',
			denomination: { currency: 'USD', exponent: 2 }
		});
		await postImport(userId, { csvFile: statement(OTHER), accountId: usd.id });
		expect(await prisma.rememberedAccount.count({ where: { userId } })).toBe(1);

		const asked = await postImport(userId, { csvFile: declaring(OTHER, 'EUR') });
		expect(asked.status).toBe(400);
		expect(offerOf(asked)?.resolution).toStrictEqual({ rank: 3, kind: 'unknown' });
	});

	it('M2: offers « Nouveau compte » on the #599 question', async () => {
		// SEPARATES « the user can say this is a new account » FROM « the only answers are the
		// accounts they hold, one of which then gets remembered for a statement it never owned ».
		expect.assertions(2);
		const userId = await seedUser('m2-offer');
		await createStatementAccount({ userId, name: 'Compte courant', discriminant: HELD });
		const asked = await postImport(userId, { csvFile: statement(OTHER) });
		expect(asked.status).toBe(400);
		expect((offerOf(asked) as { allowCreate?: boolean } | undefined)?.allowCreate).toBe(true);
	});

	it('M2: an account created for the file removes a misfiled answer from the memory', async () => {
		// SEPARATES « the NEW account is what is remembered » FROM « the old answer stays listed ».
		// The created account holds the file's own fragment (the sheet reads it from the file).
		expect.assertions(2);
		const userId = await seedUser('m2-new');
		const courant = await createStatementAccount({
			userId,
			name: 'Compte courant',
			discriminant: HELD
		});
		await postImport(userId, { csvFile: statement(OTHER), accountId: courant.id });
		const created = await createStatementAccount({
			userId,
			name: 'Compte joint',
			discriminant: OTHER
		});

		await postImport(userId, { csvFile: statement(OTHER, '15'), accountId: created.id });

		// The file now proves its account (the created one holds ···0185), so the remembered
		// misfile is REMOVED rather than rewritten: the reader would never consult it again, and
		// Settings must not keep naming the withdrawn answer (second contradiction pass).
		expect(await prisma.rememberedAccount.count({ where: { userId } })).toBe(0);
		expect(await landedIn(userId, created.id)).toBe(2);
	});
});

describe('M3: the designation door writes the memory too', () => {
	/** Headers no profile recognises, so the file is designated; its fourth column names the account. */
	function opaque(identifier: string): File {
		const text = [
			'poste_1,poste_2,poste_3,compte',
			`2026-09-03,CARTE MONOPRIX,-32.10,${identifier}`,
			`2026-09-14,VIR SALAIRE PAUL MERCIER,1850.00,${identifier}`
		].join('\n');
		return new File([text], 'opaque.csv', { type: 'text/csv' });
	}

	async function postColumns(userId: string, fields: Record<string, string | File>) {
		const body = new FormData();
		for (const [key, value] of Object.entries(fields)) body.set(key, value);
		return (await columnsActions.default!({
			locals: { user: { id: userId } },
			request: new Request('http://localhost/import/columns', { method: 'POST', body }),
			getClientAddress: () => `client-${userId}`
		} as never)) as ActionOutcome;
	}

	it('remembers the account the user chose on the designation screen', async () => {
		// SEPARATES « both import doors write the memory the offer reads » FROM « the designation
		// door reads it (rank 3) and never writes it ». Calibration in the same test: the rows landed.
		expect.assertions(2);
		const userId = await seedUser('m3');
		await createStatementAccount({ userId, name: 'Compte courant', discriminant: HELD });
		const joint = await createStatementAccount({ userId, name: 'Compte joint' });
		await postColumns(userId, {
			csvFile: opaque(OTHER),
			dateIndex: '0',
			labelIndex: '1',
			amountIndex: '2',
			remember: 'false',
			accountId: joint.id
		});
		expect(await landedIn(userId, joint.id)).toBe(2);
		const rows = await prisma.rememberedAccount.findMany({ where: { userId } });
		expect(rows.map((row) => [row.fragment, row.accountId])).toStrictEqual([['0185', joint.id]]);
	});
});

describe('second contradiction pass', () => {
	/** Headers no profile recognises, the fourth column naming the account (designation door). */
	function opaqueFile(identifier: string): File {
		const text = [
			'poste_1,poste_2,poste_3,compte',
			`2026-09-03,CARTE MONOPRIX,-32.10,${identifier}`,
			`2026-09-14,VIR SALAIRE PAUL MERCIER,1850.00,${identifier}`
		].join('\n');
		return new File([text], 'opaque.csv', { type: 'text/csv' });
	}
	/** The same rows under headers the generic profile reads, for the auto door. */
	function genericFile(identifier: string): File {
		const text = [
			'date,label,amount,compte',
			`2026-09-03,CARTE MONOPRIX,-32.10,${identifier}`,
			`2026-09-14,VIR SALAIRE PAUL MERCIER,1850.00,${identifier}`
		].join('\n');
		return new File([text], 'generic.csv', { type: 'text/csv' });
	}

	async function throughColumns(userId: string, file: File, accountId: string) {
		const body = new FormData();
		const fields: Record<string, string | File> = {
			csvFile: file,
			dateIndex: '0',
			labelIndex: '1',
			amountIndex: '2',
			remember: 'false',
			accountId
		};
		for (const [key, value] of Object.entries(fields)) body.set(key, value);
		return columnsActions.default!({
			locals: { user: { id: userId } },
			request: new Request('http://localhost/import/columns', { method: 'POST', body }),
			getClientAddress: () => `client-${userId}`
		} as never);
	}

	const stored = async (userId: string) =>
		(
			await prisma.rememberedAccount.findMany({
				where: { userId },
				select: { fragment: true, useCount: true, account: { select: { name: true } } }
			})
		).map((row) => [row.fragment, row.account.name, row.useCount]);

	it('both doors store the same memory for a file whose account the file itself proves', async () => {
		// SEPARATES « one condition decides the write on both doors » FROM « the designation door
		// writes a row the auto door never writes » (measured [["4417", Compte courant, 1]] vs []).
		// Calibration: the rows landed on both doors, so the equality is not two empty runs.
		expect.assertions(3);
		const auto = await seedUser('r1-auto');
		const autoCourant = await createStatementAccount({
			userId: auto,
			name: 'Compte courant',
			discriminant: HELD
		});
		await postImport(auto, { csvFile: genericFile(HELD) });
		const columns = await seedUser('r1-columns');
		const columnsCourant = await createStatementAccount({
			userId: columns,
			name: 'Compte courant',
			discriminant: HELD
		});
		await throughColumns(columns, opaqueFile(HELD), columnsCourant.id);

		expect(await landedIn(auto, autoCourant.id)).toBe(2);
		expect(await landedIn(columns, columnsCourant.id)).toBe(2);
		expect(await stored(columns)).toStrictEqual(await stored(auto));
	});

	it('offers « Nouveau compte » on the several-accounts question when the file names an unheld identifier', async () => {
		// SEPARATES « a statement of an account the user does not hold yet can be answered with a new
		// account » FROM « only existing accounts, one of which is then remembered as a misfile ».
		expect.assertions(2);
		const userId = await seedUser('r2');
		await createStatementAccount({ userId, name: 'Compte courant' });
		await createStatementAccount({ userId, name: 'Compte joint' });
		const asked = await postImport(userId, { csvFile: statement(OTHER) });
		expect(asked.data?.error).toBe(m.import_account_error_ambiguous_auto());
		expect((offerOf(asked) as { allowCreate?: boolean } | undefined)?.allowCreate).toBe(true);
	});

	it('calibration: no « Nouveau compte » when the file names no identifier', async () => {
		expect.assertions(2);
		const userId = await seedUser('r2-cal');
		await createStatementAccount({ userId, name: 'Compte courant' });
		await createStatementAccount({ userId, name: 'Compte joint' });
		const silent = new File(
			['date,label,amount\n2026-09-03,CARTE MONOPRIX,-32.10\n'],
			'silent.csv',
			{ type: 'text/csv' }
		);
		const asked = await postImport(userId, { csvFile: silent });
		expect(asked.status).toBe(400);
		expect((offerOf(asked) as { allowCreate?: boolean } | undefined)?.allowCreate).toBe(false);
	});
});

describe('third contradiction pass', () => {
	it('keeps the right memory when the fragment is held by an account of another bank', async () => {
		// SEPARATES « the writer removes a row only when the answered account is the one holding
		// the fragment » FROM « it deletes on the fragment alone ». Revolut holds ···0185 too, so the
		// auto door refuses rank 1 across banks and asks; the user answers the same account again.
		// Measured before: rows 1 -> 0, and the next statement came back `unknown`.
		expect.assertions(3);
		const userId = await seedUser('r5');
		const courant = await createStatementAccount({ userId, name: 'Compte courant' });
		await createStatementAccount({ userId, name: 'Compte joint' });
		await postImport(userId, { csvFile: statement(OTHER), accountId: courant.id });
		expect(await prisma.rememberedAccount.count({ where: { userId } })).toBe(1);

		await prisma.account.create({
			data: {
				userId,
				name: 'Revolut',
				source: 'revolut',
				currency: 'EUR',
				exponent: 2,
				discriminant: '0185'
			},
			select: { id: true }
		});
		await postImport(userId, { csvFile: statement(OTHER, '15'), accountId: courant.id });

		const rows = await prisma.rememberedAccount.findMany({ where: { userId } });
		expect(rows.map((row) => row.accountId)).toStrictEqual([courant.id]);
		expect(await landedIn(userId, courant.id)).toBe(4);
	});
});
