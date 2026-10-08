import { decryptTotpSecret, verifyTotpCode } from '$lib/server/auth/totp';
import { prisma } from '$lib/server/db';

/**
 * The one place a TOTP code is JUDGED, for sign-in, re-authentication and enrolment alike (#818).
 * Where it is SPENT depends on whether the account already has a second factor:
 *
 * - `acceptTotpCode`, against the account's STORED secret (sign-in, re-authentication): judged and
 *   spent here, in one statement.
 * - `judgeEnrolmentCode`, against the secret being ENROLLED: judged here and spent by
 *   `confirmTotpSetup`, which writes the code's step in the same update that stores the secret and
 *   turns two-factor on. Before that update the account has no factor, so no earlier code can be
 *   replayed against it, and nothing needs refusing as reused. Spending it here instead, before the
 *   password is known to be right, let a session holder with no password move the account's step
 *   ahead and have the owner's own enrolment refused as reused (the contradiction pass on #818).
 *
 * `ASVS v5.0.0-6.5.1` asks that a TOTP be « only successfully usable once », and RFC 6238 section
 * 5.2 that « The verifier MUST NOT accept the second attempt of the OTP after the successful
 * validation has been issued for the first OTP ».
 */
export type TotpAcceptance = 'accepted' | 'wrong' | 'reused' | 'unreadable';

/**
 * The stored secret in clear, or null when it does not decrypt (#904): the configured
 * `TOTP_ENCRYPTION_KEY` is not the key it was stored with, or the stored value is malformed. Pure:
 * the caller that JUDGES a code against it logs the failure, a page that only shows the state does
 * not.
 */
export function readStoredTotpSecret(storedSecretEncrypted: string): string | null {
	try {
		return decryptTotpSecret(storedSecretEncrypted);
	} catch {
		return null;
	}
}

/** What an account's second factor is, read from its row. */
export type StoredFactorState = 'disabled' | 'enabled' | 'unreadable';

/**
 * The one answer to « what is this account's second factor », for Settings and re-authentication.
 * Recomputed on every read and never stored: whether a secret decrypts is a verdict on the present,
 * and an operator who puts the old key back must see every factor return without a migration.
 *
 * `unreadable` is a FACTOR. It refuses every code, and it is never read as « none »: read as none,
 * re-authentication would lower each action to the password, and enrolment would replace it with a
 * secret the caller chose (the contradiction pass on #904's design note).
 *
 * A flag with no ciphertext is `disabled`, as re-authentication has always read it. The two writers
 * (enable and disable in Settings) set both columns together, so only a hand edit makes one.
 */
export function storedFactorState(row: {
	totpEnabled: boolean;
	totpSecretEncrypted: string | null;
}): StoredFactorState {
	if (!row.totpEnabled || row.totpSecretEncrypted === null) return 'disabled';
	return readStoredTotpSecret(row.totpSecretEncrypted) === null ? 'unreadable' : 'enabled';
}

/**
 * Judges a code against the account's stored secret and spends its step: one conditional update
 * that records the step only if it is later than the last step accepted for this user, accepted iff
 * that update matched the row. The comparison and the write are one statement, so two concurrent
 * requests carrying one code cannot both read « not used yet ». Refusing every step AT OR BELOW the
 * last one also refuses an older code still inside the window after a newer one was accepted.
 *
 * The update also requires the factor the code was judged against to be still the account's
 * (`totpEnabled` and the same ciphertext), and a code refused because it no longer is answers
 * `wrong`, since it was not judged against the account's current factor.
 *
 * The update commits on its own, so a step is spent the moment it is verified, whatever happens
 * next: a re-authentication whose password was wrong, or whose action is then refused. Rolling the
 * step back with a later failure would make a code that has been seen usable again; spent and
 * unused is the safe direction, and its cost is a wait for the next code.
 */
export async function acceptTotpCode(
	userId: string,
	storedSecretEncrypted: string,
	code: string
): Promise<TotpAcceptance> {
	const secret = readStoredTotpSecret(storedSecretEncrypted);
	// Nothing can be judged, so nothing is spent: no step is written for a code nobody checked.
	if (secret === null) return 'unreadable';
	const step = stepOf(() => secret, code);
	if (step === null) return 'wrong';

	const sameFactor = { id: userId, totpEnabled: true, totpSecretEncrypted: storedSecretEncrypted };
	const { count } = await prisma.user.updateMany({
		where: {
			...sameFactor,
			OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }]
		},
		data: { totpLastUsedStep: step }
	});
	if (count === 1) return 'accepted';
	// Matched nothing: a spent step if the factor is unchanged, otherwise a factor changed since the
	// ciphertext was read (a disable, or a disable and a new enrolment, committed in between).
	return (await prisma.user.count({ where: sameFactor })) === 1 ? 'reused' : 'wrong';
}

/**
 * Judges a code against a secret being enrolled, and spends nothing: the step it returns is for
 * `confirmTotpSetup` to write with the secret. Null when the code is wrong.
 */
export function judgeEnrolmentCode(secretBase32: string, code: string): number | null {
	return stepOf(() => secretBase32, code);
}

/**
 * A posted secret that is not base32 makes the TOTP library throw. That is a code that cannot be
 * right, so it is answered as one rather than as a 500 that would tell the caller something the
 * refusal does not. A stored secret that will not decrypt never reaches here: it is `unreadable`.
 */
function stepOf(readSecret: () => string, code: string): number | null {
	try {
		return verifyTotpCode(readSecret(), code);
	} catch {
		return null;
	}
}
