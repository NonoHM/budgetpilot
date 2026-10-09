import { log } from '$lib/server/logging';
import type { ReauthAction } from '$lib/server/auth/reauth';
import type { RateLimitTrip } from '$lib/server/auth/rateLimit';
import { ATTRIBUTE as A, EVENT as E } from './names.ts';
import { logPseudonym, logSubnet, logUserPseudonym } from './pseudonym.ts';
import type {
	AttackClientFields,
	AuthAttemptKind,
	ClientFields,
	DeadSessionReason,
	ReauthFailure,
	RegistrationFailure,
	RegistrationMethod,
	SignInFactor,
	UserFields
} from './events.ts';

/**
 * The authentication events (L3, part of #250), and the only code that builds them. A caller hands
 * over what it holds, the resolved client address and the raw user id, and never a pseudonym: the
 * keyed hashes are taken here, so no route can log a raw value under a pseudonym's name, and which
 * events carry which client fields is decided by the types in `events.ts`, not by each caller.
 *
 * WHO CARRIES WHAT (R1 on #841, #936). The client pseudonym on every authentication event except a
 * sign-out and a session event; the subnet label and its width only on the three that signal an
 * attack: a failed sign-in, a failed re-authentication and a limiter refusal. An attack event is one
 * where a secret was checked and failed, or the limiter refused: a malformed form, or a refusal that
 * checked no secret, writes nothing.
 *
 * WHEN. A failure is logged after its limiter record, never before (#869): the pseudonyms throw on a
 * value that is not an address, as the limiter's own key does, and a throw here must not be able to
 * skip the record. Nothing is caught. At sign-in, the second factor and registration the limiter has
 * already hashed the same value, so the throw cannot happen there. Re-authentication counts the
 * session, not the address, so its event is the first reader of the address: on a peer that has
 * vanished (adapter-node answers `undefined` after a disconnect), the throw lands before the action
 * the re-authentication was for, which then does not run. Failing closed is the intent.
 *
 * THE ANSWER DOES NOT MOVE. Each function is one or more HMACs and one synchronous write, and none
 * returns anything a caller could branch on.
 */

function client(ip: string): ClientFields {
	return { [A.clientPseudonym]: logPseudonym(ip) };
}

function attackClient(ip: string): AttackClientFields {
	const subnet = logSubnet(ip);
	return {
		[A.clientPseudonym]: logPseudonym(ip),
		[A.clientSubnetPseudonym]: subnet.pseudonym,
		[A.clientSubnetPrefixLength]: subnet.prefixLength
	};
}

function user(userId: string): UserFields {
	return { [A.userPseudonym]: logUserPseudonym(userId) };
}

/** A session was created by signing in, with the factor that completed it. */
export function logSignInSucceeded(ip: string, userId: string, factor: SignInFactor): void {
	log({
		event: E.authnLoginSuccess,
		attributes: { ...client(ip), ...user(userId), [A.authnFactor]: factor }
	});
}

/** The password was right and the account asks for its second factor: half a sign-in. */
export function logSecondFactorRequired(ip: string, userId: string): void {
	log({ event: E.authnSecondFactorRequired, attributes: { ...client(ip), ...user(userId) } });
}

/** Why a sign-in failed. `unknown_account` alone has no user: there is none to name. */
export type SignInFailure =
	| { step: 'password'; reason: 'unknown_account' }
	| { step: 'password'; reason: 'wrong_password' | 'superseded'; userId: string }
	| {
			step: 'second_factor';
			reason:
				| 'wrong_code'
				| 'reused_code'
				| 'wrong_recovery_code'
				| 'unrecognised_code'
				| 'unreadable_secret'
				| 'superseded';
			userId: string;
	  };

export function logSignInFailed(ip: string, failure: SignInFailure): void {
	const where = attackClient(ip);
	log({
		event: E.authnLoginFail,
		attributes:
			failure.reason === 'unknown_account'
				? { ...where, [A.authnStep]: failure.step, [A.authnReason]: failure.reason }
				: failure.step === 'password'
					? {
							...where,
							...user(failure.userId),
							[A.authnStep]: failure.step,
							[A.authnReason]: failure.reason
						}
					: {
							...where,
							...user(failure.userId),
							[A.authnStep]: failure.step,
							[A.authnReason]: failure.reason
						}
	});
}

/**
 * The limiter refused an authentication attempt, with the counter that was full: `subject` says the
 * account, challenge or session was, which is not this client's doing (an attacker filling a victim's
 * email counter refuses the victim too). The user where the caller knows it (MFA, REAUTH).
 */
export function logRateLimited(
	kind: AuthAttemptKind,
	trip: RateLimitTrip,
	ip: string,
	userId?: string
): void {
	log({
		event: E.rateLimitExceeded,
		attributes: {
			...attackClient(ip),
			...(userId === undefined ? {} : user(userId)),
			[A.rateLimitKind]: kind,
			[A.rateLimitCounter]: trip.counter
		}
	});
}

/**
 * A code was judged against a stored second-factor secret that does not decrypt (#904): the
 * configured key is not the one it was stored with. Written where a code is JUDGED, at sign-in and
 * at re-authentication, never when a page merely shows the state. No client: the cause is the
 * server's key, and the attempt that met it is its own event, with the client.
 */
export function logSecretUnreadable(userId: string): void {
	log({
		event: E.cryptDecryptFail,
		attributes: { ...user(userId), [A.cryptPurpose]: 'totp_secret' }
	});
}

/** A sign-out. No client: it signals nothing (#936), and R1 does not require one. */
export function logSignedOut(userId: string): void {
	log({ event: E.authnLogout, attributes: user(userId) });
}

/** An account created by registration, which the same request signs in. */
export function logAccountCreated(ip: string, userId: string, method: RegistrationMethod): void {
	log({
		event: E.userCreated,
		attributes: { ...client(ip), ...user(userId), [A.authnMethod]: method }
	});
}

/** A registration refused after a check (the token, the invitation, the address taken). */
export function logRegistrationFailed(ip: string, reason: RegistrationFailure): void {
	log({ event: E.authnRegisterFail, attributes: { ...client(ip), [A.authnReason]: reason } });
}

export function logReauthSucceeded(ip: string, userId: string, action: ReauthAction): void {
	log({
		event: E.authnReauthSuccess,
		attributes: { ...client(ip), ...user(userId), [A.authnAction]: action }
	});
}

export function logReauthFailed(
	ip: string,
	userId: string,
	action: ReauthAction,
	reason: ReauthFailure
): void {
	log({
		event: E.authnReauthFail,
		attributes: {
			...attackClient(ip),
			...user(userId),
			[A.authnAction]: action,
			[A.authnReason]: reason
		}
	});
}

/** A request carried a session cookie that resolves to no live session. No client (#936). */
export function logDeadSession(reason: DeadSessionReason, userId?: string): void {
	log({
		event: E.sessionInvalid,
		attributes: { ...(userId === undefined ? {} : user(userId)), [A.sessionReason]: reason }
	});
}
