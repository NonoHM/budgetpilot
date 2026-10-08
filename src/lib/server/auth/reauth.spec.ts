import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as OTPAuth from 'otpauth';
import * as m from '$lib/paraglide/messages';
import { REAUTH_FIELDS } from '$lib/domain/reauthFields';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??= 'd4'.repeat(32);
	// The log pseudonyms (L3, #250) derive their keys from it, and refuse anything but 64 hex.
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
});

/**
 * The re-authentication helper's DECISION, with the account row and the limiter injected.
 *
 * What is real here: bcrypt, the TOTP window, the AES decryption of the stored secret, and the order
 * in which the helper consults them. What is faked: the one `findUnique` that reads the account and
 * the two limiter calls, whose SQL is `rateLimit.spec.ts`'s and whose behaviour against a real
 * engine is `reauth.db-smoke.ts`'s.
 *
 * Every refusal test asserts the REASON, never only that `ok` is false: the reasons are what L3
 * logs, and a helper that answered `wrong-password` for a wrong code would pass every « was it
 * refused » assertion while writing a false record.
 */

const db = vi.hoisted(() => ({
	prisma: { user: { findUnique: vi.fn(), updateMany: vi.fn(), count: vi.fn() } }
}));
const rateLimit = vi.hoisted(() => ({
	isReauthRateLimited: vi.fn(async () => false),
	recordReauthAttempt: vi.fn(async () => {})
}));

vi.mock('$lib/server/db', () => db);
// The two limiter calls are faked; the rest of the module is real, because the log pseudonyms read
// the secret check and the IPv6 prefix from it (`logging/pseudonym.ts`).
vi.mock('$lib/server/auth/rateLimit', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/auth/rateLimit')>()),
	...rateLimit
}));
// Every line the helper writes, through the one writer, captured instead of printed.
const logWriter = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: logWriter.log
}));
// The REAL code check, wrapped so a test can see whether the helper consulted it. Step 4 of the
// helper's header (both factors, always) is a claim about work done, which no outcome shows.
vi.mock('$lib/server/auth/totp', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/auth/totp')>();
	return { ...real, verifyTotpCode: vi.fn(real.verifyTotpCode) };
});

const { hashPassword } = await import('$lib/server/auth');
const { encryptTotpSecret, generateTotpSecretBase32, verifyTotpCode } =
	await import('$lib/server/auth/totp');
const { REAUTH_FACTORS, reauthenticate, reauthRefusalMessage } = await import('./reauth');
const { logPseudonym, logSubnet, logUserPseudonym } = await import('$lib/server/logging/pseudonym');

const PASSWORD = 'the-right-password-1';
const IP = '203.0.113.7';
const USER = 'user-a';
const SESSION = 'session-a';

let passwordHash = '';
const secret = generateTotpSecretBase32();

beforeAll(async () => {
	passwordHash = await hashPassword(PASSWORD);
});

function codeFor(secretBase32: string): string {
	return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) }).generate();
}

/** A code that is six digits and is NOT valid in the current window for `secretBase32`. */
function wrongCodeFor(secretBase32: string): string {
	const right = codeFor(secretBase32);
	const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
	for (let n = 0; n < 1_000_000; n++) {
		const candidate = String((Number(right) + 1 + n) % 1_000_000).padStart(6, '0');
		if (totp.validate({ token: candidate, window: 1 }) === null) return candidate;
	}
	throw new Error('wrongCodeFor: no invalid code found, which cannot happen');
}

function form(fields: { password?: string; code?: string }): FormData {
	const data = new FormData();
	if (fields.password !== undefined) data.set(REAUTH_FIELDS.password, fields.password);
	if (fields.code !== undefined) data.set(REAUTH_FIELDS.code, fields.code);
	return data;
}

