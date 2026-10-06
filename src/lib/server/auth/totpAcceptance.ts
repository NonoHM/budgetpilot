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
export type TotpAcceptance = 'accepted' | 'wrong' | 'reused';

/**
 * Judges a code against the account's stored secret and spends its step: one conditional update
 * that records the step only if it is later than the last step accepted for this user, accepted iff
 * that update matched the row. The comparison and the write are one statement, so two concurrent
 * requests carrying one code cannot both read « not used yet ». Refusing every step AT OR BELOW the
 * last one also refuses an older code still inside the window after a newer one was accepted.
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
	const step = stepOf(() => decryptTotpSecret(storedSecretEncrypted), code);
	if (step === null) return 'wrong';

	const { count } = await prisma.user.updateMany({
		where: {
			id: userId,
			OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }]
		},
		data: { totpLastUsedStep: step }
	});
	return count === 1 ? 'accepted' : 'reused';
}

/**
 * Judges a code against a secret being enrolled, and spends nothing: the step it returns is for
 * `confirmTotpSetup` to write with the secret. Null when the code is wrong.
 */
export function judgeEnrolmentCode(secretBase32: string, code: string): number | null {
	return stepOf(() => secretBase32, code);
}

/**
 * A stored secret that will not decrypt (a rotated key) or a posted secret that is not base32 makes
 * decryption or the TOTP library throw. Either is a code that cannot be right, so it is answered as
 * one rather than as a 500 that would tell the caller something the refusal does not.
 */
function stepOf(readSecret: () => string, code: string): number | null {
	try {
		return verifyTotpCode(readSecret(), code);
	} catch {
		return null;
	}
}
