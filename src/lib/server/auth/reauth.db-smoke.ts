import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	createSession,
	hashPassword,
	hashSessionToken,
	readSessionUser,
	SESSION_COOKIE,
	verifyPassword
} from '$lib/server/auth';
import {
	decryptTotpSecret,
	encryptTotpSecret,
	generateRecoveryCodes,
	generateTotpSecretBase32,
	hashRecoveryCode
} from './totp';
import * as m from '$lib/paraglide/messages';
import { REAUTH_FIELDS } from '$lib/domain/reauthFields';
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

/**
 * #904, owner ruling 2026-10-08: when the stored second-factor secret cannot be decrypted (a rotated
 * `TOTP_ENCRYPTION_KEY`), `disableTotp` accepts the PASSWORD plus a RECOVERY CODE, which it spends,
 * and only in that state. Every other action that asks for a code stays refused until the factor is
 * set up again, and a readable secret never accepts a recovery code at re-authentication (#886).
 *
 * Every step is the REAL `/settings` action, with `locals.user` resolved by `readSessionUser` from a
 * session minted through the real write path, and every state is read back from the row.
 *
 * The unreadable row is what a rotated key leaves: AES-256-GCM in the production storage format,
 * under a 32-byte key that is not the one `beforeAll` sets. Decryption is never mocked. The recovery
 * codes are real rows, hashed by `hashRecoveryCode`, from `generateRecoveryCodes`, which is what
 * `confirmTotpSetup` writes.
 *
 * The attempt figures count REAUTH rows in `LoginAttempt` written since a fixed instant taken
 * before the action. This suite runs one file at a time (`fileParallelism: false`) and its tests in
 * order, so the rows written in that interval are the action's. The figure is calibrated by the
 * six-digit test: before #904 that code is answered `wrong-totp`, which records one.
 */
