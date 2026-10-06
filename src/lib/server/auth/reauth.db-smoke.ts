import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	createSession,
	hashPassword,
	hashSessionToken,
	readSessionUser,
	SESSION_COOKIE
} from '$lib/server/auth';
import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';

/**
 * S1 against a real engine: what a unit spec's fake decides for itself.
 *
 * 1. THE OWNERSHIP CLAUSE (R6 on #841, the revokeSession half of #830). AGENTS.md: an object
 *    reference a client posts resolves with `userId` in the SAME where clause, « asserted in
 *    db-smoke, never only in a unit spec, because a unit spec's fake decides what `findFirst`
 *    returns ». Here account B, re-authenticated with B's own correct password, posts account A's
 *    real session id through the real action. Calibrated by A revoking that same session itself.
 * 2. THE LIMITER, real rows in `LoginAttempt`, counted per SESSION (#879): another session's wrong
 *    passwords leave the owner's session free, and the session that guessed is refused.
 * 3. THE STORED SECRET, encrypted with the real key and read back from the row: the reasons the
 *    helper decides are the ones its unit spec decides over a fixture.
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

const PASSWORD_A = 'reauth-smoke-password-a';
const PASSWORD_B = 'reauth-smoke-password-b';
const created: string[] = [];

/** A unique documentation address per call, so no two tests share a limiter row. */
let addressCounter = 0;
function freshAddress(): string {
	addressCounter += 1;
	return `198.51.100.${addressCounter}`;
}

function captureCookies(): { cookies: Cookies; token: () => string } {
	let written = '';
	const cookies = {
		set: (name: string, value: string) => {
			if (name === SESSION_COOKIE) written = value;
		},
		get: () => undefined
	} as unknown as Cookies;
	return { cookies, token: () => written };
}

