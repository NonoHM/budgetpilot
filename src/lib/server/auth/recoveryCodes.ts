import { verifyRecoveryCode } from '$lib/server/auth/totp';
import { prisma } from '$lib/server/db';

/**
 * The shape of a recovery code as `generateRecoveryCodes` prints it, either case. Sign-in and the
 * one re-authentication that takes a recovery code (#904) both test a posted code against it, so the
 * two cannot disagree on what is one.
 */
export const RECOVERY_CODE_PATTERN = /^[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5}$/;

/**
 * Checks `code` against the caller's unused recovery codes and spends the one it matches, in one
 * conditional update, so two requests carrying the same code cannot both spend it
 * (`ASVS v5.0.0-6.5.1`). True only if this call spent it.
 *
 * The code is upper-cased here, not by each caller: the hashes were taken of the printed, upper-case
 * form, and a code typed in lower case must read the same at sign-in and at re-authentication.
 */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
	const printed = code.toUpperCase();
	const candidates = await prisma.recoveryCode.findMany({
		where: { userId, usedAt: null },
		select: { id: true, codeHash: true }
	});

	for (const candidate of candidates) {
		if (await verifyRecoveryCode(printed, candidate.codeHash)) {
			const result = await prisma.recoveryCode.updateMany({
				where: { id: candidate.id, usedAt: null },
				data: { usedAt: new Date() }
			});
			return result.count === 1;
		}
	}
	return false;
}
