import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { createSession, redirectAfterSignIn } from '$lib/server/auth';
import { consumeMfaChallenge, readMfaChallenge } from '$lib/server/auth/mfaChallenge';
import { isMfaRateLimited, recordMfaAttempt } from '$lib/server/auth/rateLimit';
import { resolveClientAddress } from '$lib/server/net/clientAddress';
import { verifyRecoveryCode } from '$lib/server/auth/totp';
import { acceptTotpCode, type TotpAcceptance } from '$lib/server/auth/totpAcceptance';
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

		// A TOTP code is spent here, by `acceptTotpCode`, even if the sign-in then fails: see why there.
		let verdict: TotpAcceptance = 'wrong';
		if (TOTP_CODE_PATTERN.test(code)) {
			verdict = await acceptTotpCode(user.id, user.totpSecretEncrypted, code);
		} else if (RECOVERY_CODE_PATTERN.test(code)) {
			verdict = (await tryConsumeRecoveryCode(user.id, code.toUpperCase())) ? 'accepted' : 'wrong';
		}

		if (verdict !== 'accepted') {
			await recordMfaAttempt(challenge.id, ip);
			// A spent code says so (#818): whoever typed it twice needs the next one, not a clock
			// check. Nothing in that is usable: the password is already proven at this step, and a
			// spent step is never accepted again.
			return verdict === 'reused' ? fail(400, { error: m.totp_error_code_reused() }) : invalid();
		}

		await ensureDefaultCategoriesSeeded(user.id);
		await ensureDefaultRulesSeeded(user.id);
		await createSession(user.id, cookies);
		await consumeMfaChallenge(challenge.id, cookies);

		redirectAfterSignIn(url);
	}
};

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
