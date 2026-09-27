import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import * as m from '$lib/paraglide/messages';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import { answerKeyFor } from '$lib/server/import/answerBinding';
import { resolveImportBucketAccount } from '$lib/server/import/persist';
import { actions as importActions } from '../+page.server';
import { POST } from './+server';

/**
 * THE ALLOW LIST, WIDENED ON DEMAND, and why a test needs it at all.
 *
 * The one currency a file may declare and still import is EUR (`ACCEPTED_CURRENCY`), and EUR is
 * also the application default a created account falls back to. So on today's allow list no
 * request can tell « the account is held in the currency the page posted » from « the posted
 * currency was ignored and the default applied »: both store EUR. Widening the list to USD for one
 * test is the only way to reach the state where the two differ, and that test is the one the break
 * (the endpoint not passing the resolved denomination on) reddens. Everything else in this file runs
 * on the real list.
 */
const widened = vi.hoisted(() => ({ on: false }));
vi.mock('$lib/server/import/currencyDeclaration', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/import/currencyDeclaration')>();
	return {
		...actual,
		accountDenominationFor: (declared: string) =>
			widened.on && declared === 'USD'
				? { currency: 'USD', exponent: 2 }
				: actual.accountDenominationFor(declared)
	};
});

/**
 * #741: THE WAY FORWARD FROM THE CURRENCY REFUSAL, THROUGH THE ROUTES.
 *
 * A user whose only account is held in USD (a `csv` bucket, as a restore can leave one) uploads a
 * statement declaring EUR. `/import` refuses it and asks for « un compte en EUR »; the page's
 * « Nouveau compte » posts to `/import/accounts` with the currency the refusal named; the next
 * import files the rows into the new account. Every step here is a route handler a browser POST
 * reaches, and the currency posted to the create is READ OFF the refusal's own payload, never
 * retyped, so what is asserted is that the page can hand back what the server handed it.
 *
 * db-smoke because the figure is a stored column: a fake decides what `create` receives.
 */

/** ISO dates on purpose: an ambiguous one would make `/import` ask its reading first. */
const GENERIC_DECLARING_EUR = [
	'date,label,amount,currency',
	'2026-06-03,Boulangerie Mercier,-4.20,EUR',
	'2026-06-14,Virement salaire,1850.00,EUR'
].join('\n');

const EUR_INTO_USD = refusalLabel({
	code: 'declared-currency-mismatch',
	declared: 'EUR',
	destination: 'USD'
});

function fileOf(text: string): File {
	return new File([text], 'releve.csv', { type: 'text/csv' });
}

function requestOf(url: string, fields: Record<string, string | File>): Request {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return new Request(url, { method: 'POST', body });
}