describe('an unreadable second factor: disabled with a recovery code, nothing else lowered (#904)', () => {
	const ANOTHER_KEY = Buffer.from('e5'.repeat(32), 'hex');
	const NEW_PASSWORD = 'reauth-smoke-new-password-904';
	const RECOVERY_CODE_COUNT = 3;

	/** `iv:authTag:ciphertext` in base64url, as `encryptSecret` writes it, under `ANOTHER_KEY`. */
	function encryptedUnderAnotherKey(plaintext: string): string {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', ANOTHER_KEY, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		return [iv, cipher.getAuthTag(), ciphertext]
			.map((part) => part.toString('base64url'))
			.join(':');
	}

	function decryptedUnderAnotherKey(stored: string): string {
		const [iv, authTag, ciphertext] = stored
			.split(':')
			.map((part) => Buffer.from(part, 'base64url'));
		const decipher = createDecipheriv('aes-256-gcm', ANOTHER_KEY, iv);
		decipher.setAuthTag(authTag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	}

	/**
	 * An account with two-factor on, its secret stored readable (the app's key) or unreadable
	 * (another key), and `RECOVERY_CODE_COUNT` unused recovery codes as real rows.
	 */
	async function seedFactor(tag: string, storage: 'readable' | 'unreadable') {
		const secret = generateTotpSecretBase32();
		const stored =
			storage === 'readable' ? encryptTotpSecret(secret) : encryptedUnderAnotherKey(secret);
		const user = await seedAccount(`904-${tag}`, PASSWORD_A, stored);
		const recoveryCodes: { code: string; id: string }[] = [];
		for (const code of generateRecoveryCodes(RECOVERY_CODE_COUNT)) {
			const row = await prisma.recoveryCode.create({
				data: { userId: user.id, codeHash: await hashRecoveryCode(code) },
				select: { id: true }
			});
			recoveryCodes.push({ code, id: row.id });
		}
		return { user, secret, recoveryCodes };
	}

	/** The current step's code for `secret`, generated by the library, never by the code under test. */
	function currentCode(secret: string): string {
		return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
	}

	/**
	 * Posts `fields` to the real `/settings` action as the browser holding `token`. Returns the
	 * action's answer and the token the browser holds afterwards: a success rotates it (#249).
	 */
	async function post(action: string, token: string, fields: Record<string, string>) {
		const { actions } = await import('../../../routes/settings/+page.server');
		const run = actions[action] as unknown as (event: unknown) => Promise<unknown>;
		const formData = new FormData();
		for (const [key, value] of Object.entries(fields)) formData.set(key, value);
		let held = token;
		const cookies = {
			get: (name: string) => (name === SESSION_COOKIE ? held : undefined),
			set: (name: string, value: string) => {
				if (name === SESSION_COOKIE) held = value;
			},
			delete: () => {}
		} as unknown as Cookies;
		const result = (await run({
			cookies,
			getClientAddress: () => freshAddress(),
			request: new Request('http://localhost/settings', { method: 'POST', body: formData }),
			locals: { user: await readSessionUser(token) },
			url: new URL('http://localhost/settings')
		})) as { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;
		return { result, token: held };
	}

	async function factor(userId: string) {
		return prisma.user.findUniqueOrThrow({
			where: { id: userId },
			select: { totpEnabled: true, totpSecretEncrypted: true }
		});
	}

	async function usedAt(recoveryCodeId: string): Promise<Date | null> {
		const row = await prisma.recoveryCode.findUniqueOrThrow({
			where: { id: recoveryCodeId },
			select: { usedAt: true }
		});
		return row.usedAt;
	}

	async function recoveryCodeCount(userId: string): Promise<number> {
		return prisma.recoveryCode.count({ where: { userId } });
	}

	async function passwordHash(userId: string): Promise<string> {
		const row = await prisma.user.findUniqueOrThrow({
			where: { id: userId },
			select: { passwordHash: true }
		});
		return row.passwordHash;
	}

	/**
	 * Counts the re-authentication attempts an action records. The instant is fixed BEFORE the action
	 * and a minute back, so engine clock skew cannot drop the action's row, and no row inside it is
	 * old enough for `recordAttempt`'s cleanup to delete during the action.
	 */
	async function attemptCounter() {
		const since = new Date(Date.now() - 60_000);
		const count = () =>
			prisma.loginAttempt.count({ where: { kind: 'REAUTH', createdAt: { gte: since } } });
		const before = await count();
		return async () => (await count()) - before;
	}

	// The instrument's calibration. Separates « a ciphertext the app's key cannot authenticate » (the
	// rotated-key case #904 is about) from « a malformed string », which `decryptSecret` refuses with
	// its own format error before any key is used.
	it('the fixture is a real ciphertext of the secret that only the app key cannot read', () => {
		expect.assertions(1);
		const secret = generateTotpSecretBase32();
		const stored = encryptedUnderAnotherKey(secret);

		let appKeyAnswer: string;
		try {
			appKeyAnswer = `decrypted: ${decryptTotpSecret(stored)}`;
		} catch (caught) {
			appKeyAnswer = `threw: ${(caught as Error).message}`;
		}

		expect({ ownKey: decryptedUnderAnotherKey(stored), appKey: appKeyAnswer }).toEqual({
			ownKey: secret,
			appKey: 'threw: Unsupported state or unable to authenticate data'
		});
	});

	// THE JOURNEY the ruling exists for. Separates « an unreadable factor can be turned off by its
	// owner, and set up again » from main before #904, where the recovery code is refused at the
	// shape check (`missing-totp`) and the owner can neither disable nor re-enrol: a dead end.
	it('the owner disables it with the password and a recovery code, then sets two-factor up again', async () => {
		expect.assertions(4);
		const { user, recoveryCodes } = await seedFactor('journey', 'unreadable');
		const session = await mintSession(user.id);
		expect(await recoveryCodeCount(user.id)).toBe(RECOVERY_CODE_COUNT);
		expect((await factor(user.id)).totpEnabled).toBe(true);

		const disabled = await post('disableTotp', session.token, {
			[REAUTH_FIELDS.password]: PASSWORD_A,
			[REAUTH_FIELDS.code]: recoveryCodes[0].code
		});

		expect({
			answer: disabled.result,
			factor: await factor(user.id),
			recoveryCodes: await recoveryCodeCount(user.id)
		}).toEqual({
			answer: { totpDisableSuccess: m.settings_mfa_success_disabled() },
			factor: { totpEnabled: false, totpSecretEncrypted: null },
			recoveryCodes: 0
		});

		const fresh = generateTotpSecretBase32();
		const enrolled = await post('confirmTotpSetup', disabled.token, {
			[REAUTH_FIELDS.password]: PASSWORD_A,
			[REAUTH_FIELDS.code]: currentCode(fresh),
			secretBase32: fresh
		});
		const after = await factor(user.id);

		// The secret read back through the app's key is the fresh one: the unreadable ciphertext is
		// gone, not left beside a flag turned back on.
		expect({
			answer: enrolled.result,
			totpEnabled: after.totpEnabled,
			secret:
				after.totpSecretEncrypted === null ? null : decryptTotpSecret(after.totpSecretEncrypted)
		}).toEqual({
			answer: expect.objectContaining({ totpEnableSuccess: true }),
			totpEnabled: true,
			secret: fresh
		});
	});

	// The journey's calibration. Separates « the recovery code is CHECKED against the rows » from « a
	// string shaped like one is enough »: an implementation accepting any XXXXX-XXXXX passes the
	// journey and fails here. The sentence is class 2's one sentence for a form that asked for a
	// code (#854); the attempt is the contract's « recorded ».
	it('a well-formed recovery code the account does not hold is refused and counted', async () => {
		expect.assertions(2);
		const { user, recoveryCodes } = await seedFactor('wrong-recovery-code', 'unreadable');
		const session = await mintSession(user.id);
		const held = new Set(recoveryCodes.map((entry) => entry.code));
		const [notHeld] = generateRecoveryCodes(1);
		expect(held.has(notHeld)).toBe(false);
		const attempts = await attemptCounter();

		const answer = await post('disableTotp', session.token, {
			[REAUTH_FIELDS.password]: PASSWORD_A,
			[REAUTH_FIELDS.code]: notHeld
		});

		expect({
			error: answer.result.data?.totpDisableError,
			totpEnabled: (await factor(user.id)).totpEnabled,
			attempts: await attempts(),
			unusedCodes: await prisma.recoveryCode.count({ where: { userId: user.id, usedAt: null } })
		}).toEqual({
			error: m.reauth_error_password_or_code(),
			totpEnabled: true,
			attempts: 1,
			unusedCodes: RECOVERY_CODE_COUNT
		});
	});

	// Separates « the recovery code is accepted only while the secret is unreadable » from « disable
	// accepts a recovery code »: the second would let a recovery code stand in for the authenticator
	// on every account (#886 stays separate). Already true on main, and it must stay true: refused at
	// the shape check (`missing-totp`), which records no attempt and reads no recovery code.
	it('a READABLE secret refuses the recovery code at disableTotp, and spends nothing', async () => {
		expect.assertions(3);
		const { user, recoveryCodes } = await seedFactor('readable', 'readable');
		const session = await mintSession(user.id);
		const [offered] = recoveryCodes;
		expect(await usedAt(offered.id)).toBeNull();
		expect((await factor(user.id)).totpEnabled).toBe(true);
		const attempts = await attemptCounter();

		const answer = await post('disableTotp', session.token, {
			[REAUTH_FIELDS.password]: PASSWORD_A,
			[REAUTH_FIELDS.code]: offered.code
		});

		expect({
			error: answer.result.data?.totpDisableError,
			totpEnabled: (await factor(user.id)).totpEnabled,
			usedAt: await usedAt(offered.id),
			attempts: await attempts()
		}).toEqual({
			error: m.reauth_error_password_or_code(),
			totpEnabled: true,
			usedAt: null,
			attempts: 0
		});
	});

	// Separates « an unreadable secret has its own sentence » from main, where a six-digit code
	// against it reads `wrong-totp` and the owner is told to retype a code that can never be right.
	// The code posted is the RIGHT one for the plaintext secret: unreadable means no code passes.
	it('disableTotp with a six-digit code is refused as unreadable, and the factor stays on', async () => {
		expect.assertions(2);
		const { user, secret } = await seedFactor('six-digit', 'unreadable');
		const session = await mintSession(user.id);
		expect((await factor(user.id)).totpEnabled).toBe(true);
		const attempts = await attemptCounter();

		const answer = await post('disableTotp', session.token, {
			[REAUTH_FIELDS.password]: PASSWORD_A,
			[REAUTH_FIELDS.code]: currentCode(secret)
		});

		expect({
			error: answer.result.data?.totpDisableError,
			totpEnabled: (await factor(user.id)).totpEnabled,
			attempts: await attempts()
		}).toEqual({
			error: m.reauth_error_totp_unreadable(),
			totpEnabled: true,
			attempts: 1
		});
	});

	// Separates « the unreadable sentence does not depend on the password » from « it is shown only
	// beside a right password »: the second makes the sentence an oracle for the password to
	// whoever holds a stolen session (the same reasoning as `reused-totp` in `reauth.ts`).
	it('disableTotp with a WRONG password and a six-digit code reads the same unreadable sentence', async () => {
		expect.assertions(2);
		const { user, secret } = await seedFactor('six-digit-wrong-password', 'unreadable');
		const session = await mintSession(user.id);
		expect((await factor(user.id)).totpEnabled).toBe(true);
		const attempts = await attemptCounter();

		const answer = await post('disableTotp', session.token, {
			[REAUTH_FIELDS.password]: 'not-the-password',
			[REAUTH_FIELDS.code]: currentCode(secret)
		});

		expect({
			error: answer.result.data?.totpDisableError,
			totpEnabled: (await factor(user.id)).totpEnabled,
			attempts: await attempts()
		}).toEqual({
			error: m.reauth_error_totp_unreadable(),
			totpEnabled: true,
			attempts: 1
		});
	});

	// Separates « unreadable never lowers a 7.5.1 action to the password alone » from an
	// implementation that skips the code when it cannot read the secret: the hash would change.
	it('changePassword with a six-digit code is refused as unreadable, and the hash is unchanged', async () => {
		expect.assertions(2);
		const { user, secret } = await seedFactor('change-password-six-digit', 'unreadable');
		const before = await passwordHash(user.id);
		expect(await verifyPassword(PASSWORD_A, before)).toBe(true);
		const session = await mintSession(user.id);

		const answer = await post('changePassword', session.token, {
			[REAUTH_FIELDS.password]: PASSWORD_A,
			[REAUTH_FIELDS.code]: currentCode(secret),
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD
		});

		expect({
			error: answer.result.data?.passwordError,
			passwordHash: await passwordHash(user.id)
		}).toEqual({
			error: m.reauth_error_totp_unreadable(),
			passwordHash: before
		});
	});

	// Separates « a recovery code stands in for the code only at disableTotp » from « anywhere the
	// secret is unreadable »: changing the password is a 7.5.1 action and the ruling keeps it
	// refused until the factor is set up again. The hash is the figure that carries the property.
	// The sentence is not pinned by the contract for this input: a shape refusal (`missing-totp`)
	// and an unreadable refusal are both acceptable, and nothing else is. The hash is asserted
	// FIRST so it is observed even while the second sentence's key does not exist yet.
	it('changePassword with a recovery code is refused, and the hash is unchanged', async () => {
		expect.assertions(3);
		const { user, recoveryCodes } = await seedFactor('change-password-recovery', 'unreadable');
		const before = await passwordHash(user.id);
		expect(await verifyPassword(PASSWORD_A, before)).toBe(true);
		const session = await mintSession(user.id);

		const answer = await post('changePassword', session.token, {
			[REAUTH_FIELDS.password]: PASSWORD_A,
			[REAUTH_FIELDS.code]: recoveryCodes[0].code,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD
		});

		expect(await passwordHash(user.id)).toBe(before);
		expect(answer.result.data?.passwordError).toBeOneOf([
			m.reauth_error_password_or_code(),
			m.reauth_error_totp_unreadable()
		]);
	});

	// Separates « a recovery code seen is a recovery code spent » (the #818 safe direction, applied
	// to the new door) from « spent only beside a right password »: the second makes the code's
	// fate an oracle for the password, and leaves a code that has been typed usable again.
	it('disableTotp with a WRONG password and a valid recovery code is refused, and the code is spent', async () => {
		expect.assertions(3);
		const { user, recoveryCodes } = await seedFactor('wrong-password-recovery', 'unreadable');
		const session = await mintSession(user.id);
		const [offered] = recoveryCodes;
		expect(await usedAt(offered.id)).toBeNull();
		expect((await factor(user.id)).totpEnabled).toBe(true);
		const attempts = await attemptCounter();

		const answer = await post('disableTotp', session.token, {
			[REAUTH_FIELDS.password]: 'not-the-password',
			[REAUTH_FIELDS.code]: offered.code
		});

		expect({
			error: answer.result.data?.totpDisableError,
			totpEnabled: (await factor(user.id)).totpEnabled,
			usedAt: await usedAt(offered.id),
			attempts: await attempts()
		}).toEqual({
			error: m.reauth_error_password_or_code(),
			totpEnabled: true,
			usedAt: expect.any(Date),
			attempts: 1
		});
	});
});