function account({ totp }: { totp: boolean }) {
	return {
		passwordHash,
		totpEnabled: totp,
		totpSecretEncrypted: totp ? encryptTotpSecret(secret) : null
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	rateLimit.isReauthRateLimited.mockReset();
	rateLimit.isReauthRateLimited.mockResolvedValue(false);
	rateLimit.recordReauthAttempt.mockReset();
	rateLimit.recordReauthAttempt.mockResolvedValue(undefined);
	// The step a valid code records (#818) is accepted unless a test says otherwise. Whether a REAL
	// engine accepts it is `totpSingleUse.db-smoke.ts`'s; here the fake answers and the helper's
	// decision over the answer is what is tested.
	db.prisma.user.updateMany.mockReset();
	db.prisma.user.updateMany.mockResolvedValue({ count: 1 });
	// The account's factor is still the one the code was judged against, so an update that matched
	// nothing reads as a spent step.
	db.prisma.user.count.mockReset();
	db.prisma.user.count.mockResolvedValue(1);
});

describe('R3 on #841, as data', () => {
	// The table the ruling wrote, compared whole: a factor moved, an action added or one dropped is
	// a diff here rather than a silent change of what an action asks for.
	it('names every action and the factors it requires', () => {
		expect(REAUTH_FACTORS).toEqual({
			revokeSession: 'password',
			revokeOtherSessions: 'password',
			changePassword: 'password+totp-when-enabled',
			deleteAccount: 'password+totp-when-enabled',
			disableTotp: 'password+totp',
			confirmTotpSetup: 'password+new-secret-code',
			restoreData: 'password+totp-when-enabled',
			deleteUser: 'password+totp-when-enabled',
			resetPassword: 'password+totp-when-enabled'
		});
	});
});

describe('password only (7.5.2): revokeSession', () => {
	it('accepts the right password, and records nothing', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('revokeSession', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: true });
		expect(rateLimit.recordReauthAttempt).not.toHaveBeenCalled();
	});

	it('refuses a wrong password as wrong-password, and records an attempt', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('revokeSession', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: 'not-it' })
		});

		expect(outcome).toEqual({ ok: false, reason: 'wrong-password', asked: 'password' });
		expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith(SESSION, IP);
	});

	// TOTP is enabled on this account and no code is posted: a password-only action must not ask
	// for one, which separates « password » from « password+totp-when-enabled ».
	it('does not ask for a code even when the account has TOTP', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('revokeOtherSessions', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: true });
	});

	it('refuses an absent password as missing-password, without recording an attempt', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('revokeSession', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({})
		});

		expect(outcome).toEqual({ ok: false, reason: 'missing-password', asked: 'password' });
		expect(rateLimit.recordReauthAttempt).not.toHaveBeenCalled();
	});
});