type ActionOutcome = { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;

/** `/import`, with every answer bound to the file as the page binds it (`answerBinding.ts`). */
async function postImport(userId: string, fields: Record<string, string | File>) {
	const file = fields.csvFile as File;
	const event = {
		locals: { user: { id: userId } },
		request: requestOf('http://localhost/import', {
			...fields,
			answersFor: await answerKeyFor(file)
		}),
		// One address per user: the import limiter counts per address too (#693).
		getClientAddress: () => `client-${userId}`
	} as unknown as Parameters<NonNullable<typeof importActions.default>>[0];
	return (await importActions.default!(event)) as ActionOutcome;
}

async function postCreate(userId: string, fields: Record<string, string | File>) {
	const response = await POST({
		locals: { user: { id: userId } },
		request: requestOf('http://localhost/import/accounts', fields),
		getClientAddress: () => `client-${userId}`
	} as unknown as Parameters<typeof POST>[0]);
	return {
		status: response.status,
		body: (await response.json()) as { error?: string; field?: string; account?: { id: string } }
	};
}

/** A fresh user whose ONLY account is a `csv` bucket held in USD. */
async function seedUsdOnlyUser(tag: string) {
	const user = await prisma.user.create({
		data: { email: `c741-${tag}-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const usd = await resolveImportBucketAccount({
		userId: user.id,
		name: 'Checking USD',
		source: 'csv',
		denomination: { currency: 'USD', exponent: 2 }
	});
	return { userId: user.id, usdId: usd.accountId };
}

/** The refusal `/import` answers this user's EUR statement with, and the currency it names. */
async function refusalFor(userId: string) {
	const refused = await postImport(userId, { csvFile: fileOf(GENERIC_DECLARING_EUR) });
	const account = refused.data?.account as { declaredCurrency?: string } | undefined;
	return { refused, declaredCurrency: account?.declaredCurrency };
}

async function accountsOf(userId: string) {
	return prisma.account.findMany({
		where: { userId },
		select: { id: true, name: true, currency: true, exponent: true },
		orderBy: { name: 'asc' }
	});
}

beforeAll(() => {
	// The limiter's HMAC key, as an explicit fixture: see `createAccount.db-smoke.ts`.
	env.RATE_LIMIT_HASH_SECRET = 'c7'.repeat(32);
});

beforeEach(() => {
	widened.on = false;
});

describe('#741: an account created from the currency refusal is held in the declared currency', () => {
	it('/import refuses the EUR statement into the only account, naming EUR for the panel', async () => {
		// The starting state, measured rather than assumed: without it every figure below could be
		// about a user who was never refused.
		const { userId } = await seedUsdOnlyUser('refused');
		const { refused, declaredCurrency } = await refusalFor(userId);
		expect({ status: refused.status, error: refused.data?.error, declaredCurrency }).toEqual({
			status: 400,
			error: EUR_INTO_USD,
			declaredCurrency: 'EUR'
		});
	});

	it('the create, posted with the refusal’s currency, stores the account in EUR at exponent 2', async () => {
		const { userId } = await seedUsdOnlyUser('create');
		const { declaredCurrency } = await refusalFor(userId);
		const created = await postCreate(userId, {
			name: 'Compte joint',
			csvFile: fileOf(GENERIC_DECLARING_EUR),
			currency: declaredCurrency!
		});
		expect(created.status).toBe(200);
		const stored = await accountsOf(userId);
		expect(stored.map(({ name, currency, exponent }) => ({ name, currency, exponent }))).toEqual([
			{ name: 'Checking USD', currency: 'USD', exponent: 2 },
			{ name: 'Compte joint', currency: 'EUR', exponent: 2 }
		]);
	});

	it('the next « Importer le relevé » files both rows into the created account, stored EUR', async () => {
		// SEPARATES: « the refusal has a way forward that ends in an import » FROM « the created
		// account is refused like the first », the dead end #741 names.
		const { userId, usdId } = await seedUsdOnlyUser('import');
		const { declaredCurrency } = await refusalFor(userId);
		const created = await postCreate(userId, {
			name: 'Compte joint',
			csvFile: fileOf(GENERIC_DECLARING_EUR),
			currency: declaredCurrency!
		});
		const accountId = created.body.account!.id;

		const imported = await postImport(userId, {
			csvFile: fileOf(GENERIC_DECLARING_EUR),
			accountId
		});
		expect(imported.status).toBeUndefined();
		const rows = await prisma.transaction.findMany({
			where: { userId },
			select: { accountId: true, currency: true },
			orderBy: { amountCents: 'asc' }
		});
		expect(rows).toEqual([
			{ accountId, currency: 'EUR' },
			{ accountId, currency: 'EUR' }
		]);
		expect(rows.some((row) => row.accountId === usdId)).toBe(false);
	});

	it('the posted currency, not the default, decides: a widened allow list stores USD', async () => {
		// SEPARATES: « the endpoint creates the account in the currency it resolved » FROM « it
		// ignores the posted currency and applies the default » (the break: `denomination` not passed
		// to `createStatementAccount`). Only reachable on a widened list; see the mock's docstring.
		widened.on = true;
		const { userId } = await seedUsdOnlyUser('widened');
		const created = await postCreate(userId, {
			name: 'Compte dollars',
			csvFile: fileOf(GENERIC_DECLARING_EUR),
			currency: 'USD'
		});
		expect(created.status).toBe(200);
		const stored = await prisma.account.findFirst({
			where: { userId, name: 'Compte dollars' },
			select: { currency: true, exponent: true }
		});
		expect(stored).toEqual({ currency: 'USD', exponent: 2 });
	});

	it('refuses a currency off the allow list, with the generic sentence, and writes nothing', async () => {
		// SEPARATES: « a currency no file can be imported into is refused » FROM « it falls back to
		// the default and an account is created anyway » (the break: the `null` check removed). The
		// account count before the post is this test's starting figure.
		const { userId } = await seedUsdOnlyUser('off-list');
		expect((await accountsOf(userId)).length).toBe(1);
		const refused = await postCreate(userId, {
			name: 'Compte dollars',
			csvFile: fileOf(GENERIC_DECLARING_EUR),
			currency: 'USD'
		});
		expect(refused).toEqual({
			status: 400,
			body: { error: m.import_account_create_error_generic() }
		});
		expect((await accountsOf(userId)).length).toBe(1);
	});

	it('with no currency posted, the designation screen’s request, the account is the default', async () => {
		// SEPARATES: « absent means the default, as before #741 » FROM « absent is refused », which
		// would break the designation screen's create, the endpoint's other host.
		const { userId } = await seedUsdOnlyUser('absent');
		const created = await postCreate(userId, {
			name: 'Compte courant',
			csvFile: fileOf(GENERIC_DECLARING_EUR)
		});
		expect(created.status).toBe(200);
		const stored = await prisma.account.findFirst({
			where: { userId, name: 'Compte courant' },
			select: { currency: true, exponent: true }
		});
		expect(stored).toEqual({ currency: 'EUR', exponent: 2 });
	});
});
