import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as OTPAuth from 'otpauth';
import { isRedirect, type Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	createSession,
	hashPassword,
	liveSessionWhere,
	readSessionUser,
	SESSION_COOKIE
} from '$lib/server/auth';
import { MFA_PENDING_COOKIE } from '$lib/server/auth/mfaChallenge';
import { encryptTotpSecret, generateTotpSecretBase32 } from '$lib/server/auth/totp';
import { REAUTH_FIELDS } from '$lib/domain/reauthFields';
import { prisma } from '$lib/server/db';

/**
 * #923, against a real engine: a sign-in that has passed its password step and waits at the code
 * step is ended by everything that ends the account's other sessions. `ASVS v5.0.0-7.4.3`, « the
 * option to terminate all other active sessions after a successful change or removal of any
 * authentication factor (including password change via reset or recovery ...) »: a sign-in waiting
 * at the code step is not a session in the standard's words, and no ASVS 5.0.0 row names it, so this
 * is the same promise kept for the sign-in that has not finished yet.
 *
 * THE FIGURE is the issue's: whether a valid code submitted AFTER the change signs in. Measured on
 * main before the change, it did, for every action below: the challenge outlived the password it was
 * opened under. The calibration is the first test: with no change in between the same code signs in,
 * so a refusal below is the change and not a route that refuses everything.
 *
 * Every step is the REAL route action: `/login` opens the challenge from the password, the action
 * under test ends the sign-ins, `/login/verify-totp` takes the code. Nothing here writes a challenge
 * or deletes one itself, so a test cannot pass by doing the route's work.
 *
 * THE CLOCK IS PINNED to the middle of a time step, in `beforeEach`, so the code of each step is
 * known: a re-authentication spends the step before the sign-in's (steps are spent in order).
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

/**
 * The forced interleaving's gate. `/login/verify-totp` seeds the default categories after the code is
 * accepted and before the session is written; a hook set here runs at that point, which is where a
 * change made in another tab lands between the challenge being read and the sign-in completing.
 */
let betweenCodeAndSession: (() => Promise<void>) | null = null;
vi.mock('$lib/server/categories/defaults', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/categories/defaults')>();
	return {
		...actual,
		ensureDefaultCategoriesSeeded: async (userId: string) => {
			const hook = betweenCodeAndSession;
			betweenCodeAndSession = null;
			if (hook) await hook();
			return actual.ensureDefaultCategoriesSeeded(userId);
		}
	};
});

/**
 * The second gate. `/login` verifies the password (a bcrypt comparison, hundreds of milliseconds)
 * and only then writes the challenge, or the session when two-factor is off; a hook set here runs
 * after the comparison answered, which is where a change committing during the comparison lands.
 */
let afterPasswordCheck: (() => Promise<void>) | null = null;
vi.mock('$lib/server/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/auth')>();
	return {
		...actual,
		verifyPasswordTimingSafe: async (password: string, passwordHash: string | undefined) => {
			const answer = await actual.verifyPasswordTimingSafe(password, passwordHash);
			const hook = afterPasswordCheck;
			afterPasswordCheck = null;
			if (hook) await hook();
			return answer;
		}
	};
});

/**
 * The third gate, INSIDE the code step's transaction: it runs once the challenge is claimed and
 * before the session is written. The hook starts a change and lets it run for a while without
 * waiting for it, so the change meets a sign-in that has claimed and not yet written.
 */
let afterClaim: (() => Promise<void>) | null = null;
vi.mock('$lib/server/auth/mfaChallenge', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/auth/mfaChallenge')>();
	return {
		...actual,
		claimMfaChallenge: async (...args: Parameters<typeof actual.claimMfaChallenge>) => {
			await actual.claimMfaChallenge(...args);
			const hook = afterClaim;
			afterClaim = null;
			if (hook) await hook();
		}
	};
});

/** How long the change runs while the sign-in holds its claim: several times a change's duration. */
const CHANGE_HEADSTART_MS = 1500;

const PASSWORD = 'pending-sign-in-smoke-password';
const NEW_PASSWORD = 'pending-sign-in-smoke-new-password';
const PERIOD_MS = 30_000;
const CONCURRENT_ACCOUNTS = 8;
const created: string[] = [];

let step = 0;

