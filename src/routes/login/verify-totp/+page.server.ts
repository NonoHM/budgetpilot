import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { createSession, getSafeRedirect } from '$lib/server/auth';
import { consumeMfaChallenge, readMfaChallenge } from '$lib/server/auth/mfaChallenge';
import { isMfaRateLimited, recordMfaAttempt } from '$lib/server/auth/rateLimit';
import { resolveClientAddress } from '$lib/server/net/clientAddress';
import { verifyTotpCode, decryptTotpSecret, verifyRecoveryCode } from '$lib/server/auth/totp';
import { ensureDefaultCategoriesSeeded } from '$lib/server/categories/defaults';
import { ensureDefaultRulesSeeded } from '$lib/server/categorization/defaultRules';
import { prisma } from '$lib/server/db';
import type { PageServerLoad } from './$types';

const TOTP_CODE_PATTERN = /^[0-9]{6}$/;
const RECOVERY_CODE_PATTERN = /^[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5}$/;

export const load: PageServerLoad = async ({ cookies }) => {
	const challenge = await readMfaChallenge(cookies);
	if (!challenge) throw redirect(303, '/login');
	return {};
};

export const actions: Actions = {
	default: async ({ cookies, getClientAddress, request, url }) => {
		const invalid = () => fail(400, { error: m.mfa_verify_error_invalid_code() });
		const tooManyAttempts = () => fail(400, { error: m.mfa_verify_error_too_many_attempts() });

		const challenge = await readMfaChallenge(cookies);
		if (!challenge) throw redirect(303, '/login');

		const ip = resolveClientAddress({ getClientAddress, request });
		if (await isMfaRateLimited(challenge.id, ip)) return tooManyAttempts();

		const formData = await request.formData();
		const code = getFormValue(formData, 'code').trim();
		if (!code) return invalid();

		const user = await prisma.user.findUnique({
			where: { id: challenge.userId },
			select: { id: true, totpEnabled: true, totpSecretEncrypted: true }
		});

		if (!user || !user.totpEnabled || !user.totpSecretEncrypted) {
			// MFA was disabled in the meantime (another tab): the challenge no longer makes sense.
			await consumeMfaChallenge(challenge.id, cookies);
			throw redirect(303, '/login');
		}

		const ok = TOTP_CODE_PATTERN.test(code)
			? verifyTotpCodeSafely(user.totpSecretEncrypted, code)
			: RECOVERY_CODE_PATTERN.test(code)
				? await tryConsumeRecoveryCode(user.id, code.toUpperCase())
				: false;

		if (!ok) {
			await recordMfaAttempt(challenge.id, ip);
			return invalid();
		}

		await ensureDefaultCategoriesSeeded(user.id);
		await ensureDefaultRulesSeeded(user.id);
		await createSession(user.id, cookies);
		await consumeMfaChallenge(challenge.id, cookies);

		throw redirect(303, getSafeRedirect(url.searchParams.get('redirectTo')));
	}
};

// A rotated/corrupted key makes GCM decryption fail (invalid auth tag):
// treated as an invalid code rather than letting the request crash with a 500.
function verifyTotpCodeSafely(secretEncrypted: string, code: string): boolean {
	try {
		return verifyTotpCode(decryptTotpSecret(secretEncrypted), code);
	} catch {
		return false;
	}
}

async function tryConsumeRecoveryCode(userId: string, code: string): Promise<boolean> {
	const candidates = await prisma.recoveryCode.findMany({
		where: { userId, usedAt: null },
		select: { id: true, codeHash: true }
	});

	for (const candidate of candidates) {
		if (await verifyRecoveryCode(code, candidate.codeHash)) {
			const result = await prisma.recoveryCode.updateMany({
				where: { id: candidate.id, usedAt: null },
				data: { usedAt: new Date() }
			});
			return result.count === 1;
		}
	}
	return false;
}

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}