describe('password plus TOTP when enabled (7.5.1)', () => {
	it('without TOTP: the password alone is enough', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('changePassword', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: true });
	});

	it('with TOTP: the right password and the right code pass', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('restoreData', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(secret) })
		});

		expect(outcome).toEqual({ ok: true });
	});

	it('with TOTP: the right password and no code is missing-totp, nothing recorded', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('changePassword', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: false, reason: 'missing-totp', asked: 'password-and-code' });
		expect(rateLimit.recordReauthAttempt).not.toHaveBeenCalled();
	});

	// A malformed code is the same « missing » as an absent one: the six-digit shape is checked
	// before any secret is consulted, so a shape refusal says nothing about the password.
	it('with TOTP: a code that is not six digits is missing-totp', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('deleteUser', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: '12345' })
		});

		expect(outcome).toEqual({ ok: false, reason: 'missing-totp', asked: 'password-and-code' });
	});

	it('with TOTP: the right password and a wrong code is wrong-totp, recorded', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('resetPassword', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: wrongCodeFor(secret) })
		});

		expect(outcome).toEqual({ ok: false, reason: 'wrong-totp', asked: 'password-and-code' });
		expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith(SESSION, IP);
	});

	// The password is reported first when both are wrong. Separates « both factors are evaluated
	// and the password wins » from « the code is checked first ».
	it('with TOTP: a wrong password and a wrong code is wrong-password', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('deleteAccount', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: 'not-it', code: wrongCodeFor(secret) })
		});

		expect(outcome).toEqual({ ok: false, reason: 'wrong-password', asked: 'password-and-code' });
		expect(rateLimit.recordReauthAttempt).toHaveBeenCalledTimes(1);
	});

	// A wrong password with the RIGHT code: the code must not carry the password.
	it('with TOTP: a wrong password and the right code is wrong-password', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('deleteAccount', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: 'not-it', code: codeFor(secret) })
		});

		expect(outcome).toEqual({ ok: false, reason: 'wrong-password', asked: 'password-and-code' });
	});

	// Step 4: the code is verified even though the password already failed, so a wrong password and
	// a wrong code cost the same work and the response time does not say which one failed.
	// Separates « both factors always verified » from « the code skipped once the password failed »,
	// which returns the same reason and differs only in time.
	it('with TOTP: a wrong password still has its code verified', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		await reauthenticate('deleteAccount', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: 'not-it', code: codeFor(secret) })
		});

		expect(vi.mocked(verifyTotpCode)).toHaveBeenCalledTimes(1);
	});

	// #818: the step of a valid code is spent at verification, even when the password then fails.
	// Separates « spent whatever the password said » from « spent only on success », which would let
	// the same code be replayed after a deliberately wrong password.
	it('with TOTP: a wrong password still spends the right code', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		await reauthenticate('deleteAccount', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: 'not-it', code: codeFor(secret) })
		});

		// The predicate itself is the engine's to judge (`totpSingleUse.db-smoke.ts`), not restated.
		expect(db.prisma.user.updateMany).toHaveBeenCalledTimes(1);
		expect(db.prisma.user.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ id: USER }) })
		);
	});

	it('with TOTP: the right password and a code already used is reused-totp, recorded', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		const outcome = await reauthenticate('changePassword', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(secret) })
		});

		expect(outcome).toEqual({ ok: false, reason: 'reused-totp', asked: 'password-and-code' });
		expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith(SESSION, IP);
	});

	// The class 2 property of the reused reason: it must not depend on the password, or a replayed
	// code would answer « was this password right » to whoever holds the session. Separates
	// « reused whatever the password » from « reused only beside the right one ».
	it('with TOTP: a wrong password and a code already used is reused-totp too', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		const outcome = await reauthenticate('changePassword', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: 'not-it', code: codeFor(secret) })
		});

		expect(outcome).toEqual({ ok: false, reason: 'reused-totp', asked: 'password-and-code' });
	});
});

describe('password plus TOTP, required (disableTotp)', () => {
	it('passes with the right password and code', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('disableTotp', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(secret) })
		});

		expect(outcome).toEqual({ ok: true });
	});

	it('refuses as totp-not-enabled on an account without TOTP, before any secret', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('disableTotp', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: '123456' })
		});

		expect(outcome).toEqual({
			ok: false,
			reason: 'totp-not-enabled',
			asked: 'password-and-code'
		});
		expect(rateLimit.recordReauthAttempt).not.toHaveBeenCalled();
	});
});