/** A documentation address unique to this run and call: the limiters' rows outlive the run. */
const RUN_ID = crypto.randomUUID();
const RUN = `${RUN_ID.slice(0, 4)}:${RUN_ID.slice(4, 8)}`;
let addressCounter = 0;
/**
 * One /56 per call: the limiter counts an IPv6 client by its prefix (`BP_RATE_LIMIT_IPV6_PREFIX`,
 * 56 by default), so addresses that differ only after the 56th bit are one client. The call number
 * sits in the second group, inside 3fff::/20, the documentation prefix of RFC 9637, which leaves it
 * twelve bits: 4095 calls.
 */
function freshAddress(): string {
	addressCounter += 1;
	if (addressCounter > 0xfff) throw new Error('freshAddress: more calls than 3fff::/20 holds');
	return `3fff:${addressCounter.toString(16)}:${RUN}::1`;
}

/** A code for `step + offset`, generated by the library directly, never by the code under test. */
function codeAt(secret: string, offset: number): string {
	return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate({
		timestamp: (step + offset) * PERIOD_MS
	});
}

interface Account {
	id: string;
	email: string;
	secret: string;
}

async function seedAccount(
	tag: string,
	options: { totp?: boolean; role?: 'ADMIN' | 'USER'; forcePasswordChange?: boolean } = {}
): Promise<Account> {
	const secret = generateTotpSecretBase32();
	// Lowercase: `/login` folds the address it is given, so a capital here is an account it never finds.
	const email = `pending-sign-in-${tag.toLowerCase()}-${crypto.randomUUID()}@budgetpilot.invalid`;
	const user = await prisma.user.create({
		data: {
			email,
			passwordHash: await hashPassword(PASSWORD),
			role: options.role ?? 'USER',
			forcePasswordChange: options.forcePasswordChange ?? false,
			...(options.totp === false
				? {}
				: { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(secret) })
		},
		select: { id: true }
	});
	created.push(user.id);
	return { id: user.id, email, secret };
}

/** One browser's cookies: what it presents, and what the responses write or delete. */
function jar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const cookies = {
		get: (name: string) => values.get(name),
		set: (name: string, value: string) => {
			values.set(name, value);
		},
		delete: (name: string) => {
			values.delete(name);
		}
	} as unknown as Cookies;
	return { cookies, value: (name: string) => values.get(name) };
}

type Browser = ReturnType<typeof jar>;

function formOf(fields: Record<string, string>): FormData {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return form;
}

/** Runs a route action as `browser`; a thrown redirect is the answer, returned as its location. */
async function run(
	actions: Record<string, unknown>,
	action: string,
	path: string,
	browser: Browser,
	form: FormData,
	locals: Record<string, unknown> = {}
): Promise<{ redirect?: string; status?: number }> {
	const handler = actions[action] as (event: unknown) => Promise<unknown>;
	try {
		return (await handler({
			cookies: browser.cookies,
			getClientAddress: () => freshAddress(),
			request: new Request(`http://localhost${path}`, { method: 'POST', body: form }),
			locals,
			url: new URL(`http://localhost${path}`)
		})) as { status?: number };
	} catch (thrown) {
		if (!isRedirect(thrown)) throw thrown;
		return { redirect: thrown.location };
	}
}

/** Posts the account's password to the real `/login` action, from a new browser. */
async function submitPassword(account: Account) {
	const { actions } = await import('../../../routes/login/+page.server');
	const browser = jar();
	const answer = await run(
		actions,
		'default',
		'/login',
		browser,
		formOf({ email: account.email, password: PASSWORD })
	);
	return { browser, answer: answer as { redirect?: string; status?: number; data?: unknown } };
}

/** The password step, through the real `/login` action: a browser left at the code step. */
async function passwordStep(account: Account): Promise<Browser> {
	const { browser, answer } = await submitPassword(account);
	// The precondition every test below relies on: the password was accepted and a challenge opened.
	expect(answer, 'the password step was refused').toHaveProperty('redirect');
	expect(new URL(answer.redirect ?? '', 'http://localhost').pathname).toBe('/login/verify-totp');
	expect(browser.value(MFA_PENDING_COOKIE)).toBeDefined();
	return browser;
}

