import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import * as m from '$lib/paraglide/messages';
import { answerKeyFor } from '$lib/server/import/answerBinding';
import { createStatementAccount } from '$lib/server/accounts/service';
import { buildBackupExport } from '$lib/server/backup/export';
import { restoreBackup } from '$lib/server/backup/import';
import { backupExportSchema } from '$lib/server/backup/schema';
import { layersKeyOf } from '$lib/server/import/mapping/layers';
import { actions as importActions } from './+page.server';
import { actions as columnsActions } from './columns/+page.server';

/**
 * #1294 (C2c-S2), THROUGH THE ROUTE ACTIONS A BROWSER POST REACHES, against a real engine.
 *
 * Since #1207 an amount column with no minus sign is asked « Money out or money in? ». Measured on
 * `main` at 9b4daf1 before this change: the answer was not kept, so the second statement in the same
 * remembered format was refused again on `/import` with `ambiguous-amount-sign` and stored nothing,
 * though the summary had said the correspondance « will be reused ». Both blind testers hit it.
 *
 * Owner ruling, 2026-11-06: the answer is stored with the kept column mapping, and the file still
 * wins: a later statement of that format carrying a minus sign ignores it.
 *
 * Every step here is the route's: nothing in this file writes a mapping or parses a file itself.
 * What is asserted is the stored ROWS (their type), because a stored answer that imports every row
 * the wrong way is the defect this column can create.
 */

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly.'
	);
}
if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error('DATABASE_URL points at dev.db. Point it at a throwaway database instead.');
}

/** Headers no profile recognises, so the first statement goes through the designation door. */
const HEADERS = 'Jour;Detail;Somme';

/** A statement in that format; `rows` are `day;label;amount`, the amount written as the file has it. */
function statement(rows: string[], name = 'releve.csv'): File {
	return new File([[HEADERS, ...rows].join('\n')], name, { type: 'text/csv' });
}

const JUNE = statement(['24/06/2026;CB CARREFOUR;24,90', '22/06/2026;CB ORANGE;39,99']);
const JULY = statement(['24/07/2026;CB MONOPRIX;18,40', '21/07/2026;CB SNCF;61,00'], 'juillet.csv');
const AUGUST_SIGNED = statement(
	['24/08/2026;CB FNAC;-45,00', '21/08/2026;REMBOURSEMENT;12,00'],
	'aout.csv'
);

type Outcome = { status?: number; data?: Record<string, unknown> };

const createdUserIds: string[] = [];