describe('password plus a code from the new secret (confirmTotpSetup)', () => {
	const fresh = generateTotpSecretBase32();

	it('passes with the right password and a code from the POSTED secret, not the stored one', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('confirmTotpSetup', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(fresh) }),
			newTotpSecret: fresh
		});

		expect(outcome).toEqual({ ok: true, totpStep: expect.any(Number) });
	});

	// The contradiction pass on #818: an enrolment code is JUDGED here and spent by the enabling
	// write, never here. Separates « judged only » from « spent at verification », which let a
	// session holder with no password move the account's step ahead with a wrong password.
	it.each([
		['the right', PASSWORD],
		['a wrong', 'not-it']
	])('spends no step with %s password', async (_, password) => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		await reauthenticate('confirmTotpSetup', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password, code: codeFor(fresh) }),
			newTotpSecret: fresh
		});

		expect(db.prisma.user.updateMany).not.toHaveBeenCalled();
	});

	// The contradiction pass on S1: enrolling over an EXISTING second factor replaced it with the
	// password alone, and handed back fresh recovery codes, after which every « TOTP when enabled »
	// action fell to the password. Separates « enrolment needs an account with no factor » from
	// « the password plus a secret the caller chose is enough to take the factor over ».
	it('refuses as totp-already-enabled on an account that has a factor, before any secret', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('confirmTotpSetup', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(fresh) }),
			newTotpSecret: fresh
		});

		expect(outcome).toEqual({ ok: false, reason: 'totp-already-enabled' });
		expect(rateLimit.recordReauthAttempt).not.toHaveBeenCalled();
		// BEFORE any secret: the refusal is decided by the account's own state, so no code is
		// verified. Separates « refused first » from « refused after the secrets were consulted ».
		expect(vi.mocked(verifyTotpCode)).not.toHaveBeenCalled();
	});

	// One predicate for « has a factor » in the helper (the second contradiction pass on S1): the
	// flag set with no stored secret is no factor, so enrolment repairs the row instead of refusing,
	// exactly as disableTotp refuses it as totp-not-enabled. No writer produces this row; the test
	// pins that the two refusals cannot both close it.
	it('enrols over a flag that has no stored secret, which is no factor', async () => {
		db.prisma.user.findUnique.mockResolvedValue({
			passwordHash,
			totpEnabled: true,
			totpSecretEncrypted: null
		});

		const outcome = await reauthenticate('confirmTotpSetup', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(fresh) }),
			newTotpSecret: fresh
		});

		expect(outcome).toEqual({ ok: true, totpStep: expect.any(Number) });
	});

	it('refuses a code from another secret as wrong-totp', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('confirmTotpSetup', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: wrongCodeFor(fresh) }),
			newTotpSecret: fresh
		});

		expect(outcome).toEqual({ ok: false, reason: 'wrong-totp', asked: 'password-and-code' });
	});

	// The secret is client-posted, so it can be anything. A value that is not base32 must refuse
	// rather than throw a 500.
	it('refuses a posted secret that is not base32 as wrong-totp, without throwing', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('confirmTotpSetup', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD, code: '123456' }),
			newTotpSecret: '!!!not-base32!!!'
		});

		expect(outcome).toEqual({ ok: false, reason: 'wrong-totp', asked: 'password-and-code' });
	});
});

describe('the limiter', () => {
	it('refuses as rate-limited before reading the account', async () => {
		rateLimit.isReauthRateLimited.mockResolvedValueOnce(true);

		const outcome = await reauthenticate('deleteAccount', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: false, reason: 'rate-limited' });
		expect(db.prisma.user.findUnique).not.toHaveBeenCalled();
		expect(rateLimit.isReauthRateLimited).toHaveBeenCalledWith(SESSION);
	});
});

describe('the account read', () => {
	it('reads only the caller, by id', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		await reauthenticate('revokeSession', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(db.prisma.user.findUnique).toHaveBeenCalledWith({
			where: { id: USER },
			select: { passwordHash: true, totpEnabled: true, totpSecretEncrypted: true }
		});
	});

	// The form is read for REAUTH_FIELDS and nothing else. Separates « the account is the caller's,
	// from locals » from « a posted id chooses whose secrets are checked », which would let a session
	// prove itself with ANOTHER account's password it happens to know, or its own against another's.
	it('ignores a posted userId: the account read is the caller', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));
		const posted = form({ password: PASSWORD });
		posted.set('userId', 'user-b');

		await reauthenticate('revokeSession', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: posted
		});

		expect(db.prisma.user.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: USER } })
		);
	});

	it('refuses as no-account when the row is gone', async () => {
		db.prisma.user.findUnique.mockResolvedValue(null);

		const outcome = await reauthenticate('revokeSession', {
			user: { id: USER, sessionId: SESSION },
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: false, reason: 'no-account', asked: 'password' });
	});
});

