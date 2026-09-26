import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from '$lib/server/import/persist';
import { parseCsvTransactions } from '$lib/server/import/csv';
import { DeclaredCurrencyMismatchError } from '$lib/server/import/declaredCurrency';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import * as m from '$lib/paraglide/messages';
import { answerKeyFor } from '$lib/server/import/answerBinding';
import { createStatementAccount } from '$lib/server/accounts/service';
import { N26_LEGACY_HEADERS } from '$lib/server/import/profiles/realHeaders.fixture';
import { actions as importActions } from './+page.server';
import { actions as columnsActions } from './columns/+page.server';

/**
 * #600: A FILE THAT DECLARES ITS CURRENCY, FILED INTO AN ACCOUNT HELD IN ANOTHER ONE.
 *
 * ## What this measured first, before anything was fixed (M1)
 *
 * Whether it could happen at all. A CSV import reaches a non-EUR account only through an account the
 * bank-sync connector created, because `createStatementAccount` took no currency and every
 * statement account was EUR (since #741 it takes the declared one, from an allow list of EUR
 * alone, so that is still true). So the fixture seeds one exactly the way `banking/sync/service.ts` does,
 * through `resolveImportBucketAccount` with the provider's source, a `providerAccountId` and the
 * provider's currency, and then asks the question through the REAL ROUTE ACTIONS, the same functions
 * a browser POST reaches. Nothing in this file resolves a destination or parses a file itself.
 *
 * Measured on `main` (df9ca1c) before the fix, on SQLite: the auto path offered the USD account in
 * its account question, the generic file declaring `EUR` imported 2 rows into it, and both rows were
 * stored `currency = USD`. Same for the designation path and for a Revolut file. The calibration in
 * the same pass, the same file into a EUR statement account, stored `EUR`. So the unit a user reads
 * beside every amount of that import was the account's, while the file had said otherwise. The same
 * figures came back on PostgreSQL and MariaDB with the declaration removed at the parse, which is the
 * pre-fix state of every check this file covers.
 *
 * ## What it asserts now
 *
 * Refused, naming BOTH currencies, and nothing written: no transaction, no batch. The calibration
 * runs in the same pass, per door, as its own test (two figures in one test leave the second
 * unobserved whenever the first is red), because a refusal that also fired on a EUR account would
 * be a different defect: a file that can no longer be imported at all.
 *
 * ## Why db-smoke and not a unit spec
 *
 * The figure is a stored column. A fake decides what `create` receives and what `findMany` returns,
 * so « the row was stored USD » and « the fake echoed what it was given » would be the same green.
 */

/** The two dates are ISO on purpose: this file is about currency, and an ambiguous `06/01/2026`
 *  would make the auto path ask its date reading before it ever reached the destination. */
const GENERIC_DECLARING_EUR = [
	'date,label,amount,currency',
	'2026-06-03,Boulangerie Mercier,-4.20,EUR',
	'2026-06-14,Virement salaire,1850.00,EUR'
].join('\n');

/** Headers no profile recognises, so the file reaches the designation screen, plus a `Devise`
 *  column the mapped profile reads as the file's declaration. */
const OPAQUE_DECLARING_EUR = [
	'poste_1,poste_2,poste_3,Devise',
	'2026-06-03,Boulangerie Mercier,-4.20,EUR',
	'2026-06-14,Virement salaire,1850.00,EUR'
].join('\n');

/** Revolut's French export, whose `Devise` column is part of the profile's own ten. */
const REVOLUT_DECLARING_EUR = [
	'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde',
	'CARD_PAYMENT,Current,2026-06-03 09:21:00,2026-06-03 09:21:00,Boulangerie Mercier,-4.20,0.00,EUR,TERMINÉ,1200.00',
	'TOPUP,Current,2026-06-14 10:10:00,2026-06-14 10:10:00,Virement salaire,1850.00,0.00,EUR,TERMINÉ,3050.00'
].join('\n');

