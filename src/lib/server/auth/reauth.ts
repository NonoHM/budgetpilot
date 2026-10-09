import * as m from '$lib/paraglide/messages';
import { REAUTH_FIELDS } from '$lib/domain/reauthFields';
import { verifyPassword, type AuthUser } from '$lib/server/auth';
import { isReauthRateLimited, recordReauthAttempt } from '$lib/server/auth/rateLimit';
import { consumeRecoveryCode, RECOVERY_CODE_PATTERN } from '$lib/server/auth/recoveryCodes';
import {
	acceptTotpCode,
	judgeEnrolmentCode,
	storedFactorState,
	type TotpAcceptance
} from '$lib/server/auth/totpAcceptance';
import { prisma } from '$lib/server/db';
import {
	logRateLimited,
	logReauthFailed,
	logReauthSucceeded,
	logSecretUnreadable
} from '$lib/server/logging/authn';
import type { ReauthFailure } from '$lib/server/logging/events';

/**
 * Re-authentication: the ONE place an action that changes security state proves the caller still
 * holds the account's secrets, and the one place the outcome of that proof is decided.
 *
 * Before this module there were four inline copies in `routes/settings/+page.server.ts`, each with
 * its own order of checks, its own choice of whether an empty field consumed an attempt, and its own
 * sentence; and four actions with no check at all (#253, #228, #229). R3 on #841 rules which factors
 * each action requires, and `REAUTH_FACTORS` below is that ruling as data.
 *
 * WHAT THE CALLER GETS BACK IS A REASON, NEVER A SENTENCE. The reason is what L3 logs; the screen
 * gets `reauthRefusalMessage`, which collapses every credential reason into one sentence per thing
 * asked (#854 class 2: whoever holds a stolen session must not learn which factor failed).
 *
 * ORDER, and each step is load-bearing:
 *   1. The limiter, before any read: a throttled caller learns nothing about the account. It counts
 *      the caller's SESSION, never the account (#879: `isReauthRateLimited` says why).
 *   2. The account row, by the caller's own id (from `locals`, never posted).
 *   3. Shape: an absent password or a code that is not six digits refuses here, BEFORE any secret
 *      is JUDGED, and records no attempt. A shape refusal guesses nothing, so counting it would
 *      only let a fumbled form lock its owner out; and because no secret was judged, it cannot be an
 *      oracle for one. Whether the stored secret decrypts is known by then (#904: it decides which
 *      shape `disableTotp` accepts), but that is the state Settings already shows the session, not
 *      an answer about anything typed.
 *   4. Both factors, ALWAYS both: the password through bcrypt and the code through the TOTP window,
 *      whatever the first answered. The work then depends on whether the CODE is valid (a valid
 *      code against a stored secret also commits the update that spends it), never on whether the
 *      password was right, so the response time does not say whether the password failed. The
 *      password is reported first, except against a code already used (below).
 *   5. A wrong factor records one attempt against the session's REAUTH counter.
 *
 * A VALID CODE AGAINST THE STORED SECRET IS SPENT AT STEP 4, even when the password was wrong or
 * the action is then refused (#818, `acceptTotpCode`). That is the safe direction: a code spent,
 * never a code reusable. Its cost is the owner who mistyped the password waiting for the next code,
 * and the sentence they get on retrying the same one, `reused-totp`, tells them so. That reason is
 * reported WHATEVER the password answered, and it has to be: reported only beside a right
 * password, a replayed code would answer « was this password right » to whoever holds the session.
 *
 * A STORED SECRET THAT DOES NOT DECRYPT (#904, owner ruling of 2026-10-08) is still a factor, so it
 * is never read as « none ». No code can pass it: a six-digit code is refused `unreadable-totp`,
 * whatever the password answered, as `reused-totp` is and for the same reason. The one way out is
 * `disableTotp`, which then takes a RECOVERY CODE in the code field, checked and spent by
 * `consumeRecoveryCode` whatever the password answered (the #818 direction: a code seen is a code
 * spent; spending it only beside a right password would make the write a timing signal for the
 * password). Two factors still, as R3 asks. Every other action stays refused until the owner sets
 * two-factor up again, and enrolment over it is `totp-already-enabled`.
 *
 * AN ENROLMENT CODE IS ONLY JUDGED HERE (`judgeEnrolmentCode`): the success carries its step, and
 * `confirmTotpSetup` writes that step with the secret. See `totpAcceptance.ts` for why.
 *
 * WHAT A SUCCESS IS FOR: the action then writes its change through `commitWithRotatedToken` (or
 * `commitEndingSession` for deleting the account), which commits it together with a new session
 * token (#249, `v5.0.0-7.2.4`). Not here: rotating at the proof rather than at the commit left the
 * action's whole work as a window in which a logout could not find the session.
 * `sessionRotation.db-smoke.ts` drives every key of `REAUTH_FACTORS` and fails on one that does not.
 */

