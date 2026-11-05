import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import { resolveImportBucketAccount } from '$lib/server/import/persist';
import { createStatementAccount } from '$lib/server/accounts/service';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import * as m from '$lib/paraglide/messages';
import { actions as columnsActions } from './columns/+page.server';

/**
 * #1213: A HEADERLESS FILE DECLARES ITS CURRENCY THROUGH A COLUMN THE MEMBER DESIGNATES.
 *
 * Owner ruling of 2026-11-04, options 3 and 2 together: a « Currency » role on the headerless
 * designation screen, and an undesignated column whose every non-empty value is an ISO 4217 code
 * makes the door ASK rather than file the rows under the account's currency.
 *
 * Measured before the fix (by reading, the issue's reproduction): the USD file below, posted with
 * `hasHeaderRow=false` into a EUR account, imported two EUR rows and refused nothing.
 *
 * Through the REAL route action, against a real engine: the figure is stored rows, which a fake
 * would decide for itself.
 */

/** The issue's reproduction: column 4 reads USD on every row, and line 1 is a transaction. */
const HEADERLESS_USD = ['2026-06-01;CB A;-10.00;USD', '2026-06-02;CB B;-20.00;USD'].join('\n');
/** The same shape declaring EUR, so a designated column can be compared with a USD account. */
const HEADERLESS_EUR = ['2026-06-01;CB A;-10.00;EUR', '2026-06-02;CB B;-20.00;EUR'].join('\n');
/** The calibration: no column of codes at all, so there is nothing to ask. */
const HEADERLESS_NO_CODES = ['2026-06-01;CB A;-10.00;X1', '2026-06-02;CB B;-20.00;X2'].join('\n');

function fileOf(text: string): File {
	return new File([text], 'releve.csv', { type: 'text/csv' });
}