describe('what a refusal says (#854 class 2)', () => {
	// The reasons a person typing their own credentials can produce, per thing asked. Every one of
	// them must render the SAME sentence: the reason is for the log, never for the screen.
	it('one sentence for every credential reason when only the password was asked', () => {
		const sentences = new Set(
			(['missing-password', 'wrong-password', 'no-account'] as const).map((reason) =>
				reauthRefusalMessage({ ok: false, reason, asked: 'password' })
			)
		);

		expect([...sentences]).toEqual([m.reauth_error_password()]);
	});

	it('one sentence for every credential reason when a code was asked too', () => {
		const sentences = new Set(
			(
				[
					'missing-password',
					'wrong-password',
					'missing-totp',
					'wrong-totp',
					'totp-not-enabled',
					'no-account'
				] as const
			).map((reason) => reauthRefusalMessage({ ok: false, reason, asked: 'password-and-code' }))
		);

		expect([...sentences]).toEqual([m.reauth_error_password_or_code()]);
	});

	// Not a credential fact: the session already sees the factor on /settings. The owner reaches it
	// by pressing « Enable » twice, and the credential sentence told them a right password was wrong
	// (the second contradiction pass on S1). Separates « says the factor is on, and how to get new
	// codes » from « says the password or the code was wrong ».
	it('an enrolment over an existing factor says so, not that a secret was wrong', () => {
		expect(reauthRefusalMessage({ ok: false, reason: 'totp-already-enabled' })).toBe(
			m.settings_mfa_error_already_enabled()
		);
	});

	// #818: the one credential reason with its own sentence, because waiting for the next code is
	// the one thing that helps. Safe only because the reason does not depend on the password.
	it('a code already used says so', () => {
		expect(
			reauthRefusalMessage({ ok: false, reason: 'reused-totp', asked: 'password-and-code' })
		).toBe(m.totp_error_code_reused());
	});

	it('the limiter keeps its own sentence', () => {
		expect(reauthRefusalMessage({ ok: false, reason: 'rate-limited' })).toBe(
			m.settings_error_reauth_too_many()
		);
	});
});

/**
 * L3 (#250, contract of 2026-10-08): `reauthenticate` is the single exit, so it writes the one event
 * of each outcome. A success carries the user, the action and the client; a credential refusal
 * also carries the subnet label and its width, because the REAUTH limiter counts it (#936). A shape
 * refusal, a missing account and a factor-state refusal checked no secret and write nothing; a
 * limiter trip writes `excess_rate_limit_exceeded` here, from the trip the wrapper returns.
 *
 * Expected pseudonyms come from the production functions, never from a retyped HMAC. `IP` is IPv4,
 * so the width is 32 (contract), asserted as that figure in its own test.
 */
type LoggedEvent = { event: string; attributes: Record<string, unknown> };

const events = () => logWriter.log.mock.calls.map(([event]) => event as LoggedEvent);

function reauthSuccess(action: string): LoggedEvent {
	return {
		event: EVENT.authnReauthSuccess,
		attributes: {
			[ATTRIBUTE.userPseudonym]: logUserPseudonym(USER),
			[ATTRIBUTE.authnAction]: action,
			[ATTRIBUTE.clientPseudonym]: logPseudonym(IP)
		}
	};
}

function reauthFail(action: string, reason: string): LoggedEvent {
	const subnet = logSubnet(IP);
	return {
		event: EVENT.authnReauthFail,
		attributes: {
			[ATTRIBUTE.userPseudonym]: logUserPseudonym(USER),
			[ATTRIBUTE.authnAction]: action,
			[ATTRIBUTE.authnReason]: reason,
			[ATTRIBUTE.clientPseudonym]: logPseudonym(IP),
			[ATTRIBUTE.clientSubnetPseudonym]: subnet.pseudonym,
			[ATTRIBUTE.clientSubnetPrefixLength]: subnet.prefixLength
		}
	};
}