/** What an action asks for. R3 on #841, « Factors per action ». */
export type ReauthFactors =
	/** `ASVS v5.0.0-7.5.2`: « having authenticated again with at least one factor ». */
	| 'password'
	/** `ASVS v5.0.0-7.5.1`: « full re-authentication ». */
	| 'password+totp-when-enabled'
	/** Disabling the second factor needs it: refused when the account has none to disable. */
	| 'password+totp'
	/**
	 * Enrolling: the code comes from the NEW secret the client posts back, not a stored one. Refused
	 * when the account already has a factor: enrolling over it would replace the second factor with
	 * the password alone, and every 7.5.1 action would then fall to the password.
	 */
	| 'password+new-secret-code';

/**
 * Every action that re-authenticates, keyed by its route action name, with the factors it requires.
 *
 * Keyed by the ACTION NAME on purpose: the route specs enumerate these keys and drive each one
 * through the real action, so an action added here without being wired, or wired under another
 * name, fails there rather than shipping unchecked.
 *
 * `restoreData` (#228) and the two admin actions (#229) are not in R3's table. They are placed in
 * the 7.5.1 row because each is at least as destructive as `deleteAccount`, which R3 puts there:
 * a restore replaces every record the account owns, and an admin reset or delete acts on another
 * account. The admin proves THEIR OWN secrets: the target's are never asked for.
 */
export const REAUTH_FACTORS = {
	revokeSession: 'password',
	revokeOtherSessions: 'password',
	changePassword: 'password+totp-when-enabled',
	deleteAccount: 'password+totp-when-enabled',
	disableTotp: 'password+totp',
	confirmTotpSetup: 'password+new-secret-code',
	restoreData: 'password+totp-when-enabled',
	deleteUser: 'password+totp-when-enabled',
	resetPassword: 'password+totp-when-enabled'
} as const satisfies Record<string, ReauthFactors>;

export type ReauthAction = keyof typeof REAUTH_FACTORS;

/** Whether the form had to carry a code. Decides the sentence, never reveals which factor failed. */
export type ReauthAsked = 'password' | 'password-and-code';

export type ReauthCredentialRefusal =
	| 'missing-password'
	| 'wrong-password'
	| 'missing-totp'
	| 'wrong-totp'
	/** A valid code for a step already accepted for this account (#818). */
	| 'reused-totp'
	/** A six-digit code against a stored secret that does not decrypt (#904). */
	| 'unreadable-totp'
	/** At `disableTotp` over an unreadable secret: a recovery code that matches none unused (#904). */
	| 'wrong-recovery-code'
	| 'totp-not-enabled'
	| 'no-account';

export type ReauthRefused =
	| { ok: false; reason: 'rate-limited' }
	/**
	 * Enrolment over an existing factor. Not a credential refusal: the session already sees the
	 * factor on /settings, so it has its own sentence, which tells the owner who pressed « Enable »
	 * twice that it worked and how to get new recovery codes.
	 */
	| { ok: false; reason: 'totp-already-enabled' }
	| { ok: false; reason: ReauthCredentialRefusal; asked: ReauthAsked };

