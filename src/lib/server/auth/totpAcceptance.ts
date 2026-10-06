import { decryptTotpSecret, verifyTotpCode } from '$lib/server/auth/totp';
import { prisma } from '$lib/server/db';

export type TotpAcceptance = 'accepted' | 'wrong' | 'reused';

/** The secret to judge against: the account's stored one, or the one being enrolled. */
export type TotpSecretSource = { stored: string } | { enrolling: string };

/**
 * Whether a TOTP code is ACCEPTED: the one place a code is judged, for sign-in, re-authentication
 * and enrolment alike (#818).
 *
 * `ASVS v5.0.0-6.5.1` asks that a TOTP be « only successfully usable once », and RFC 6238 section
 * 5.2 that « The verifier MUST NOT accept the second attempt of the OTP after the successful
 * validation has been issued for the first OTP ». Before this, a login challenge was single use and
 * the code was not: one code was accepted by a second challenge, and by a re-authenticated action.
 *
 * HOW: verify, then ONE conditional update that records the step only if it is later than the last
 * step accepted for this user. Accepted iff that update matched the row. The comparison and the write
 * are one statement, so two concurrent requests carrying one code cannot both read « not used yet »:
 * the engine serialises the two updates and the second matches nothing. Refusing every step AT OR
 * BELOW the last one, not only the same one, also refuses an older code still inside the window
 * after a newer one was accepted.
 *
 * NOT INSIDE A TRANSACTION WITH ANYTHING ELSE, on purpose. The update commits on its own, so a step
 * is spent the moment it is verified, whatever happens next: a re-authentication whose password was
 * wrong, a sign-in whose challenge another request consumed first. Rolling the step back with a
 * later failure would make a code that has been seen usable again; spent and unused is the safe
 * direction, and its cost is a wait for the next code.
 */
export async function acceptTotpCode(
	userId: string,
	secret: TotpSecretSource,
	code: string
): Promise<TotpAcceptance> {
	const step = matchedStep(secret, code);
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
 * A stored secret that will not decrypt (a rotated key) or a posted secret that is not base32 makes
 * decryption or the TOTP library throw. Either is a code that cannot be right, so it is answered as
 * one rather than as a 500 that would tell the caller something the refusal does not.
 */
function matchedStep(secret: TotpSecretSource, code: string): number | null {
	try {
		const base32 = 'stored' in secret ? decryptTotpSecret(secret.stored) : secret.enrolling;
		return verifyTotpCode(base32, code);
	} catch {
		return null;
	}
}