interface CodeAnswer {
	/** Where the action sent the browser. */
	location: string | undefined;
	/** Whether the browser now holds a session cookie that resolves to a live session. */
	signedIn: boolean;
}

/** The code step, through the real `/login/verify-totp` action. */
async function codeStep(browser: Browser, code: string): Promise<CodeAnswer> {
	const { actions } = await import('../../../routes/login/verify-totp/+page.server');
	const answer = await run(actions, 'default', '/login/verify-totp', browser, formOf({ code }));
	const token = browser.value(SESSION_COOKIE);
	return {
		location: answer.redirect,
		signedIn: token !== undefined && (await readSessionUser(token)) !== null
	};
}

/** A session through the real write path, returned as its token. */
async function mintSession(userId: string): Promise<string> {
	const minted = jar();
	await createSession(userId, minted.cookies);
	return minted.value(SESSION_COOKIE) ?? '';
}

/** The refusal this issue asks for: sent back to the password step, holding no session. */
const SENT_BACK = { location: '/login', signedIn: false } satisfies CodeAnswer;

/**
 * The races start each reset one reset-duration late, so the earliest offsets finish before it on
 * every engine and both orders occur: measured on MariaDB, a reset started with the code step
 * committed first in all 8 accounts, and that run said nothing about the other order.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Live sessions of these accounts, now. */
function liveSessionsOf(accounts: Account[]): Promise<number> {
	return prisma.session.count({
		where: {
			userId: { in: accounts.map((account) => account.id) },
			...liveSessionWhere(new Date())
		}
	});
}

/**
 * The actions that end an account's other sign-ins, each run from a session of its own and
 * asserted to have landed, so a refusal at the code step is the change and not a refused action.
 */
type Ending = 'changePassword' | 'revokeOtherSessions' | 'forcePasswordChange' | 'resetPassword';

const ENDINGS: Record<
	Ending,
	{ seed: Parameters<typeof seedAccount>[1]; end: (target: Account) => Promise<void> }
> = {
	changePassword: {
		seed: {},
		end: async (target) => {
			const { actions } = await import('../../../routes/settings/+page.server');
			const token = await mintSession(target.id);
			const answer = await run(
				actions,
				'changePassword',
				'/settings',
				jar({ [SESSION_COOKIE]: token }),
				formOf({
					[REAUTH_FIELDS.password]: PASSWORD,
					[REAUTH_FIELDS.code]: codeAt(target.secret, -1),
					newPassword: NEW_PASSWORD,
					confirmPassword: NEW_PASSWORD
				}),
				{ user: await readSessionUser(token) }
			);
			expect(answer, 'changePassword landed').not.toHaveProperty('status');
		}
	},
	revokeOtherSessions: {
		seed: {},
		end: async (target) => {
			const { actions } = await import('../../../routes/settings/+page.server');
			const token = await mintSession(target.id);
			const answer = await run(
				actions,
				'revokeOtherSessions',
				'/settings',
				jar({ [SESSION_COOKIE]: token }),
				formOf({
					[REAUTH_FIELDS.password]: PASSWORD,
					[REAUTH_FIELDS.code]: codeAt(target.secret, -1)
				}),
				{ user: await readSessionUser(token) }
			);
			expect(answer, 'revokeOtherSessions landed').not.toHaveProperty('status');
		}
	},
	forcePasswordChange: {
		seed: { forcePasswordChange: true },
		end: async (target) => {
			const { actions } = await import('../../../routes/force-password-change/+page.server');
			const token = await mintSession(target.id);
			const answer = await run(
				actions,
				'default',
				'/force-password-change',
				jar({ [SESSION_COOKIE]: token }),
				formOf({ newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }),
				{ user: await readSessionUser(token) }
			);
			expect(answer, 'force-password-change landed').toEqual({ redirect: '/' });
		}
	},
	resetPassword: {
		seed: {},
		end: (target) => adminReset(target)
	}
};

/** A session of a new administrator, for one reset: each reset rotates the token it arrived with. */
async function adminSession(): Promise<string> {
	const admin = await seedAccount('admin', { totp: false, role: 'ADMIN' });
	return mintSession(admin.id);
}