/**
 * The sentence the route must return, compared WHOLE (AGENTS.md: a substring passes over a doubled
 * tail). Built by calling the renderer with the fact this refusal must carry, so what is asserted is
 * that the route handed the renderer THIS fact; `declaredCurrency.spec.ts` pins the French literal.
 */
const EUR_INTO_USD = refusalLabel({
	code: 'declared-currency-mismatch',
	declared: 'EUR',
	destination: 'USD'
});

function fileOf(text: string, name = 'releve.csv'): File {
	return new File([text], name, { type: 'text/csv' });
}

function eventOf(userId: string, fields: Record<string, string | File>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		locals: { user: { id: userId } },
		request: new Request('http://localhost/import', { method: 'POST', body }),
		// ONE ADDRESS PER USER, not one for the file. The import limiter counts per address as well as
		// per user (60 in its window), so a shared address trips after five runs of this file and every
		// later run reads 429s as findings: measured during this file's own break-check, where the
		// calibrations went red from the second break on. The value is hashed, never parsed.
		getClientAddress: () => `client-${userId}`
	} as unknown as Parameters<NonNullable<typeof importActions.default>>[0];
}

type ActionOutcome = { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;

/**
 * `/import` reads an answer only when it is BOUND to the file in the same request
 * (`answerBinding.ts`, #718): the page posts back as `answersFor` the key the server handed it with
 * the question. The key is `answerKeyFor` of the bytes, so it is computed here by the same function
 * rather than retyped; without it every posted `accountId` is dropped and the file is asked again.
 */
async function postImport(userId: string, fields: Record<string, string | File>) {
	const file = fields.csvFile;
	const bound =
		file instanceof File && !('answersFor' in fields)
			? { ...fields, answersFor: await answerKeyFor(file) }
			: fields;
	return (await importActions.default!(eventOf(userId, bound))) as ActionOutcome;
}

async function postColumns(userId: string, fields: Record<string, string | File>) {
	return (await columnsActions.default!(eventOf(userId, fields))) as ActionOutcome;
}

/** A fresh user holding the three accounts every test needs. */
async function seedUser(tag: string) {
	const user = await prisma.user.create({
		data: { email: `declared-${tag}-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	// The account bank sync creates: same function, same fields, `service.ts` connectAccounts.
	const usd = await resolveImportBucketAccount({
		userId: user.id,
		name: 'Checking USD',
		source: 'enablebanking',
		denomination: { currency: 'USD', exponent: 2 },
		providerAccountId: `uid-${tag}-usd`,
		providerCashAccountType: 'CACC'
	});
	// TWO statement accounts, so the auto path cannot choose by source and asks. That question is
	// the ordinary door through which a user reaches the synced account from `/import`.
	const eur = await createStatementAccount({ userId: user.id, name: 'Compte courant' });
	const joint = await createStatementAccount({ userId: user.id, name: 'Compte joint' });
	return { userId: user.id, usdId: usd.accountId, eurId: eur.id, jointId: joint.id };
}

async function storedIn(userId: string, accountId: string) {
	return prisma.transaction.findMany({
		where: { userId, accountId },
		select: { currency: true, exponent: true, label: true },
		orderBy: { label: 'asc' }
	});
}

beforeAll(() => {
	// The limiter's HMAC key, as an explicit fixture: see `accounts/createAccount.db-smoke.ts`.
	env.RATE_LIMIT_HASH_SECRET = 'b2'.repeat(32);
});

/**
 * Each door, as it posts. Three shapes of file reach a declared currency: `generic` (alias table),
 * `mapped` (a designation) and `revolut` (its own ten columns). `declaredCurrency.spec.ts` proves at
 * the parse that every registered profile carries a declaration out; this proves at the route that
 * what is carried out is compared before anything is written.
 */
const DOORS = [
	{
		name: '/import, generic',
		post: (userId: string, accountId: string) =>
			postImport(userId, { csvFile: fileOf(GENERIC_DECLARING_EUR), accountId })
	},
	{
		name: '/import/columns, mapped',
		post: (userId: string, accountId: string) =>
			postColumns(userId, {
				csvFile: fileOf(OPAQUE_DECLARING_EUR),
				dateIndex: '0',
				labelIndex: '1',
				amountIndex: '2',
				remember: 'false',
				accountId
			})
	},
	{
		name: '/import, revolut',
		post: (userId: string, accountId: string) =>
			postImport(userId, { csvFile: fileOf(REVOLUT_DECLARING_EUR), accountId })
	}
] as const;

describe('#600: a declared currency the destination contradicts is refused before anything is written', () => {
	/**
	 * Separates « a CSV import can reach a non-EUR account » from « nothing offers one », which is
	 * the question M1 existed to answer. Red here would mean the defect is latent and the refusal
	 * below guards a door nobody can open.
	 */
	it('the auto path offers the synced USD account as an import destination', async () => {
		expect.assertions(1);
		const { userId, usdId } = await seedUser('offer');
		const asked = await postImport(userId, { csvFile: fileOf(GENERIC_DECLARING_EUR) });
		const offered = (asked.data?.account as { options: Array<{ id: string }> } | undefined)
			?.options;
		expect(offered?.map((option) => option.id)).toContain(usdId);
	});

	/**
	 * Separates « refused, naming both currencies, nothing written » from « imported under the
	 * account's currency », which is what `main` did on every door (2 rows, both `USD`).
	 */
	it.each(DOORS)('$name: refuses EUR into the USD account and writes nothing', async (door) => {
		expect.assertions(4);
		const { userId, usdId } = await seedUser(`refuse-${door.name}`);

		const refused = await door.post(userId, usdId);
		const usdRows = await storedIn(userId, usdId);
		console.info(
			`[#600 M1] ${door.name} into USD: status=${refused.status ?? 200} stored=${JSON.stringify(usdRows.map((row) => row.currency))}`
		);
		expect(usdRows).toEqual([]);
		expect(await prisma.importBatch.count({ where: { userId } })).toBe(0);
		expect(refused.status).toBe(400);
		expect(refused.data?.error).toBe(EUR_INTO_USD);
	});

	/**
	 * THE CALIBRATION, in the same pass: the same file into a EUR account imports, stored `EUR`.
	 * Separates « the declaration is compared with the destination » from « a file declaring a
	 * currency can no longer be imported at all », which a refusal ignoring the destination would be.
	 */
	it.each(DOORS)('$name: calibration, stores EUR into a EUR account', async (door) => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser(`calibrate-${door.name}`);

		const accepted = await door.post(userId, eurId);
		const eurRows = await storedIn(userId, eurId);
		console.info(
			`[#600 M1] ${door.name} into EUR (calibration): status=${accepted.status ?? 200} stored=${JSON.stringify(eurRows.map((row) => row.currency))}`
		);
		expect(accepted.status).toBeUndefined();
		expect(eurRows.map((row) => row.currency)).toEqual(['EUR', 'EUR']);
	});

	/**
	 * The designation survives the refusal, because the repair is choosing another account on the
	 * screen the user is already on, not designating the columns again.
	 */
	it('/import/columns keeps the designation on the refusal', async () => {
		expect.assertions(1);
		const { userId, usdId } = await seedUser('keep');
		const refused = await DOORS[1].post(userId, usdId);
		expect(refused.data?.keepDesignation).toBe(true);
	});

	/**
	 * SECOND CONTRADICTION PASS F3: the designation screen can only say which accounts are in EUR if
	 * the refusal tells it which currency the file declared. Separates « the refusal hands the screen
	 * the declared currency » from « the screen reopens the panel knowing nothing was refused ».
	 */
	it('/import/columns names the declared currency on the refusal', async () => {
		expect.assertions(1);
		const { userId, usdId } = await seedUser('columns-declared');
		const refused = await DOORS[1].post(userId, usdId);
		expect(refused.data?.declaredCurrency).toBe('EUR');
	});

	/**
	 * THE REMEMBERED MAPPING, `/import`'s third caller and its most common repeat-import path: the
	 * file matches no profile, so `/import` parses it through a `ColumnMapping` this user saved on
	 * an earlier designation (`useMapping`, by header fingerprint) and shows no screen at all.
	 *
	 * The mapping is saved the way a user saves one, by designating on `/import/columns` with the
	 * memorisation left on. Then the same file goes through `/import` twice: into the USD account,
	 * and, as the calibration, into the second EUR account. The calibration's `profile === 'mapped'` is
	 * what proves the refusal was reached THROUGH the remembered mapping rather than through a
	 * parse that refused the file for its unrecognised headers.
	 *
	 * Separates « the silent reuse is compared with the destination » from « it is not », and the
	 * use count separates « refused before anything is written » from « refused after the mapping
	 * counted a use it did not have ».
	 */
	it('/import through a remembered mapping: refuses EUR into USD, imports into EUR as mapped', async () => {
		expect.assertions(7);
		const { userId, usdId, eurId, jointId } = await seedUser('remembered');
		const designated = await postColumns(userId, {
			csvFile: fileOf(OPAQUE_DECLARING_EUR),
			dateIndex: '0',
			labelIndex: '1',
			amountIndex: '2',
			accountId: eurId
		});
		expect(designated.status).toBeUndefined();
		const saved = await prisma.columnMapping.findFirst({
			where: { userId },
			select: { id: true, useCount: true }
		});
		expect(saved?.useCount).toBe(1);

		const refused = await postImport(userId, {
			csvFile: fileOf(OPAQUE_DECLARING_EUR),
			accountId: usdId
		});
		console.info(
			`[#600] remembered mapping into USD: status=${refused.status ?? 200} stored=${JSON.stringify((await storedIn(userId, usdId)).map((row) => row.currency))}`
		);
		expect(refused.status).toBe(400);
		expect(refused.data?.error).toBe(EUR_INTO_USD);
		expect(await storedIn(userId, usdId)).toEqual([]);
		expect(
			(await prisma.columnMapping.findFirst({ where: { userId }, select: { useCount: true } }))
				?.useCount
		).toBe(1);

		// `confirmCollision`: the same statement already sits in the first EUR account, so the
		// duplicate-statement question fires first (measured: 409). Answering it is the user's step,
		// and it is not what this calibration is about.
		const accepted = await postImport(userId, {
			csvFile: fileOf(OPAQUE_DECLARING_EUR),
			accountId: jointId,
			confirmCollision: '1'
		});
		expect((accepted.importResult as { profile?: string } | undefined)?.profile).toBe('mapped');
	});

	/**
	 * THE WAY FORWARD after the refusal (item 6). The sentence ends « Choisissez un compte en EUR »,
	 * and a user who reads nothing else must find a control that does it on the same screen. MEASURED
	 * by a browser walk before this: the refusal came with no account control at all, and pressing
	 * « Importer le relevé » again was the only way back to the question, with nothing saying so.
	 *
	 * Separates « the refusal carries the account question, offering the accounts this file CAN go
	 * into » from « a sentence naming a choice the screen does not offer ».
	 */
	it('/import: the currency refusal carries the account question, with the EUR accounts in it', async () => {
		expect.assertions(3);
		const { userId, usdId, eurId, jointId } = await seedUser('recovery');
		const refused = await postImport(userId, {
			csvFile: fileOf(GENERIC_DECLARING_EUR),
			accountId: usdId
		});
		const offered = (
			refused.data?.account as { options: Array<{ id: string }> } | undefined
		)?.options.map((option) => option.id);
		console.info(`[#600 recovery] refusal offers: ${JSON.stringify(offered ?? null)}`);
		expect(refused.data?.error).toBe(EUR_INTO_USD);
		expect(offered).toContain(eurId);
		expect(offered).toContain(jointId);
	});

	/**
	 * THE PANEL CAN SAY WHICH ACCOUNTS ARE IN EUROS (canvas C3kxndh3wM3SwYtRQwpsGr). The refusal asks
	 * for « un compte en EUR », so each offered option carries the currency its account holds, and
	 * the offer carries the currency the file declared, which is what the panel mutes the others
	 * against. Separates « the server hands the screen what it needs to answer the sentence » from
	 * « the screen is asked to name a currency nobody sent it ».
	 */
	it('/import: the refusal offers each account with its currency, and names the declared one', async () => {
		expect.assertions(3);
		const { userId, usdId, eurId } = await seedUser('recovery-currency');
		const refused = await postImport(userId, {
			csvFile: fileOf(GENERIC_DECLARING_EUR),
			accountId: usdId
		});
		const account = refused.data?.account as
			{ options: Array<{ id: string; currency?: string }>; declaredCurrency?: string } | undefined;
		const currencyOf = (id: string) =>
			account?.options.find((option) => option.id === id)?.currency;
		expect(currencyOf(eurId)).toBe('EUR');
		expect(currencyOf(usdId)).toBe('USD');
		expect(account?.declaredCurrency).toBe('EUR');
	});

	/**
	 * THE ORDER, through the route (the owner's second addition): a file whose dates read both ways
	 * AND which declares EUR, for a user holding two statement accounts and the synced USD one.
	 *
	 * Before: the account question, then (with USD answered) the DATE question, and only once that
	 * was answered the currency refusal, so the user answered a question about a file already
	 * doomed. After: the refusal comes right after the account, before any reading is asked.
	 *
	 * The calibration is the same file answered with a EUR account, which must still be asked its
	 * reading: separates « the refusal outranks the date question » from « the date question is no
	 * longer asked at all ».
	 */
	it('/import: an ambiguous file declaring EUR is refused into USD before its dates are asked', async () => {
		expect.assertions(7);
		const { userId, usdId, eurId } = await seedUser('order');
		const AMBIGUOUS_DECLARING_EUR = [
			'date,label,amount,currency',
			'01/02/2026,Boulangerie Mercier,-4.20,EUR',
			'03/02/2026,Virement salaire,1850.00,EUR'
		].join('\n');
		const file = () => fileOf(AMBIGUOUS_DECLARING_EUR);

		const asked = await postImport(userId, { csvFile: file() });
		expect(asked.data?.error).toBe(m.import_account_error_ambiguous_auto());

		const intoUsd = await postImport(userId, { csvFile: file(), accountId: usdId });
		console.info(
			`[#600 order] ambiguous EUR file, USD answered: error="${String(intoUsd.data?.error)}"`
		);
		expect(intoUsd.status).toBe(400);
		expect(intoUsd.data?.error).toBe(EUR_INTO_USD);
		expect(intoUsd.data?.reading).toBeUndefined();
		// The refused account is not kept, so the page stops posting it and the next press asks the
		// account again rather than refusing the same answer for ever.
		expect(
			(intoUsd.data?.answers as { accountId?: string | null } | undefined)?.accountId
		).toBeNull();
		expect(await storedIn(userId, usdId)).toEqual([]);

		const intoEur = await postImport(userId, { csvFile: file(), accountId: eurId });
		expect(intoEur.data?.error).toBe(m.import_error_ambiguous_date_order());
	});

	/**
	 * SECOND CONTRADICTION PASS F1, through both designated doors: N26's legacy French and German
	 * exports name their amount column `Montant (EUR)` and `Betrag (EUR)`. MEASURED before the fix:
	 * `/import/columns` and `/import`'s remembered-mapping reuse both stored `["USD","USD"]` into the
	 * USD account. Separates « an amount header named for its currency declares, in any language »
	 * from « only `Amount (EUR)` does ».
	 */
	const N26_LEGACY = (name: string) =>
		N26_LEGACY_HEADERS.find(([label]) => label === name)![1]
			.split(',')
			.map((cell) => cell.slice(1, -1));
	function legacyFile(name: string, amountHeader: string, labelHeader: string) {
		const cells = N26_LEGACY(name);
		const row = (date: string, label: string, amount: string) =>
			cells
				.map((cell) =>
					cell === cells[0]
						? date
						: cell === labelHeader
							? label
							: cell === amountHeader
								? amount
								: ''
				)
				.map((cell) => `"${cell}"`)
				.join(',');
		return [
			cells.map((cell) => `"${cell}"`).join(','),
			row('2026-06-03', 'Boulangerie Mercier', '-4.20'),
			row('2026-06-14', 'Virement salaire', '1850.00')
		].join('\n');
	}
	const legacyDesignation = (name: string, labelHeader: string, amountHeader: string) => {
		const cells = N26_LEGACY(name);
		return {
			dateIndex: '0',
			labelIndex: String(cells.indexOf(labelHeader)),
			amountIndex: String(cells.indexOf(amountHeader))
		};
	};

	it('/import/columns: N26 legacy FR Montant (EUR) refuses the file into USD', async () => {
		expect.assertions(3);
		const { userId, usdId } = await seedUser('n26-fr');
		const refused = await postColumns(userId, {
			csvFile: fileOf(legacyFile('N26 legacy FR', 'Montant (EUR)', 'Bénéficiaire')),
			...legacyDesignation('N26 legacy FR', 'Bénéficiaire', 'Montant (EUR)'),
			remember: 'false',
			accountId: usdId
		});
		const usdRows = await storedIn(userId, usdId);
		console.info(
			`[#600 C2-F1] N26 legacy FR designated into USD: status=${refused.status ?? 200} stored=${JSON.stringify(usdRows.map((row) => row.currency))}`
		);
		expect(usdRows).toEqual([]);
		expect(refused.status).toBe(400);
		expect(refused.data?.error).toBe(EUR_INTO_USD);
	});

	it('/import through a remembered mapping: N26 legacy DE Betrag (EUR) refuses the file into USD', async () => {
		expect.assertions(3);
		const { userId, usdId, eurId } = await seedUser('n26-de');
		const content = legacyFile('N26 legacy DE', 'Betrag (EUR)', 'Empfänger');
		// Saved the way a user saves one: designated on `/import/columns`, memorisation on.
		await postColumns(userId, {
			csvFile: fileOf(content),
			...legacyDesignation('N26 legacy DE', 'Empfänger', 'Betrag (EUR)'),
			accountId: eurId
		});
		const refused = await postImport(userId, {
			csvFile: fileOf(content),
			accountId: usdId,
			confirmCollision: '1'
		});
		const usdRows = await storedIn(userId, usdId);
		console.info(
			`[#600 C2-F1] N26 legacy DE remembered into USD: status=${refused.status ?? 200} stored=${JSON.stringify(usdRows.map((row) => row.currency))}`
		);
		expect(usdRows).toEqual([]);
		expect(refused.status).toBe(400);
		expect(refused.data?.error).toBe(EUR_INTO_USD);
	});

	/**
	 * CONTRADICTION PASS F1, through the route: N26's own header, whose `Amount (EUR)` names the
	 * currency. MEASURED by the contradiction pass before the fix: 200, stored `["USD","USD"]`.
	 * Separates « a currency declared in the amount header is compared » from « only a currency
	 * column is ».
	 */
	it('/import: N26 Amount (EUR) refuses the file into USD', async () => {
		expect.assertions(3);
		const { userId, usdId } = await seedUser('n26');
		const refused = await postImport(userId, {
			csvFile: fileOf(
				[
					'"Booking Date","Value Date","Partner Name","Partner Iban","Type","Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"',
					'"2026-06-03","2026-06-03","Boulangerie Mercier","","MasterCard Payment","","Main Account","-4.20","","",""',
					'"2026-06-14","2026-06-14","Virement salaire","","Credit Transfer","","Main Account","1850.00","","",""'
				].join('\n')
			),
			accountId: usdId
		});
		const usdRows = await storedIn(userId, usdId);
		console.info(
			`[#600 F1] N26 Amount (EUR) into USD: status=${refused.status ?? 200} stored=${JSON.stringify(usdRows.map((row) => row.currency))}`
		);
		expect(usdRows).toEqual([]);
		expect(refused.status).toBe(400);
		expect(refused.data?.error).toBe(EUR_INTO_USD);
	});

	/**
	 * SECOND CONTRADICTION PASS F2, through the route. The destination is KNOWN without a question:
	 * the user's one statement account is held in USD, which only a restore can produce
	 * (`createStatementAccount` always writes EUR, a backup carries its own currency), so the fixture
	 * sets it the way the restore leaves it. The file declares EUR and carries a digit column the
	 * door cannot read as accounts or not. MEASURED before the fix: the reply was the account-column
	 * question, and the currency refusal came only after it was answered.
	 */
	it('/import: a known USD destination refuses a EUR file before asking about its account column', async () => {
		expect.assertions(2);
		const user = await prisma.user.create({
			data: {
				email: `declared-restored-${Date.now()}@example.test`,
				passwordHash: 'x',
				role: 'USER'
			}
		});
		const restored = await createStatementAccount({ userId: user.id, name: 'Compte restauré' });
		await prisma.account.update({ where: { id: restored.id }, data: { currency: 'USD' } });
		const asked = await postImport(user.id, {
			csvFile: fileOf(
				[
					'date,label,amount,compte,currency',
					'2026-06-01,Salaire,2500.50,12349032,EUR',
					'2026-06-02,Courses,-42.10,12340185,EUR'
				].join('\n')
			)
		});
		console.info(
			`[#600 C2-F2] restored USD bucket, EUR file: error="${String(asked.data?.error)}"`
		);
		expect(asked.data?.error).toBe(EUR_INTO_USD);
		expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0);
	});

	/**
	 * SECOND CONTRADICTION PASS F4, through the route: a file writing `€` in its currency column,
	 * with a blank cell on another row. MEASURED before the fix: the `€` row refused as
	 * `unsupported-currency` and the blank row stored `["USD"]`. Separates « `€` is the file saying
	 * euro » from « a symbol the import does not read ».
	 */
	it('/import: a currency column writing € refuses the file into USD', async () => {
		expect.assertions(3);
		const { userId, usdId } = await seedUser('euro-sign');
		const refused = await postImport(userId, {
			csvFile: fileOf(
				[
					'date,label,amount,currency',
					'2026-06-03,Boulangerie,-4.20,€',
					'2026-06-14,Salaire,1850.00,'
				].join('\n')
			),
			accountId: usdId
		});
		const usdRows = await storedIn(userId, usdId);
		console.info(
			`[#600 C2-F4] € column into USD: status=${refused.status ?? 200} stored=${JSON.stringify(usdRows.map((row) => row.currency))}`
		);
		expect(usdRows).toEqual([]);
		expect(refused.status).toBe(400);
		expect(refused.data?.error).toBe(EUR_INTO_USD);
	});

	/**
	 * CONTRADICTION PASS F3, through the route. `currency` blank, `devise` reading EUR. MEASURED
	 * before the fix: 200, stored `["USD","USD"]`. Separates « every declaring column is read »
	 * from « only the first one present ».
	 */
	it('/import: devise declaring EUR beside a blank currency column refuses the file into USD', async () => {
		expect.assertions(3);
		const { userId, usdId } = await seedUser('devise');
		const refused = await postImport(userId, {
			csvFile: fileOf(
				[
					'date,label,amount,currency,devise',
					'2026-06-03,Boulangerie Mercier,-4.20,,EUR',
					'2026-06-14,Virement salaire,1850.00,,EUR'
				].join('\n')
			),
			accountId: usdId
		});
		const usdRows = await storedIn(userId, usdId);
		console.info(
			`[#600 F3] devise beside blank currency into USD: status=${refused.status ?? 200} stored=${JSON.stringify(usdRows.map((row) => row.currency))}`
		);
		expect(usdRows).toEqual([]);
		expect(refused.status).toBe(400);
		expect(refused.data?.error).toBe(EUR_INTO_USD);
	});

	/**
	 * CONTRADICTION PASS F2, through the route. The only row declaring EUR is refused for its date
	 * and the other row leaves the cell blank. MEASURED before the fix: 200, stored `["USD"]`, while
	 * the same file with a valid first date was refused. Separates « the file's declaration is read
	 * off every row » from « off the rows that survived ».
	 */
	it('/import: a declaration on a row refused for its date still refuses the file into USD', async () => {
		expect.assertions(3);
		const { userId, usdId } = await seedUser('refused-row');
		const refused = await postImport(userId, {
			csvFile: fileOf(
				['date,label,amount,currency', 'not-a-date,A,-4.20,EUR', '2026-06-14,B,1850.00,'].join('\n')
			),
			accountId: usdId
		});
		const usdRows = await storedIn(userId, usdId);
		console.info(
			`[#600 F2] refused-row declaration into USD: status=${refused.status ?? 200} stored=${JSON.stringify(usdRows.map((row) => row.currency))}`
		);
		expect(usdRows).toEqual([]);
		expect(refused.status).toBe(400);
		expect(refused.data?.error).toBe(EUR_INTO_USD);
	});

	/**
	 * The `by-source` branch of `/import`'s destination, which the tests above never take (they post
	 * an account). Separates « compared with the bucket the rows will land in » from « compared with
	 * something else » on the path most imports take: a user with no account yet, whose first import
	 * creates one at the default denomination, and a user with exactly one statement account.
	 */
	it.each([
		{ name: 'no account yet', statementAccounts: 0 },
		{ name: 'one statement account', statementAccounts: 1 }
	])('/import by source, $name: a file declaring EUR imports, stored EUR', async (shape) => {
		expect.assertions(2);
		const user = await prisma.user.create({
			data: {
				email: `declared-bysource-${shape.statementAccounts}-${Date.now()}@example.test`,
				passwordHash: 'x',
				role: 'USER'
			}
		});
		if (shape.statementAccounts === 1)
			await createStatementAccount({ userId: user.id, name: 'Compte courant' });

		const accepted = await postImport(user.id, { csvFile: fileOf(GENERIC_DECLARING_EUR) });
		const rows = await prisma.transaction.findMany({
			where: { userId: user.id },
			select: { currency: true }
		});
		expect(accepted.status).toBeUndefined();
		expect(rows.map((row) => row.currency)).toEqual(['EUR', 'EUR']);
	});

	/**
	 * THE THIRD CALL, in `persistImportedTransactions`. This test performs the parse and the write
	 * ITSELF, which no route does without its own check first: it measures that a writer which
	 * skipped the routes' comparison still cannot store a declared EUR row as USD, not that the
	 * application reaches this throw. Separates « refused before the first transaction row » from
	 * « written ». The batch this test created first is still there: the backstop protects rows, not
	 * the batch (see the comment at the throw).
	 */
	it('persist refuses a writer that skipped the comparison, before the first row', async () => {
		expect.assertions(2);
		const { userId, usdId } = await seedUser('persist');
		const batchId = await batchFor(userId, usdId);
		await expect(
			persistImportedTransactions({
				userId,
				accountId: usdId,
				importBatchId: batchId,
				source: 'csv',
				transactions: parseCsvTransactions(GENERIC_DECLARING_EUR).transactions
			})
		).rejects.toBeInstanceOf(DeclaredCurrencyMismatchError);
		expect(await storedIn(userId, usdId)).toEqual([]);
	});

	/**
	 * The persist check's calibration: rows that declare NOTHING still land in the USD account, as
	 * bank sync and a file with no currency column always have. Separates « compared with the
	 * declaration » from « refused for any non-EUR bucket ».
	 */
	it('persist still writes undeclared rows into the USD account, stored USD', async () => {
		expect.assertions(1);
		const { userId, usdId } = await seedUser('persist-undeclared');
		await persistImportedTransactions({
			userId,
			accountId: usdId,
			importBatchId: await batchFor(userId, usdId),
			source: 'csv',
			transactions: parseCsvTransactions(
				['date,label,amount', '2026-06-03,Boulangerie Mercier,-4.20'].join('\n')
			).transactions
		});
		expect((await storedIn(userId, usdId)).map((row) => row.currency)).toEqual(['USD']);
	});
});

async function batchFor(userId: string, accountId: string): Promise<string> {
	return createImportBatch({
		userId,
		accountId,
		source: 'csv',
		fileName: 'releve.csv',
		profile: 'generic',
		rowCount: 1,
		invalidRows: 0,
		period: { from: null, to: null }
	});
}
