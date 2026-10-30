import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { isActionFailure, isRedirect, type Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { hashPassword } from '$lib/server/auth';
import { MFA_PENDING_COOKIE } from '$lib/server/auth/mfaChallenge';
import { encryptTotpSecret, generateTotpSecretBase32 } from '$lib/server/auth/totp';
import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';

/**
 * The sign-in budget against a real engine: five failed guesses per 15 minutes, for the password
 * step and for the code step, whether the guesses arrive one after another or all at once.
 *
 * 1. A BURST. The limiter used to count the window's rows and write the attempt's own row only
 *    after the credential was judged, so every request of a concurrent burst read « under five »
 *    and reached the check (#714 names the race for imports). Each test sends BURST guesses at once
 *    through the real action and counts the answers that judged a credential: at most five may.
 * 2. THE ACCOUNT, at the code step. The code step was counted per challenge and per address, and
 *    every correct password opens a new challenge, so whoever knew the password could guess codes
 *    without bound by signing in again from another address. The budget is the account's.
 * 3. THE CALIBRATIONS, which held before the change and must hold after it: a sequential budget
 *    still refuses the sixth guess, a correct password inside the budget still signs in, and correct
 *    password steps cost nothing, so the owner signing in repeatedly is never refused.
 *
 * Every step is the REAL route action. Nothing here writes or counts a `LoginAttempt` row itself:
 * the figure is what the routes answered.
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

/** The budget the routes promise. Written here, not imported: a test that read it would follow it. */
const BUDGET = 5;
/** Three times the budget, so a race that lets the whole burst through cannot read as a near miss. */
const BURST = 15;

const PASSWORD = 'sign-in-budget-smoke-password';
const WRONG_PASSWORD = 'sign-in-budget-smoke-wrong-password';
const created: string[] = [];

const RUN_ID = crypto.randomUUID();
const RUN = `${RUN_ID.slice(0, 4)}:${RUN_ID.slice(4, 8)}`;
let addressCounter = 0;
/** One IPv6 /56 per call (the limiter's default prefix), inside 3fff::/20 (RFC 9637). */
function freshAddress(): string {
	addressCounter += 1;
	if (addressCounter > 0xfff) throw new Error('freshAddress: more calls than 3fff::/20 holds');
	return `3fff:${addressCounter.toString(16)}:${RUN}::1`;
}

interface Account {
	id: string;
	email: string;
	secret: string;
}

async function seedAccount(tag: string, totp: boolean): Promise<Account> {
	const secret = generateTotpSecretBase32();
	const email = `sign-in-budget-${tag}-${crypto.randomUUID()}@budgetpilot.invalid`;
	const user = await prisma.user.create({
		data: {
			email,
			passwordHash: await hashPassword(PASSWORD),
			...(totp ? { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(secret) } : {})
		},
		select: { id: true }
	});
	created.push(user.id);
	return { id: user.id, email, secret };
}

// db-smoke's `$env` is an empty stub, so the suite's fixture secrets are set here.
beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'e1'.repeat(32);
	env.TOTP_ENCRYPTION_KEY = 'f2'.repeat(32);
});

afterAll(async () => {
	await prisma.user.deleteMany({ where: { id: { in: created } } });
});

function jar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const cookies = {
		get: (name: string) => values.get(name),
		set: (name: string, value: string) => void values.set(name, value),
		delete: (name: string) => void values.delete(name)
	} as unknown as Cookies;
	return { cookies, value: (name: string) => values.get(name) };
}

type Browser = ReturnType<typeof jar>;

/** What a route answered: the error sentence of a refusal, or where it redirected. */
type Answer = { error: string } | { redirect: string };

async function run(
	path: '/login' | '/login/verify-totp',
	browser: Browser,
	fields: Record<string, string>,
	address: string
): Promise<Answer> {
	const { actions } =
		path === '/login'
			? await import('../../../routes/login/+page.server')
			: await import('../../../routes/login/verify-totp/+page.server');
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	const handler = actions.default as unknown as (event: unknown) => Promise<unknown>;
	try {
		const answer = await handler({
			cookies: browser.cookies,
			getClientAddress: () => address,
			request: new Request(`http://localhost${path}`, { method: 'POST', body: form }),
			setHeaders: () => undefined,
			locals: {},
			url: new URL(`http://localhost${path}`)
		});
		if (isActionFailure(answer)) return { error: (answer.data as { error: string }).error };
		throw new Error(`${path} answered neither a refusal nor a redirect`);
	} catch (thrown) {
		if (!isRedirect(thrown)) throw thrown;
		return { redirect: thrown.location };
	}
}

const password = (account: Account, value: string, address: string) =>
	run('/login', jar(), { email: account.email, password: value }, address);