/** An administrator resets `target`'s password through the real `/admin` action. */
async function adminReset(target: Account, adminToken?: string): Promise<void> {
	const { actions } = await import('../../../routes/admin/+page.server');
	const token = adminToken ?? (await adminSession());
	const answer = await run(
		actions,
		'resetPassword',
		'/admin',
		jar({ [SESSION_COOKIE]: token }),
		formOf({ [REAUTH_FIELDS.password]: PASSWORD, targetUserId: target.id }),
		{ user: await readSessionUser(token) }
	);
	expect(answer, 'resetPassword landed').toHaveProperty('temporaryPassword');
}

/** The owner turns two-factor ON from another session of `target`, through the real action (#949). */
async function enrolFromAnotherSession(target: Account): Promise<void> {
	const { actions } = await import('../../../routes/settings/+page.server');
	const token = await mintSession(target.id);
	const secret = generateTotpSecretBase32();
	const answer = await run(
		actions,
		'confirmTotpSetup',
		'/settings',
		jar({ [SESSION_COOKIE]: token }),
		formOf({
			[REAUTH_FIELDS.password]: PASSWORD,
			[REAUTH_FIELDS.code]: codeAt(secret, 0),
			secretBase32: secret
		}),
		{ user: await readSessionUser(token) }
	);
	expect(answer, 'confirmTotpSetup landed').not.toHaveProperty('status');
}

/**
 * The owner turns two-factor OFF from another session of `target`, through the real action (#949),
 * with the code of `step + offset`: steps are spent in order, so it must be later than any code the
 * account has already accepted.
 */
async function disableFromAnotherSession(target: Account, offset: number): Promise<void> {
	const { actions } = await import('../../../routes/settings/+page.server');
	const token = await mintSession(target.id);
	const answer = await run(
		actions,
		'disableTotp',
		'/settings',
		jar({ [SESSION_COOKIE]: token }),
		formOf({
			[REAUTH_FIELDS.password]: PASSWORD,
			[REAUTH_FIELDS.code]: codeAt(target.secret, offset)
		}),
		{ user: await readSessionUser(token) }
	);
	expect(answer, 'disableTotp landed').not.toHaveProperty('status');
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'c9'.repeat(32);
	env.TOTP_ENCRYPTION_KEY = 'd0'.repeat(32);
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	step = Math.floor(Date.now() / PERIOD_MS);
	vi.setSystemTime(step * PERIOD_MS + PERIOD_MS / 2);
	betweenCodeAndSession = null;
	afterPasswordCheck = null;
	afterClaim = null;
});

afterEach(() => {
	vi.useRealTimers();
	betweenCodeAndSession = null;
	afterPasswordCheck = null;
	afterClaim = null;
});

afterAll(async () => {
	// Sessions, challenges and recovery codes cascade from User.
	await prisma.user.deleteMany({ where: { id: { in: created } } });
});