export type ReauthOutcome = { ok: true } | ReauthRefused;

/** Enrolment's success carries the step of the code it judged, for the enabling write to record. */
export type EnrolmentOutcome = { ok: true; totpStep: number } | ReauthRefused;

interface ReauthInput {
	/**
	 * `locals.user`, whole: its `id` finds the account and its `sessionId` keys the counter (#879).
	 * Taking the object rather than two strings leaves no field for a posted value to reach.
	 */
	user: Pick<AuthUser, 'id' | 'sessionId'>;
	/** Written to the attempt row, never counted: see `recordReauthAttempt`. */
	ip: string;
	/** The posted form, read for `REAUTH_FIELDS` and nothing else. */
	form: FormData;
}

const TOTP_CODE_PATTERN = /^[0-9]{6}$/;

export function reauthenticate(
	action: 'confirmTotpSetup',
	input: ReauthInput & { newTotpSecret: string }
): Promise<EnrolmentOutcome>;
export function reauthenticate(
	action: Exclude<ReauthAction, 'confirmTotpSetup'>,
	input: ReauthInput
): Promise<ReauthOutcome>;
export async function reauthenticate(
	action: ReauthAction,
	input: ReauthInput & { newTotpSecret?: string }
): Promise<ReauthOutcome | EnrolmentOutcome> {
	// THE single exit, and the one place a re-authentication is logged (L3): every path below
	// returns into this line. Logged before the caller acts, so a throw here stops the action.
	const outcome = await decide(REAUTH_FACTORS[action], input);
	logOutcome(action, input, outcome);
	return outcome;
}

/** What each refusal is in the log. Null: no secret was checked, so nothing is written. */
const LOGGED_REFUSAL: Record<ReauthRefused['reason'], ReauthFailure | null> = {
	'wrong-password': 'wrong_password',
	'wrong-totp': 'wrong_code',
	'reused-totp': 'reused_code',
	'unreadable-totp': 'unreadable_secret',
	'wrong-recovery-code': 'wrong_recovery_code',
	'missing-password': null,
	'missing-totp': null,
	'totp-not-enabled': null,
	'totp-already-enabled': null,
	'no-account': null,
	// The limiter's refusal is its own event, written in `decide` with the counter that tripped.
	'rate-limited': null
};

function logOutcome(
	action: ReauthAction,
	{ user, ip }: ReauthInput,
	outcome: ReauthOutcome | EnrolmentOutcome
): void {
	if (outcome.ok) {
		logReauthSucceeded(ip, user.id, action);
		return;
	}
	const reason = LOGGED_REFUSAL[outcome.reason];
	if (reason !== null) logReauthFailed(ip, user.id, action, reason);
}