/** A success never carries the subnet label (contract invariant 1), checked before the whole object. */
function expectNoSubnetKeys(logged: LoggedEvent[]) {
	expect(typeof ATTRIBUTE.clientSubnetPseudonym).toBe('string');
	expect(typeof ATTRIBUTE.clientSubnetPrefixLength).toBe('string');
	for (const event of logged) {
		const keys = Object.keys(event.attributes ?? {});
		expect(keys).not.toContain(ATTRIBUTE.clientSubnetPseudonym);
		expect(keys).not.toContain(ATTRIBUTE.clientSubnetPrefixLength);
	}
}

const caller = { id: USER, sessionId: SESSION };

describe('L3 events: a success writes reauth_success, without the subnet label', () => {
	it('password: revokeSession', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('revokeSession', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: true });
		expectNoSubnetKeys(events());
		expect(events()).toEqual([reauthSuccess('revokeSession')]);
	});

	it('password+totp-when-enabled, with TOTP: changePassword', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('changePassword', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(secret) })
		});

		expect(outcome).toEqual({ ok: true });
		expectNoSubnetKeys(events());
		expect(events()).toEqual([reauthSuccess('changePassword')]);
	});

	it('password+totp: disableTotp', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('disableTotp', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(secret) })
		});

		expect(outcome).toEqual({ ok: true });
		expectNoSubnetKeys(events());
		expect(events()).toEqual([reauthSuccess('disableTotp')]);
	});

	it('password+new-secret-code: confirmTotpSetup', async () => {
		const fresh = generateTotpSecretBase32();
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('confirmTotpSetup', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(fresh) }),
			newTotpSecret: fresh
		});

		expect(outcome).toEqual({ ok: true, totpStep: expect.any(Number) });
		expectNoSubnetKeys(events());
		expect(events()).toEqual([reauthSuccess('confirmTotpSetup')]);
	});
});

describe('L3 events: a credential refusal writes reauth_fail with its reason and the subnet label', () => {
	it('wrong-password is wrong_password', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('revokeSession', {
			user: caller,
			ip: IP,
			form: form({ password: 'not-it' })
		});

		expect(outcome).toEqual({ ok: false, reason: 'wrong-password', asked: 'password' });
		expect(events()).toEqual([reauthFail('revokeSession', 'wrong_password')]);
	});

	// Contract invariant 2, as the contract's figure: an IPv4 client is hashed as its /32.
	it('carries the subnet width 32 for an IPv4 client', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		await reauthenticate('revokeSession', {
			user: caller,
			ip: IP,
			form: form({ password: 'not-it' })
		});

		expect(events()).toHaveLength(1);
		expect(events()[0].attributes[ATTRIBUTE.clientSubnetPrefixLength]).toBe(32);
	});

	// Contract invariant 5 and the #869 note: the pseudonym is taken after the record, so a throw
	// while taking it cannot skip the record. Separates « recorded, then logged » from the reverse.
	it('is written after the attempt is recorded', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		await reauthenticate('revokeSession', {
			user: caller,
			ip: IP,
			form: form({ password: 'not-it' })
		});

		expect(logWriter.log).toHaveBeenCalledTimes(1);
		expect(rateLimit.recordReauthAttempt).toHaveBeenCalledTimes(1);
		expect(logWriter.log.mock.invocationCallOrder[0]).toBeGreaterThan(
			rateLimit.recordReauthAttempt.mock.invocationCallOrder[0]
		);
	});

	it('wrong-totp is wrong_code', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('resetPassword', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD, code: wrongCodeFor(secret) })
		});

		expect(outcome).toEqual({ ok: false, reason: 'wrong-totp', asked: 'password-and-code' });
		expect(events()).toEqual([reauthFail('resetPassword', 'wrong_code')]);
	});

	it('wrong-totp on enrolment is wrong_code, under confirmTotpSetup', async () => {
		const fresh = generateTotpSecretBase32();
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('confirmTotpSetup', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD, code: wrongCodeFor(fresh) }),
			newTotpSecret: fresh
		});

		expect(outcome).toEqual({ ok: false, reason: 'wrong-totp', asked: 'password-and-code' });
		expect(events()).toEqual([reauthFail('confirmTotpSetup', 'wrong_code')]);
	});

	it('reused-totp is reused_code', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));
		db.prisma.user.updateMany.mockResolvedValue({ count: 0 });

		const outcome = await reauthenticate('changePassword', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(secret) })
		});

		expect(outcome).toEqual({ ok: false, reason: 'reused-totp', asked: 'password-and-code' });
		expect(events()).toEqual([reauthFail('changePassword', 'reused_code')]);
	});
});