type ActionOutcome = { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;

async function postColumns(userId: string, fields: Record<string, string | File>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	const event = {
		locals: { user: { id: userId } },
		request: new Request('http://localhost/import/columns', { method: 'POST', body }),
		// One address per user: the import limiter counts per address too.
		getClientAddress: () => `client-${userId}`
	} as unknown as Parameters<NonNullable<typeof columnsActions.default>>[0];
	return (await columnsActions.default!(event)) as ActionOutcome;
}

/** The headerless designation every test posts, with the fields a test adds or overrides. */
function headerless(text: string, accountId: string, extra: Record<string, string> = {}) {
	return {
		csvFile: fileOf(text),
		hasHeaderRow: 'false',
		dateIndex: '0',
		labelIndex: '1',
		amountIndex: '2',
		remember: 'false',
		accountId,
		...extra
	};
}

async function seedUser(tag: string) {
	const user = await prisma.user.create({
		data: { email: `hl-ccy-${tag}-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	// The account bank sync creates, as in `declaredCurrency.db-smoke.ts`.
	const usd = await resolveImportBucketAccount({
		userId: user.id,
		name: 'Checking USD',
		source: 'enablebanking',
		denomination: { currency: 'USD', exponent: 2 },
		providerAccountId: `uid-${tag}-usd`,
		providerCashAccountType: 'CACC'
	});
	const eur = await createStatementAccount({ userId: user.id, name: 'Compte courant' });
	return { userId: user.id, usdId: usd.accountId, eurId: eur.id };
}

async function storedCurrencies(userId: string) {
	const rows = await prisma.transaction.findMany({
		where: { userId },
		select: { currency: true },
		orderBy: { label: 'asc' }
	});
	return rows.map((row) => row.currency);
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'b2'.repeat(32);
});

describe('#1213: a headerless file declares its currency through a designated column', () => {
	/** Separates « asked » from « filed as EUR in silence », the issue's measured case (2 EUR rows). */
	it('an undesignated column of currency codes is asked, and nothing is written', async () => {
		expect.assertions(3);
		const { userId, eurId } = await seedUser('ask');
		const asked = await postColumns(userId, headerless(HEADERLESS_USD, eurId));
		expect(await storedCurrencies(userId)).toEqual([]);
		expect(asked.status).toBe(400);
		expect(asked.data?.keepDesignation).toBe(true);
	});

	/** The ask is the member's sentence, naming the column by its position, compared whole. */
	it('the ask names the column in plain words', async () => {
		expect.assertions(1);
		const { userId, eurId } = await seedUser('ask-sentence');
		const asked = await postColumns(userId, headerless(HEADERLESS_USD, eurId));
		expect(asked.data?.error).toBe(m.import_columns_error_currency_unanswered({ count: 4 }));
	});

	/**
	 * The designated column IS the file's declaration: EUR into the USD account is refused with
	 * #600's sentence. Separates « the role reaches the comparison » from « the role is read and
	 * dropped », which would import two USD rows.
	 */
	it('a designated column declaring EUR is refused into the USD account', async () => {
		expect.assertions(3);
		const { userId, usdId } = await seedUser('designated-refused');
		const refused = await postColumns(
			userId,
			headerless(HEADERLESS_EUR, usdId, { currencyIndex: '3' })
		);
		expect(await storedCurrencies(userId)).toEqual([]);
		expect(refused.status).toBe(400);
		expect(refused.data?.error).toBe(
			refusalLabel({ code: 'declared-currency-mismatch', declared: 'EUR', destination: 'USD' })
		);
	});

	/** The calibration of the one above: the same designation into EUR imports, stored EUR. */
	it('a designated column declaring EUR imports into the EUR account', async () => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser('designated-ok');
		const accepted = await postColumns(
			userId,
			headerless(HEADERLESS_EUR, eurId, { currencyIndex: '3' })
		);
		expect(accepted.status).toBeUndefined();
		expect(await storedCurrencies(userId)).toEqual(['EUR', 'EUR']);
	});

	/** A designated USD column is never stored as EUR: every row is refused, nothing written. */
	it('a designated column declaring USD writes nothing into the EUR account', async () => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser('designated-usd');
		const refused = await postColumns(
			userId,
			headerless(HEADERLESS_USD, eurId, { currencyIndex: '3' })
		);
		expect(await storedCurrencies(userId)).toEqual([]);
		expect(refused.status).toBe(400);
	});

	/** The member's answer « not a currency » is honoured: the account's currency applies. */
	it('a column declined as « not a currency » imports under the account', async () => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser('declined');
		const accepted = await postColumns(
			userId,
			headerless(HEADERLESS_USD, eurId, { currencyIndex: 'none' })
		);
		expect(accepted.status).toBeUndefined();
		expect(await storedCurrencies(userId)).toEqual(['EUR', 'EUR']);
	});

	/** Calibration: a headerless file with no column of codes has nothing to ask and imports. */
	it('calibration: no column of codes imports as before', async () => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser('calibrate');
		const accepted = await postColumns(userId, headerless(HEADERLESS_NO_CODES, eurId));
		expect(accepted.status).toBeUndefined();
		expect(await storedCurrencies(userId)).toEqual(['EUR', 'EUR']);
	});

	/**
	 * ASVS v5.0.0-2.2.1: the posted index is validated positively, never coerced. The REASON is
	 * asserted, because the ask answers 400 too (note pass P6): posted on the code-free file, a door
	 * that skipped this validation would import, and on the USD file it would ask.
	 */
	it.each([
		['3abc', 'not an integer'],
		['9', 'out of range'],
		['2', 'the amount column'],
		['-1', 'negative']
	])('currencyIndex %j (%s) is refused as an invalid designation', async (value) => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser(`hostile-${value}`);
		const refused = await postColumns(
			userId,
			headerless(HEADERLESS_NO_CODES, eurId, { currencyIndex: value })
		);
		expect(await storedCurrencies(userId)).toEqual([]);
		expect(refused.data?.error).toBe(m.import_columns_error_invalid_designation());
	});

	/** An empty field is no answer: the column is asked, not declined. */
	it('an empty currencyIndex is no answer, so the column is asked', async () => {
		expect.assertions(1);
		const { userId, eurId } = await seedUser('empty');
		const asked = await postColumns(
			userId,
			headerless(HEADERLESS_USD, eurId, { currencyIndex: '' })
		);
		expect(asked.data?.error).toBe(m.import_columns_error_currency_unanswered({ count: 4 }));
	});

	/**
	 * Decided in the PR (note pass P7, reversible): only the Currency role answers. A column of codes
	 * the member gave to Category is still asked, because a category named USD says nothing about
	 * the amounts' unit.
	 */
	it('a column of codes designated as Category is still asked', async () => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser('as-category');
		const asked = await postColumns(
			userId,
			headerless(HEADERLESS_USD, eurId, { categoryIndex: '3' })
		);
		expect(await storedCurrencies(userId)).toEqual([]);
		expect(asked.data?.error).toBe(m.import_columns_error_currency_unanswered({ count: 4 }));
	});

	/**
	 * Note pass P4a: `currencyOfCell` upper-cases, so a column of ordinary lowercase words that
	 * happen to spell codes (`all`, `top`, `try`) would be asked for no reason. A code is written in
	 * capitals; this column is not one, and imports.
	 */
	it('a column of lowercase words that spell codes is not asked', async () => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser('lowercase');
		const words = ['2026-06-01;CB A;-10.00;all', '2026-06-02;CB B;-20.00;top'].join('\n');
		const accepted = await postColumns(userId, headerless(words, eurId));
		expect(accepted.status).toBeUndefined();
		expect(await storedCurrencies(userId)).toEqual(['EUR', 'EUR']);
	});

	/**
	 * Code pass A, finding 2: a cell holding only a zero-width space is BLANK, as `currencyOfCell`
	 * reads it. Counted as filled, it hid the column from the detector and the rows were stored EUR.
	 * Built with `fromCharCode` so the source carries no invisible character.
	 */
	it('a zero-width-space cell is blank, so the column is still asked', async () => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser('zero-width');
		const zeroWidth = String.fromCharCode(0x200b);
		const text = ['2026-06-01;CB A;-10.00;USD', `2026-06-02;CB B;-20.00;${zeroWidth}`].join('\n');
		const asked = await postColumns(userId, headerless(text, eurId));
		expect(await storedCurrencies(userId)).toEqual([]);
		expect(asked.data?.error).toBe(m.import_columns_error_currency_unanswered({ count: 4 }));
	});

	/** A header row is still read by its names: `currencyIndex` is not read there at all. */
	it('a file with a header row ignores currencyIndex', async () => {
		expect.assertions(2);
		const { userId, eurId } = await seedUser('header');
		const withHeader = ['d;l;a;x', '2026-06-01;CB A;-10.00;X1'].join('\n');
		const accepted = await postColumns(userId, {
			...headerless(withHeader, eurId, { currencyIndex: 'not-read' }),
			hasHeaderRow: 'true'
		});
		expect(accepted.status).toBeUndefined();
		expect(await storedCurrencies(userId)).toEqual(['EUR']);
	});
});