async function seedAccount(tag: string, password: string, totpSecretEncrypted?: string) {
	const user = await prisma.user.create({
		data: {
			email: `reauth-smoke-${tag}-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: await hashPassword(password),
			...(totpSecretEncrypted ? { totpEnabled: true, totpSecretEncrypted } : {})
		},
		select: { id: true, email: true }
	});
	created.push(user.id);
	return user;
}

/** A session through the real write path, returned as its token and its row id. */
async function mintSession(userId: string): Promise<{ token: string; id: string }> {
	const { cookies, token } = captureCookies();
	await createSession(userId, cookies);
	const row = await prisma.session.findUniqueOrThrow({
		where: { tokenHash: hashSessionToken(token()) },
		select: { id: true }
	});
	return { token: token(), id: row.id };
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'c3'.repeat(32);
	env.TOTP_ENCRYPTION_KEY = 'd4'.repeat(32);
});

afterAll(async () => {
	// Sessions and recovery codes cascade from User.
	await prisma.user.deleteMany({ where: { id: { in: created } } });
});

describe('revokeSession resolves the session with the caller IN the where clause', () => {
	async function revoke(callerToken: string, password: string, sessionId: string) {
		const { actions } = await import('../../../routes/settings/+page.server');
		const formData = new FormData();
		formData.set('sessionId', sessionId);
		formData.set('currentPassword', password);
		const action = actions.revokeSession as unknown as (event: unknown) => Promise<unknown>;
		return (await action({
			// `set` receives the rotated token (#249); these tests read the rows, not the cookie.
			cookies: {
				get: (name: string) => (name === SESSION_COOKIE ? callerToken : undefined),
				set: () => {}
			},
			getClientAddress: () => freshAddress(),
			request: new Request('http://localhost/settings', { method: 'POST', body: formData }),
			locals: { user: await readSessionUser(callerToken) }
		})) as { status?: number; data?: Record<string, string>; sessionsSuccess?: string };
	}

	it("another account's session id is not found, and the session still resolves", async () => {
		expect.assertions(4);
		const a = await seedAccount('owner', PASSWORD_A);
		const b = await seedAccount('other', PASSWORD_B);
		const aCurrent = await mintSession(a.id);
		const aSecond = await mintSession(a.id);
		const bCurrent = await mintSession(b.id);

		// B is correctly re-authenticated: the refusal can only come from the ownership clause.
		const result = await revoke(bCurrent.token, PASSWORD_B, aSecond.id);

		expect(result.status).toBe(404);
		expect(await readSessionUser(aSecond.token)).not.toBeNull();
		expect(await readSessionUser(aCurrent.token)).not.toBeNull();
		const row = await prisma.session.findUniqueOrThrow({
			where: { id: aSecond.id },
			select: { revokedAt: true }
		});
		expect(row.revokedAt).toBeNull();
	});

	// The calibration: the same request by the session's OWNER revokes it, so the 404 above is the
	// clause and not a malformed request, a wrong password or an action that never revokes.
	it('the same session id, posted by its owner, is revoked', async () => {
		expect.assertions(3);
		const a = await seedAccount('owner-cal', PASSWORD_A);
		const aCurrent = await mintSession(a.id);
		const aSecond = await mintSession(a.id);

		expect(await readSessionUser(aSecond.token)).not.toBeNull();
		const result = await revoke(aCurrent.token, PASSWORD_A, aSecond.id);

		expect(result.sessionsSuccess).toEqual(expect.any(String));
		expect(await readSessionUser(aSecond.token)).toBeNull();
	});
});

/**
 * #879: the counter belongs to the SESSION that guessed, so a stolen session cannot hold its owner's
 * controls shut. Both tests drive the real action with `locals.user` resolved from the cookie by
 * `readSessionUser`, the call `handleAuth` makes, so the session the limiter sees is the one the
 * hook resolved and not one a test chose.
 */
describe('the re-authentication counter belongs to the session that guessed', () => {
	async function revokeOthers(token: string, password: string, ip: string) {
		const { actions } = await import('../../../routes/settings/+page.server');
		const formData = new FormData();
		formData.set('currentPassword', password);
		const action = actions.revokeOtherSessions as unknown as (event: unknown) => Promise<unknown>;
		return (await action({
			// `set` receives the rotated token (#249); these tests read the rows, not the cookie.
			cookies: {
				get: (name: string) => (name === SESSION_COOKIE ? token : undefined),
				set: () => {}
			},
			getClientAddress: () => ip,
			request: new Request('http://localhost/settings', { method: 'POST', body: formData }),
			locals: { user: await readSessionUser(token) }
		})) as { status?: number; data?: Record<string, string>; sessionsSuccess?: string };
	}

	// Separates « keyed by the account » (the owner is refused, as measured on main) from « keyed by
	// the session ». ONE address for both sessions, so it also separates « the address is a
	// dimension » from « it is not »: a household behind one NAT address is the likeliest place a
	// session is stolen from.
	it("five wrong passwords from another session do not refuse the owner's session", async () => {
		expect.assertions(2);
		const a = await seedAccount('stolen', PASSWORD_A);
		const owner = await mintSession(a.id);
		const thief = await mintSession(a.id);
		const household = freshAddress();

		for (let attempt = 0; attempt < 5; attempt++) {
			await revokeOthers(thief.token, 'wrong', household);
		}
		const result = await revokeOthers(owner.token, PASSWORD_A, household);

		expect(result.sessionsSuccess).toEqual(expect.any(String));
		expect(await readSessionUser(thief.token)).toBeNull();
	});

	// The budget the change must keep: the session that guessed is refused, and moving to a new
	// address buys it no sixth guess.
	it('the session that guessed five times is refused, from any address', async () => {
		expect.assertions(1);
		const a = await seedAccount('guesser', PASSWORD_A);
		const thief = await mintSession(a.id);

		for (let attempt = 0; attempt < 5; attempt++) {
			await revokeOthers(thief.token, 'wrong', freshAddress());
		}
		const result = await revokeOthers(thief.token, PASSWORD_A, freshAddress());

		expect(result).toMatchObject({
			status: 400,
			data: { sessionsError: m.settings_error_reauth_too_many() }
		});
	});
});

describe('the helper against real rows', () => {
	async function helper() {
		return import('./reauth');
	}

	function form(fields: Record<string, string>): FormData {
		const data = new FormData();
		for (const [key, value] of Object.entries(fields)) data.set(key, value);
		return data;
	}

	it('a stored, encrypted second factor decides wrong-totp and wrong-password from the row', async () => {
		expect.assertions(4);
		const { reauthenticate } = await helper();
		const { encryptTotpSecret, generateTotpSecretBase32 } = await import('./totp');
		const secret = generateTotpSecretBase32();
		const a = await seedAccount('totp', PASSWORD_A, encryptTotpSecret(secret));
		const session = await mintSession(a.id);
		const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
		const right = totp.generate();
		// `right` is spent by the first call (#818), so the wrong-password case needs a code that is
		// still unspent: the next step's, inside the window.
		const next = totp.generate({ timestamp: Date.now() + 30_000 });
		const wrong = totp.generate({ timestamp: Date.now() + 10 * 30_000 });

		const decide = (fields: Record<string, string>) =>
			reauthenticate('deleteAccount', {
				user: { id: a.id, sessionId: session.id },
				ip: freshAddress(),
				form: form(fields)
			});

		expect(await decide({ currentPassword: PASSWORD_A, code: right })).toEqual({ ok: true });
		expect(await decide({ currentPassword: PASSWORD_A, code: wrong })).toMatchObject({
			reason: 'wrong-totp'
		});
		expect(await decide({ currentPassword: 'wrong', code: next })).toMatchObject({
			reason: 'wrong-password'
		});
		expect(await decide({ currentPassword: PASSWORD_A })).toMatchObject({ reason: 'missing-totp' });
	});
});