describe('a sign-in waiting at the code step (#923)', () => {
	// The calibration: with nothing in between, the same two steps sign in, so SENT_BACK below is
	// the change and not a route that refuses every code.
	it('signs in with a valid code when nothing ended it', async () => {
		const target = await seedAccount('calibration');
		const pending = await passwordStep(target);

		expect(await codeStep(pending, codeAt(target.secret, 0))).toEqual({
			location: '/',
			signedIn: true
		});
	});

	// One test per action, so a red names the action. Separates « the challenge outlives the change »
	// (signed in, measured on main) from « the change ends it » (sent back to the password step).
	for (const [name, ending] of Object.entries(ENDINGS)) {
		it(`is ended by ${name}: a valid code afterwards is sent back to the password step`, async () => {
			const target = await seedAccount(name, ending.seed);
			const pending = await passwordStep(target);

			await ending.end(target);

			expect(await codeStep(pending, codeAt(target.secret, 0))).toEqual(SENT_BACK);
		});
	}

	// FORCED interleaving: the code is accepted, the reset commits, then the sign-in would write its
	// session. Separates « the challenge is claimed when the session is written » from « read at the
	// start and trusted afterwards ». The gate proves the claim is checked, not that the window is
	// reachable without one: the unforced test below measures that.
	it('is ended by a change landing between the accepted code and the session', async () => {
		const target = await seedAccount('interleaved');
		const pending = await passwordStep(target);
		betweenCodeAndSession = () => adminReset(target);

		const answer = await codeStep(pending, codeAt(target.secret, 0));

		expect(betweenCodeAndSession, 'the gate ran').toBeNull();
		expect(answer).toEqual(SENT_BACK);
	});

	// FORCED, #949: two-factor is turned off after the code was accepted and before the session is
	// written. The sequential order cannot separate anything here, since a code submitted after the
	// disable meets `totpEnabled: false` and is sent back before it is judged. Separates « turning
	// two-factor off ends the sign-ins waiting at their code step » from « it ends only sessions »,
	// where the claim still finds its challenge and a session is written after the factor is gone.
	// The disable spends step +1: the sign-in has spent step 0.
	it('is ended by turning two-factor off between the accepted code and the session', async () => {
		const target = await seedAccount('disabled-between');
		const pending = await passwordStep(target);
		betweenCodeAndSession = () => disableFromAnotherSession(target, 1);

		const answer = await codeStep(pending, codeAt(target.secret, 0));

		expect(betweenCodeAndSession, 'the gate ran').toBeNull();
		expect(answer).toEqual(SENT_BACK);
	});

	// FORCED, inside the code step's transaction: the change starts after the challenge is claimed
	// and before the session is written. Separates « the claim and the session commit together, and
	// the change ends challenges before it ends sessions » (the change waits for the sign-in, then
	// ends its session) from either half missing: a claim committed on its own (break B7), or the
	// sessions ended before the challenges (break B8, PostgreSQL), where the change finishes first
	// and the session written afterwards is live.
	it('is ended by a change starting after the challenge is claimed', async () => {
		const target = await seedAccount('after-claim', { forcePasswordChange: true });
		const pending = await passwordStep(target);
		let change: Promise<void> | undefined;
		afterClaim = async () => {
			change = ENDINGS.forcePasswordChange.end(target);
			await sleep(CHANGE_HEADSTART_MS);
		};

		const answer = await codeStep(pending, codeAt(target.secret, 0));
		await change;

		expect(afterClaim, 'the gate ran').toBeNull();
		// The order this test is about: the sign-in wrote its session, so the change had to end it.
		expect(answer.location, 'the sign-in completed').toBe('/');
		expect(await readSessionUser(pending.value(SESSION_COOKIE))).toBeNull();
	});

	// UNFORCED: the code and an administrator's reset race, with no gate. Each account's code step
	// starts at its own offset across the reset's own measured duration, so some land before it,
	// some during and some after. Whatever the order, no session minted by the code may be live
	// afterwards: either the reset came first and the code is refused, or the sign-in came first and
	// the reset ended it. The figure is that count; on main the late offsets are signed in.
	it('leaves no live session when the code races a reset, whatever the order', async () => {
		const warmUp = await seedAccount('race-warm-up');
		const started = performance.now();
		await adminReset(warmUp);
		const resetMs = performance.now() - started;

		const targets = await Promise.all(
			Array.from({ length: CONCURRENT_ACCOUNTS }, (_, index) => seedAccount(`race-${index}`))
		);
		const pendings = await Promise.all(targets.map((target) => passwordStep(target)));
		const tokens = await Promise.all(targets.map(() => adminSession()));
		const offset = (index: number) => (index * 3 * resetMs) / (CONCURRENT_ACCOUNTS - 1);

		const answers = await Promise.all(
			targets.map(async (target, index) => {
				const [answer] = await Promise.all([
					sleep(offset(index)).then(() =>
						codeStep(pendings[index] as Browser, codeAt(target.secret, 0))
					),
					sleep(resetMs).then(() => adminReset(target, tokens[index]))
				]);
				return answer;
			})
		);

		// Both orders must have happened for the figure to mean « whatever the order »: how many codes
		// were answered with a session (the reset then had to end it) is printed beside the figure.
		const live = await liveSessionsOf(targets);
		console.log(
			`[#923] code racing a reset (${Math.round(resetMs)} ms), ${CONCURRENT_ACCOUNTS} accounts: ` +
				`${answers.filter((answer) => answer.location === '/').length} signed in at the time, ${live} live`
		);
		expect(live).toBe(0);
	});

	// FORCED, one step earlier (the contradiction pass on the design): the reset commits while
	// `/login` is comparing the OLD password, so nothing is pending yet for the reset to end. Separates
	// « the password step writes whatever it verified » (a challenge opened under the old password,
	// signed in afterwards) from « it writes only if that password is still the account's » (the
	// sign-in's own refusal, the sentence a wrong password gets). Two-factor on, then off.
	it('refuses a password step whose password was reset while it was being checked', async () => {
		const { login_error_invalid_credentials } = await import('$lib/paraglide/messages');
		const target = await seedAccount('reset-during-check');
		afterPasswordCheck = () => adminReset(target);

		const { browser, answer } = await submitPassword(target);

		expect(afterPasswordCheck, 'the gate ran').toBeNull();
		expect(answer).toEqual({ status: 400, data: { error: login_error_invalid_credentials() } });
		expect(browser.value(MFA_PENDING_COOKIE)).toBeUndefined();
	});

	it('refuses a sign-in without two-factor whose password was reset while it was being checked', async () => {
		const { login_error_invalid_credentials } = await import('$lib/paraglide/messages');
		const target = await seedAccount('reset-during-check-no-totp', { totp: false });
		afterPasswordCheck = () => adminReset(target);

		const { browser, answer } = await submitPassword(target);

		expect(afterPasswordCheck, 'the gate ran').toBeNull();
		expect(answer).toEqual({ status: 400, data: { error: login_error_invalid_credentials() } });
		expect(browser.value(SESSION_COOKIE)).toBeUndefined();
	});

	// FORCED, #949 (the contradiction pass on the design): two-factor is turned on while `/login`
	// compares the password of an account that had none, so the step goes on to write a session
	// proven by the password alone, after the enrolment ended every other session. Separates « the
	// step writes only while the factors it read are still the account's » from « only while the
	// password is », which matches here because the password did not change.
	it('refuses a sign-in without two-factor when two-factor was turned on while it was being checked', async () => {
		const { login_error_invalid_credentials } = await import('$lib/paraglide/messages');
		const target = await seedAccount('enrolled-during-check', { totp: false });
		afterPasswordCheck = () => enrolFromAnotherSession(target);

		const { browser, answer } = await submitPassword(target);

		expect(afterPasswordCheck, 'the gate ran').toBeNull();
		expect(answer).toEqual({ status: 400, data: { error: login_error_invalid_credentials() } });
		expect(browser.value(SESSION_COOKIE)).toBeUndefined();
	});

	// UNFORCED, at the password step: each account's password is posted at its own offset across a
	// reset's measured duration, then its code if it got a challenge. Whatever the order, nothing the
	// old password proved may be live afterwards. On main the late offsets are signed in; with only
	// the challenges deleted, the posts that were comparing while the reset committed are.
	for (const totp of [true, false]) {
		it(`leaves no live session when the password step races a reset (two-factor ${totp ? 'on' : 'off'})`, async () => {
			const warmUp = await seedAccount('password-race-warm-up');
			const started = performance.now();
			await adminReset(warmUp);
			const resetMs = performance.now() - started;

			const targets = await Promise.all(
				Array.from({ length: CONCURRENT_ACCOUNTS }, (_, index) =>
					seedAccount(`password-race-${index}`, { totp })
				)
			);
			const tokens = await Promise.all(targets.map(() => adminSession()));
			const offset = (index: number) => (index * 3 * resetMs) / (CONCURRENT_ACCOUNTS - 1);

			const outcomes = await Promise.all(
				targets.map(async (target, index) => {
					const [signIn] = await Promise.all([
						sleep(offset(index)).then(async () => {
							const { browser } = await submitPassword(target);
							if (browser.value(MFA_PENDING_COOKIE) === undefined) return browser;
							await codeStep(browser, codeAt(target.secret, 0));
							return browser;
						}),
						sleep(resetMs).then(() => adminReset(target, tokens[index]))
					]);
					return signIn.value(SESSION_COOKIE) !== undefined;
				})
			);

			const live = await liveSessionsOf(targets);
			console.log(
				`[#923] password step racing a reset (${Math.round(resetMs)} ms, two-factor ${totp ? 'on' : 'off'}), ` +
					`${CONCURRENT_ACCOUNTS} accounts: ${outcomes.filter(Boolean).length} signed in at the time, ${live} live`
			);
			expect(live).toBe(0);
		});
	}
});