/** The password step with the right password: a browser left at the code step. */
async function passwordStep(account: Account, address: string): Promise<Browser> {
	const browser = jar();
	const answer = await run('/login', browser, { email: account.email, password: PASSWORD }, address);
	expect(answer, 'the password step was refused').toHaveProperty('redirect');
	expect(browser.value(MFA_PENDING_COOKIE)).toBeDefined();
	return browser;
}

/** A six-digit code that is valid in no step the server accepts now (one step either side). */
function wrongCode(secret: string): string {
	const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
	const valid = new Set([-1, 0, 1].map((offset) => totp.generate({ timestamp: Date.now() + offset * 30_000 })));
	for (let candidate = 0; ; candidate += 1) {
		const code = candidate.toString().padStart(6, '0');
		if (!valid.has(code)) return code;
	}
}

/** How many answers judged a credential, rather than refusing for the budget. */
function judged(answers: Answer[], invalidSentence: string): number {
	return answers.filter((answer) => 'error' in answer && answer.error === invalidSentence).length;
}

describe('the password step', () => {
	it('lets at most five of a concurrent burst for one account reach the password check', async () => {
		const account = await seedAccount('burst-account', false);
		const answers = await Promise.all(
			Array.from({ length: BURST }, () => password(account, WRONG_PASSWORD, freshAddress()))
		);
		expect(judged(answers, m.login_error_invalid_credentials())).toBeLessThanOrEqual(BUDGET);
	});

	it('lets at most five of a concurrent burst from one address reach the password check', async () => {
		const address = freshAddress();
		const accounts = await Promise.all(
			Array.from({ length: BURST }, (_, index) => seedAccount(`burst-address-${index}`, false))
		);
		const answers = await Promise.all(
			accounts.map((account) => password(account, WRONG_PASSWORD, address))
		);
		expect(judged(answers, m.login_error_invalid_credentials())).toBeLessThanOrEqual(BUDGET);
	});

	it('refuses the sixth wrong password sent one after another (calibration)', async () => {
		const account = await seedAccount('sequential', false);
		const answers: Answer[] = [];
		for (let index = 0; index < BUDGET + 1; index += 1) {
			answers.push(await password(account, WRONG_PASSWORD, freshAddress()));
		}
		expect(answers.map((answer) => ('error' in answer ? answer.error : 'redirect'))).toEqual([
			...Array.from({ length: BUDGET }, () => m.login_error_invalid_credentials()),
			m.login_error_too_many_attempts()
		]);
	});

	it('signs in with the right password after four wrong ones (calibration)', async () => {
		const account = await seedAccount('inside-budget', false);
		for (let index = 0; index < BUDGET - 1; index += 1) {
			await password(account, WRONG_PASSWORD, freshAddress());
		}
		expect(await password(account, PASSWORD, freshAddress())).toHaveProperty('redirect');
	});

	it('never refuses the owner for signing in correctly, however often', async () => {
		const account = await seedAccount('owner-repeats', false);
		const address = freshAddress();
		for (let index = 0; index < BUDGET * 2; index += 1) {
			expect(await password(account, PASSWORD, address)).toHaveProperty('redirect');
		}
	});
});

describe('the code step', () => {
	it('lets at most five of a concurrent burst on one challenge reach the code check', async () => {
		const account = await seedAccount('code-burst', true);
		const browser = await passwordStep(account, freshAddress());
		const code = wrongCode(account.secret);
		const answers = await Promise.all(
			Array.from({ length: BURST }, () =>
				run('/login/verify-totp', browser, { code }, freshAddress())
			)
		);
		expect(judged(answers, m.mfa_verify_error_invalid_code())).toBeLessThanOrEqual(BUDGET);
	});

	it('counts wrong codes per account, so a new challenge from a new address does not reset them', async () => {
		const account = await seedAccount('code-account', true);
		const code = wrongCode(account.secret);
		for (let index = 0; index < BUDGET; index += 1) {
			const browser = await passwordStep(account, freshAddress());
			const answer = await run('/login/verify-totp', browser, { code }, freshAddress());
			expect(answer).toEqual({ error: m.mfa_verify_error_invalid_code() });
		}
		const browser = await passwordStep(account, freshAddress());
		expect(await run('/login/verify-totp', browser, { code }, freshAddress())).toEqual({
			error: m.mfa_verify_error_too_many_attempts()
		});
	});

	it('refuses the sixth wrong code on one challenge sent one after another (calibration)', async () => {
		const account = await seedAccount('code-sequential', true);
		const browser = await passwordStep(account, freshAddress());
		const code = wrongCode(account.secret);
		const answers: Answer[] = [];
		for (let index = 0; index < BUDGET + 1; index += 1) {
			answers.push(await run('/login/verify-totp', browser, { code }, freshAddress()));
		}
		expect(answers.at(-1)).toEqual({ error: m.mfa_verify_error_too_many_attempts() });
		expect(judged(answers, m.mfa_verify_error_invalid_code())).toBe(BUDGET);
	});
});