async function seedUser(tag: string) {
	const user = await prisma.user.create({
		data: {
			email: `sign-memory-${tag}-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash',
			role: 'USER'
		}
	});
	createdUserIds.push(user.id);
	const account = await createStatementAccount({ userId: user.id, name: 'Compte courant' });
	return { userId: user.id, accountId: account.id };
}

/** The designation door, as the screen posts it: the three roles, the account, the answer. */
async function designate(
	who: { userId: string; accountId: string },
	file: File,
	extra: Record<string, string> = {}
): Promise<Outcome> {
	const body = new FormData();
	body.set('csvFile', file);
	body.set('dateIndex', '0');
	body.set('labelIndex', '1');
	body.set('amountIndex', '2');
	body.set('accountId', who.accountId);
	for (const [key, value] of Object.entries(extra)) body.set(key, value);
	return (await columnsActions.default!({
		locals: { user: { id: who.userId } },
		request: new Request('http://localhost/import/columns', { method: 'POST', body }),
		getClientAddress: () => `client-${who.userId}`
	} as never)) as Outcome;
}

/** The upload door, with the account answer bound to the file as the page binds it. */
async function upload(who: { userId: string; accountId: string }, file: File): Promise<Outcome> {
	const key = await answerKeyFor(file);
	const body = new FormData();
	body.set('csvFile', file);
	body.set('answersFor', key);
	body.set('accountId', who.accountId);
	return (await importActions.default!({
		locals: { user: { id: who.userId } },
		request: new Request('http://localhost/import', { method: 'POST', body }),
		getClientAddress: () => `client-${who.userId}`
	} as never)) as Outcome;
}

/** A SUCCESS returns its object directly (a refusal wraps it in `data`): the summary's kept answer. */
function keptOf(outcome: Outcome): unknown {
	return (outcome as unknown as { importResult?: { keptAmountSign: unknown } }).importResult
		?.keptAmountSign;
}

/** Each stored row as `label type`, sorted: the direction is the fact under test. */
async function storedTypes(userId: string): Promise<string[]> {
	const rows = await prisma.transaction.findMany({
		where: { userId },
		select: { label: true, type: true }
	});
	return rows.map((row) => `${row.label} ${row.type}`).sort();
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'c3'.repeat(32);
});

afterAll(async () => {
	if (createdUserIds.length > 0)
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe(`#1294 on ${process.env.DATABASE_PROVIDER ?? 'the configured engine'}`, () => {
	/**
	 * THE RULING. Separates « the second statement imports with no question, read the way the member
	 * answered » from « asked again and nothing stored », which was `main`. The first post is the
	 * calibration: its rows prove the harness stores and reads types at all.
	 */
	it('imports the second statement in a remembered unsigned format with no question', async () => {
		expect.assertions(4);
		const who = await seedUser('second');
		const first = await designate(who, JUNE, { amountSign: 'out' });
		expect(first.status).toBeUndefined();
		expect(await storedTypes(who.userId)).toEqual(['CB CARREFOUR expense', 'CB ORANGE expense']);

		const second = await upload(who, JULY);
		expect(second.status).toBeUndefined();
		expect(await storedTypes(who.userId)).toEqual([
			'CB CARREFOUR expense',
			'CB MONOPRIX expense',
			'CB ORANGE expense',
			'CB SNCF expense'
		]);
	});

	/**
	 * THE FILE WINS. Separates « a statement of that format carrying a minus sign is read by its own
	 * signs » from « the stored answer turns every row into money out », which would store the
	 * refund as a purchase.
	 */
	it('reads a later statement that carries a minus sign by its own signs', async () => {
		expect.assertions(2);
		const who = await seedUser('file-wins');
		await designate(who, JUNE, { amountSign: 'out' });
		const signed = await upload(who, AUGUST_SIGNED);
		expect(signed.status).toBeUndefined();
		expect((await storedTypes(who.userId)).filter((row) => /FNAC|REMB/.test(row))).toEqual([
			'CB FNAC expense',
			'REMBOURSEMENT income'
		]);
	});

	/**
	 * OWNERSHIP. Separates « one member's answer is read only for that member » from « the format's
	 * answer is global ». The fingerprint is derived from public column names, so every member using
	 * this format shares it (AGENTS.md « Security boundaries »).
	 */
	it('still asks another member who keeps the same format with no answer', async () => {
		expect.assertions(3);
		const owner = await seedUser('owner');
		await designate(owner, JUNE, { amountSign: 'out' });
		// The stranger's own correspondance for the same header row, kept from a signed statement, so
		// it holds no answer: the only answer for this fingerprint in the database is the owner's.
		const stranger = await seedUser('stranger');
		await designate(stranger, AUGUST_SIGNED);
		const asked = await upload(stranger, JULY);
		expect(asked.status).toBe(400);
		expect(asked.data?.error).toBe(m.import_refusal_ambiguous_amount_sign({ sample: '18,40' }));
		expect((await storedTypes(stranger.userId)).filter((row) => /MONOPRIX|SNCF/.test(row))).toEqual(
			[]
		);
	});

	/**
	 * THE MEMBER CHANGES IT. Separates « a correction that answers « Money in » replaces the stored
	 * answer » from « the first answer sticks », which would leave a wrong answer with no way out.
	 */
	it('keeps the latest answer the member gave for the format', async () => {
		expect.assertions(2);
		const who = await seedUser('changed');
		await designate(who, JUNE, { amountSign: 'out' });
		// Observed, not assumed: the test means nothing unless this second answer was stored.
		const changed = await designate(who, statement(['21/09/2026;VIREMENT;100,00'], 'sept.csv'), {
			amountSign: 'in'
		});
		expect(changed.status).toBeUndefined();
		await upload(who, JULY);
		expect((await storedTypes(who.userId)).filter((row) => /MONOPRIX|SNCF/.test(row))).toEqual([
			'CB MONOPRIX income',
			'CB SNCF income'
		]);
	});

	/**
	 * A FILE THAT PROVED ITS OWN SIGNS LEAVES NO ANSWER BEHIND. Separates « a save whose parse read
	 * the file's own signs stores no answer » from « it keeps an older one », so the stored answer is
	 * always one the member gave for a file that needed it. The next unsigned statement asks again.
	 *
	 * The signed save POSTS an answer, the way a screen whose per-column state read the column as
	 * unsigned would: that is what separates « keep the answer the parse applied » from « keep the
	 * posted one » (break K3 stayed green while this post carried no answer).
	 */
	it('asks again after the format was last saved from a signed statement', async () => {
		expect.assertions(2);
		const who = await seedUser('cleared');
		await designate(who, JUNE, { amountSign: 'out' });
		await designate(who, AUGUST_SIGNED, { amountSign: 'out' });
		const asked = await upload(who, JULY);
		expect(asked.status).toBe(400);
		expect(asked.data?.error).toBe(m.import_refusal_ambiguous_amount_sign({ sample: '18,40' }));
	});
});

describe(`#1294, which account and which summary, on ${process.env.DATABASE_PROVIDER ?? 'the configured engine'}`, () => {
	/**
	 * OWNER RULING 1 (note pass N2b). Separates « the answer holds for the account it was given for »
	 * from « for every statement with these headers »: a card export and a savings export sharing a
	 * header row must not file the deposits as money out.
	 */
	it('asks when the same headers land in another account', async () => {
		expect.assertions(3);
		const who = await seedUser('two-accounts');
		await designate(who, JUNE, { amountSign: 'out' });
		const savings = await createStatementAccount({ userId: who.userId, name: 'Livret' });
		const asked = await upload({ userId: who.userId, accountId: savings.id }, JULY);
		expect(asked.status).toBe(400);
		expect(asked.data?.error).toBe(m.import_refusal_ambiguous_amount_sign({ sample: '18,40' }));
		expect(await prisma.transaction.count({ where: { accountId: savings.id } })).toBe(0);
	});

	/**
	 * THE DISCLOSURE (owner ruling 2). Separates « the summary says the kept answer decided the rows,
	 * and names the correspondance to reopen » from « it imports in silence ».
	 */
	it('says on the summary that the kept answer decided the rows', async () => {
		expect.assertions(2);
		const who = await seedUser('disclosed');
		const first = await designate(who, JUNE, { amountSign: 'out' });
		const mapping = await prisma.columnMapping.findFirstOrThrow({ where: { userId: who.userId } });
		const second = await upload(who, JULY);
		// The first was answered on screen, the second by the kept answer: only the second says so.
		expect(keptOf(first)).toBeNull();
		expect(keptOf(second)).toEqual({
			sign: 'out',
			mappingId: mapping.id
		});
	});

	/**
	 * NOTE PASS N3. Separates « rows the kept answer turned into the mirror of rows already stored are
	 * named on the summary » from « skipped in silence ». June is first stored as money in (the old
	 * default, answered here), then the format's answer becomes money out, and June comes again.
	 */
	it('names the rows skipped as mirrors of stored ones', async () => {
		expect.assertions(3);
		const who = await seedUser('mirror-auto');
		await designate(who, JUNE, { amountSign: 'in' });
		await designate(who, statement(['21/09/2026;CB FNAC;45,00'], 'sept.csv'), {
			amountSign: 'out'
		});
		const again = await upload(
			who,
			statement(['24/06/2026;CB CARREFOUR;24,90', '22/06/2026;CB ORANGE;39,99'], 'juin-bis.csv')
		);
		const summary = (again as unknown as { importResult?: Record<string, unknown> }).importResult;
		expect(again.status).toBeUndefined();
		expect(summary?.mirrorRows).toBe(2);
		expect(summary?.mirrorStoredAs).toBe('in');
	});

	/** Separates « a file whose own signs decided says nothing » from « the line shows anyway ». */
	it('says nothing on the summary of a statement that carries its own signs', async () => {
		expect.assertions(2);
		const who = await seedUser('signed-summary');
		await designate(who, JUNE, { amountSign: 'out' });
		const signed = await upload(who, AUGUST_SIGNED);
		expect(signed.status).toBeUndefined();
		expect(keptOf(signed)).toBeNull();
	});
});

describe(`#1294, the answer outside the import doors, on ${process.env.DATABASE_PROVIDER ?? 'the configured engine'}`, () => {
	/**
	 * THE BACKUP. Separates « a restore brings the answer back » from « it drops it », measured by the
	 * next upload rather than by the column: the restore is a full replacement, so the statement that
	 * follows is read only through what the restore wrote.
	 */
	it('imports the next statement with no question after an export and a restore', async () => {
		expect.assertions(2);
		const who = await seedUser('restore');
		await designate(who, JUNE, { amountSign: 'out' });
		const file = JSON.parse(JSON.stringify(await buildBackupExport(who.userId)));
		await restoreBackup(who.userId, backupExportSchema.parse(file));
		const account = await prisma.account.findFirstOrThrow({
			where: { userId: who.userId, name: 'Compte courant' },
			select: { id: true }
		});
		const next = await upload({ userId: who.userId, accountId: account.id }, JULY);
		expect(next.status).toBeUndefined();
		expect((await storedTypes(who.userId)).filter((row) => /MONOPRIX|SNCF/.test(row))).toEqual([
			'CB MONOPRIX expense',
			'CB SNCF expense'
		]);
	});

	/**
	 * THE EXPORT READS THROUGH THE ONE READER (pass 2, export spread). Separates « an answer whose key
	 * no longer matches goes out as none » from « the raw column leaves by the spread », which a
	 * restore would then key as a fact on another instance.
	 */
	it('exports an answer a writer left behind as none', async () => {
		expect.assertions(2);
		const who = await seedUser('stale-export');
		await designate(who, JUNE, { amountSign: 'out' });
		const before = JSON.parse(JSON.stringify(await buildBackupExport(who.userId)));
		const mapping = await prisma.columnMapping.findFirstOrThrow({ where: { userId: who.userId } });
		await prisma.columnMapping.update({
			where: { id: mapping.id },
			data: { layersKey: layersKeyOf({ ...mapping, amountSign: null, amountSignAccountId: null }) }
		});
		const after = JSON.parse(JSON.stringify(await buildBackupExport(who.userId)));
		// Positive control first: the same export carries the answer while its key matches.
		expect(before.columnMappings[0].amountSign).toBe('out');
		expect(after.columnMappings[0].amountSign).toBeNull();
	});

	/**
	 * A BACKUP IS AN UPLOADED FILE. Separates « a value outside the closed pair is refused as a
	 * malformed backup » from « it is written and later read as no answer, or worse, as one ».
	 */
	it('refuses a backup whose answer is outside the closed pair', async () => {
		expect.assertions(1);
		const who = await seedUser('hostile-backup');
		await designate(who, JUNE, { amountSign: 'out' });
		const file = JSON.parse(JSON.stringify(await buildBackupExport(who.userId)));
		file.columnMappings[0].amountSign = 'expense';
		expect(backupExportSchema.safeParse(file).success).toBe(false);
	});

	/**
	 * AN ANSWER BELONGS TO THE COLUMNS IT WAS GIVEN FOR. Separates « a writer that moves the amount
	 * column without the integrity key leaves the answer unread » from « the old answer is applied to
	 * whatever column now holds Amount ». Modelled as the layers' suite models it: an update that
	 * moves a role column and leaves the rest, which is what a writer older than 1.4 does.
	 */
	it('asks again once a writer that does not know the answer re-saves the correspondance', async () => {
		expect.assertions(2);
		const who = await seedUser('moved');
		await designate(who, JUNE, { amountSign: 'out' });
		const mapping = await prisma.columnMapping.findFirstOrThrow({ where: { userId: who.userId } });
		// What `saveColumnMapping` wrote before #1294 (note pass N1): the key over the columns alone,
		// computed by the production function, the answer columns left as they were.
		await prisma.columnMapping.update({
			where: { id: mapping.id },
			data: { layersKey: layersKeyOf({ ...mapping, amountSign: null, amountSignAccountId: null }) }
		});
		const asked = await upload(who, JULY);
		expect(asked.status).toBe(400);
		expect(asked.data?.error).toBe(m.import_refusal_ambiguous_amount_sign({ sample: '18,40' }));
	});
});