describe('L3 events: no reauth event when no secret was checked', () => {
	// No secret was checked on these three (contract, « Not logged »): the account is gone, or its
	// factor state refuses the action before any secret is read.
	it('no-account writes nothing', async () => {
		db.prisma.user.findUnique.mockResolvedValue(null);

		const outcome = await reauthenticate('revokeSession', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: false, reason: 'no-account', asked: 'password' });
		expect(events()).toEqual([]);
	});

	it('totp-not-enabled writes nothing', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('disableTotp', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD, code: '123456' })
		});

		expect(outcome).toEqual({ ok: false, reason: 'totp-not-enabled', asked: 'password-and-code' });
		expect(events()).toEqual([]);
	});

	it('totp-already-enabled writes nothing', async () => {
		const fresh = generateTotpSecretBase32();
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('confirmTotpSetup', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD, code: codeFor(fresh) }),
			newTotpSecret: fresh
		});

		expect(outcome).toEqual({ ok: false, reason: 'totp-already-enabled' });
		expect(events()).toEqual([]);
	});

	// Calibration of the capture: a line written through the module the helper imports is seen.
	it('captures a line written through the logging module the helper imports', async () => {
		const { log } = await import('$lib/server/logging');
		const line = { event: EVENT.configOriginUnset, attributes: {} };

		log(line as never);

		expect(events()).toEqual([line]);
	});

	it('missing-password writes nothing', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: false }));

		const outcome = await reauthenticate('revokeSession', {
			user: caller,
			ip: IP,
			form: form({})
		});

		expect(outcome).toEqual({ ok: false, reason: 'missing-password', asked: 'password' });
		expect(events()).toEqual([]);
	});

	it('missing-totp writes nothing', async () => {
		db.prisma.user.findUnique.mockResolvedValue(account({ totp: true }));

		const outcome = await reauthenticate('changePassword', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: false, reason: 'missing-totp', asked: 'password-and-code' });
		expect(events()).toEqual([]);
	});

	// The trip is written by the CALLER (contract: rateLimit.ts logs nothing), from the trip the
	// wrapper returns, with the user and which counter tripped; and no reauth event beside it.
	it('rate-limited writes one excess_rate_limit_exceeded, with the counter, user and subnet', async () => {
		rateLimit.isReauthRateLimited.mockResolvedValueOnce({ counter: 'subject' } as never);

		const outcome = await reauthenticate('deleteAccount', {
			user: caller,
			ip: IP,
			form: form({ password: PASSWORD })
		});

		expect(outcome).toEqual({ ok: false, reason: 'rate-limited' });
		const subnet = logSubnet(IP);
		expect(events()).toEqual([
			{
				event: EVENT.rateLimitExceeded,
				attributes: {
					[ATTRIBUTE.rateLimitKind]: 'REAUTH',
					[ATTRIBUTE.rateLimitCounter]: 'subject',
					[ATTRIBUTE.userPseudonym]: logUserPseudonym(USER),
					[ATTRIBUTE.clientPseudonym]: logPseudonym(IP),
					[ATTRIBUTE.clientSubnetPseudonym]: subnet.pseudonym,
					[ATTRIBUTE.clientSubnetPrefixLength]: subnet.prefixLength
				}
			}
		]);
	});
});