async function decide(
	factors: ReauthFactors,
	{ user, ip, form, newTotpSecret }: ReauthInput & { newTotpSecret?: string }
): Promise<ReauthOutcome | EnrolmentOutcome> {
	const trip = await isReauthRateLimited(user.sessionId);
	if (trip) {
		logRateLimited('REAUTH', trip, ip, user.id);
		return { ok: false, reason: 'rate-limited' };
	}

	const account = await prisma.user.findUnique({
		where: { id: user.id },
		select: { passwordHash: true, totpEnabled: true, totpSecretEncrypted: true }
	});

	const state = account ? storedFactorState(account) : 'disabled';
	const storedSecret = state === 'disabled' ? null : (account?.totpSecretEncrypted ?? null);
	const asksCode =
		factors === 'password+totp' ||
		factors === 'password+new-secret-code' ||
		(factors === 'password+totp-when-enabled' && storedSecret !== null);
	// The ruling's one way out (#904): only turning the factor off, only while it cannot be read.
	const takesRecoveryCode = factors === 'password+totp' && state === 'unreadable';
	const asked: ReauthAsked = asksCode ? 'password-and-code' : 'password';
	const refuse = (reason: ReauthCredentialRefusal): ReauthRefused => ({ ok: false, reason, asked });

	if (!account) return refuse('no-account');

	const password = readField(form, REAUTH_FIELDS.password);
	const code = readField(form, REAUTH_FIELDS.code).trim();

	if (password.length === 0) return refuse('missing-password');
	if (factors === 'password+totp' && storedSecret === null) return refuse('totp-not-enabled');
	// The same predicate as `totp-not-enabled` above: one answer to « has a factor » in this helper.
	if (factors === 'password+new-secret-code' && storedSecret !== null) {
		return { ok: false, reason: 'totp-already-enabled' };
	}
	const recoveryCode = takesRecoveryCode && RECOVERY_CODE_PATTERN.test(code);
	if (asksCode && !recoveryCode && !TOTP_CODE_PATTERN.test(code)) return refuse('missing-totp');

	// Past the shape step a six-digit code is judged against the stored secret, so a secret that
	// cannot be is reported here, once. A recovery code is checked against its own rows, never the
	// secret, so it writes nothing here, as at sign-in (the contradiction pass on the code).
	if (asksCode && state === 'unreadable' && !recoveryCode) logSecretUnreadable(user.id);

	// Both evaluated before either is acted on: see step 4 in the header.
	const passwordOk = await verifyPassword(password, account.passwordHash);
	const enrolledStep =
		factors === 'password+new-secret-code' ? judgeEnrolmentCode(newTotpSecret ?? '', code) : null;
	let codeVerdict: TotpAcceptance | 'wrong-recovery-code' = 'accepted';
	if (factors === 'password+new-secret-code') {
		codeVerdict = enrolledStep === null ? 'wrong' : 'accepted';
	} else if (recoveryCode) {
		codeVerdict = (await consumeRecoveryCode(user.id, code)) ? 'accepted' : 'wrong-recovery-code';
	} else if (asksCode) {
		codeVerdict = await acceptTotpCode(user.id, storedSecret ?? '', code);
	}

	if (!passwordOk || codeVerdict !== 'accepted') {
		await recordReauthAttempt(user.sessionId, ip);
		// Decided by the stored state or the code, never by the password: see the header.
		if (codeVerdict === 'reused') return refuse('reused-totp');
		if (codeVerdict === 'unreadable') return refuse('unreadable-totp');
		if (!passwordOk) return refuse('wrong-password');
		return refuse(codeVerdict === 'wrong-recovery-code' ? 'wrong-recovery-code' : 'wrong-totp');
	}
	return enrolledStep === null ? { ok: true } : { ok: true, totpStep: enrolledStep };
}

function readField(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}

/**
 * The one sentence a refusal shows. Every credential reason under one `asked` reads the same, which
 * is the class 2 property (#854): one generic message whatever the cause. The limiter keeps its own
 * sentence, because it says nothing about the secrets and does tell the owner what to do.
 */
export function reauthRefusalMessage(
	refused: ReauthRefused
): ReturnType<typeof m.reauth_error_password> {
	if (refused.reason === 'rate-limited') return m.settings_error_reauth_too_many();
	if (refused.reason === 'totp-already-enabled') return m.settings_mfa_error_already_enabled();
	// Its own sentence, because waiting for the next code is the one thing that helps. Safe under
	// class 2 only because the reason does not depend on the password: see the header.
	if (refused.reason === 'reused-totp') return m.totp_error_code_reused();
	// Its own sentence for the same reason: it says what to do, and depends on the stored state alone.
	if (refused.reason === 'unreadable-totp') return m.reauth_error_totp_unreadable();
	return refused.asked === 'password'
		? m.reauth_error_password()
		: m.reauth_error_password_or_code();
}
