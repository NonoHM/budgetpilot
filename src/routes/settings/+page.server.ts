import { existsSync } from 'node:fs';
import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	clearSessionCookie,
	hashPassword,
	hashSessionToken,
	requireUser,
	SESSION_COOKIE,
	verifyPassword
} from '$lib/server/auth';
import {
	buildTotpUri,
	decryptTotpSecret,
	encryptTotpSecret,
	generateRecoveryCodes,
	generateTotpQrCodeDataUrl,
	generateTotpSecretBase32,
	hashRecoveryCode,
	verifyTotpCode
} from '$lib/server/auth/totp';
import { prisma } from '$lib/server/db';
import { BackupImportError, restoreBackup } from '$lib/server/backup/import';
import { backupExportSchema } from '$lib/server/backup/schema';
import type { PageServerLoad } from './$types';

const TOTP_CODE_PATTERN = /^[0-9]{6}$/;

const DELETE_CONFIRMATION = 'SUPPRIMER';
const BACKUP_MAX_BYTES = 20_000_000;

export const load: PageServerLoad = async ({ cookies, locals }) => {
	const user = requireUser(locals.user);
	const currentToken = cookies.get(SESSION_COOKIE);
	const currentTokenHash = currentToken ? hashSessionToken(currentToken) : null;

	const [account, sessions] = await Promise.all([
		prisma.user.findUniqueOrThrow({
			where: { id: user.id },
			select: {
				email: true,
				role: true,
				aiInsightsEnabled: true,
				aiIncludeLabels: true,
				totpEnabled: true
			}
		}),
		prisma.session.findMany({
			where: { userId: user.id },
			select: {
				id: true,
				tokenHash: true,
				createdAt: true,
				expiresAt: true,
				revokedAt: true
			},
			orderBy: { createdAt: 'desc' }
		})
	]);

	const mappedSessions = sessions.map((session) => ({
		id: session.id,
		createdAt: session.createdAt,
		expiresAt: session.expiresAt,
		isCurrent: currentTokenHash === session.tokenHash,
		status:
			session.revokedAt || session.expiresAt <= new Date()
				? ('revoked' as const)
				: ('active' as const)
	}));
	const latestSession = mappedSessions[0] ?? null;

	return {
		account: {
			email: account.email,
			role: account.role
		},
		mfa: {
			enabled: account.totpEnabled
		},
		security: {
			authMode: 'locale',
			llmEnabled: process.env.LLM_ENABLED === 'true',
			runtime: detectRuntime(),
			latestSessionCreatedAt: latestSession?.createdAt ?? null
		},
		sessions: mappedSessions,
		aiSettings: {
			insightsEnabled: account.aiInsightsEnabled,
			includeLabels: account.aiIncludeLabels,
			llmGloballyEnabled: process.env.LLM_ENABLED === 'true'
		}
	};
};

export const actions: Actions = {
	changePassword: async ({ cookies, locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const currentPassword = getFormValue(formData, 'currentPassword');
		const newPassword = getFormValue(formData, 'newPassword');
		const confirmPassword = getFormValue(formData, 'confirmPassword');
		const currentToken = cookies.get(SESSION_COOKIE);
		const currentTokenHash = currentToken ? hashSessionToken(currentToken) : null;

		if (!currentPassword || !newPassword || !confirmPassword) {
			return fail(400, { passwordError: m.settings_error_password_update_failed() });
		}

		if (newPassword !== confirmPassword || newPassword.length < 12 || newPassword.length > 256) {
			return fail(400, { passwordError: m.settings_error_password_update_failed() });
		}

		const account = await prisma.user.findUnique({
			where: { id: user.id },
			select: {
				passwordHash: true
			}
		});
		if (!account) throw redirect(303, '/login');

		const currentPasswordOk = await verifyPassword(currentPassword, account.passwordHash);
		if (!currentPasswordOk)
			return fail(400, { passwordError: m.settings_error_password_update_failed() });

		const newPasswordHash = await hashPassword(newPassword);
		const now = new Date();

		await prisma.$transaction(async (tx) => {
			await tx.user.update({
				where: { id: user.id },
				data: {
					passwordHash: newPasswordHash
				}
			});

			await tx.session.updateMany({
				where: {
					userId: user.id,
					revokedAt: null,
					...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {})
				},
				data: {
					revokedAt: now
				}
			});
		});

		return {
			passwordSuccess: m.settings_success_password_updated()
		};
	},
	revokeOtherSessions: async ({ cookies, locals }) => {
		const user = requireUser(locals.user);
		const currentToken = cookies.get(SESSION_COOKIE);
		const currentTokenHash = currentToken ? hashSessionToken(currentToken) : null;

		await prisma.session.updateMany({
			where: {
				userId: user.id,
				revokedAt: null,
				...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {})
			},
			data: {
				revokedAt: new Date()
			}
		});

		return {
			sessionsSuccess: m.settings_success_sessions_revoked()
		};
	},
	revokeSession: async ({ cookies, locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const sessionId = getFormValue(formData, 'sessionId');
		const currentToken = cookies.get(SESSION_COOKIE);
		const currentTokenHash = currentToken ? hashSessionToken(currentToken) : null;

		if (!sessionId) {
			return fail(400, { sessionsError: m.settings_error_session_revoke_failed() });
		}

		const target = await prisma.session.findUnique({
			where: { id: sessionId },
			select: { userId: true, tokenHash: true }
		});
		if (!target || target.userId !== user.id) {
			return fail(404, { sessionsError: m.settings_error_session_revoke_failed() });
		}
		if (currentTokenHash && target.tokenHash === currentTokenHash) {
			return fail(400, { sessionsError: m.settings_error_session_revoke_current() });
		}

		await prisma.session.updateMany({
			where: { id: sessionId, userId: user.id, revokedAt: null },
			data: { revokedAt: new Date() }
		});

		return {
			sessionsSuccess: m.settings_success_session_revoked()
		};
	},
	deleteAccount: async ({ cookies, locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const confirmation = getFormValue(formData, 'confirmation');

		if (confirmation !== DELETE_CONFIRMATION) {
			return fail(400, { deleteError: m.settings_error_confirmation_required() });
		}

		await prisma.$transaction(async (tx) => {
			await tx.session.deleteMany({
				where: { userId: user.id }
			});
			await tx.user.delete({
				where: { id: user.id }
			});
		});

		clearSessionCookie(cookies);
		throw redirect(303, '/login');
	},
	restoreData: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const backupFile = formData.get('backupFile');

		if (!isUploadedFile(backupFile) || backupFile.size === 0) {
			return fail(400, { restoreError: m.settings_error_restore_no_file() });
		}

		if (backupFile.size > BACKUP_MAX_BYTES) {
			return fail(400, {
				restoreError: m.settings_error_restore_too_large({ max: BACKUP_MAX_BYTES / 1_000_000 })
			});
		}

		let rawText: string;
		try {
			rawText = await backupFile.text();
		} catch {
			return fail(400, { restoreError: m.settings_error_restore_read_failed() });
		}

		let rawJson: unknown;
		try {
			rawJson = JSON.parse(rawText);
		} catch {
			return fail(400, { restoreError: m.settings_error_restore_invalid_json() });
		}

		if (
			typeof rawJson !== 'object' ||
			rawJson === null ||
			!('formatVersion' in rawJson) ||
			(rawJson as { formatVersion?: unknown }).formatVersion !== 1
		) {
			return fail(400, { restoreError: m.settings_error_restore_unsupported_format() });
		}

		const parsed = backupExportSchema.safeParse(rawJson);
		if (!parsed.success) {
			return fail(400, { restoreError: m.settings_error_restore_corrupted() });
		}

		try {
			await restoreBackup(user.id, parsed.data);
		} catch (caught) {
			if (caught instanceof BackupImportError) {
				return fail(400, { restoreError: caught.message });
			}
			if (isPrismaUniqueError(caught)) {
				return fail(400, { restoreError: m.settings_error_restore_duplicate() });
			}
			throw caught;
		}

		return {
			restoreSuccess: m.settings_success_restored()
		};
	},
	updateAiInsightsEnabled: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const enabled = getFormValue(formData, 'enabled') === 'true';

		await prisma.user.update({
			where: { id: user.id },
			data: { aiInsightsEnabled: enabled }
		});

		return { aiSettingsSuccess: true };
	},
	updateAiIncludeLabels: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const enabled = getFormValue(formData, 'enabled') === 'true';

		await prisma.user.update({
			where: { id: user.id },
			data: { aiIncludeLabels: enabled }
		});

		return { aiSettingsSuccess: true };
	},
	// Persists nothing: the secret is only written to DB after confirmation via a
	// valid code (confirmTotpSetup), to never activate a secret that was mis-scanned.
	startTotpSetup: async ({ locals }) => {
		const user = requireUser(locals.user);

		const secretBase32 = generateTotpSecretBase32();
		const uri = buildTotpUri(user.email, secretBase32);
		const qrDataUrl = await generateTotpQrCodeDataUrl(uri);

		return { totpSetupPending: { secretBase32, qrDataUrl } };
	},
	// Requires the current password, symmetric to disableTotp: enabling a second factor
	// is at least as sensitive as disabling it (otherwise an already-open session would
	// be enough to enroll an attacker's device and obtain the recovery codes).
	confirmTotpSetup: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const currentPassword = getFormValue(formData, 'currentPassword');
		const secretBase32 = getFormValue(formData, 'secretBase32');
		const code = getFormValue(formData, 'code').trim();

		// On failure, we return the same secret + a fresh QR code: the user can
		// retry without re-scanning a new QR code in their authenticator app.
		const invalid = async (message = m.settings_mfa_error_invalid_code()) =>
			fail(400, {
				totpSetupError: message,
				totpSetupPending: secretBase32
					? {
							secretBase32,
							qrDataUrl: await generateTotpQrCodeDataUrl(buildTotpUri(user.email, secretBase32))
						}
					: undefined
			});
		if (!currentPassword || !secretBase32 || !TOTP_CODE_PATTERN.test(code)) return invalid();

		const account = await prisma.user.findUnique({
			where: { id: user.id },
			select: { passwordHash: true }
		});
		if (!account) throw redirect(303, '/login');

		const passwordOk = await verifyPassword(currentPassword, account.passwordHash);
		if (!passwordOk) return invalid(m.settings_mfa_error_setup_invalid_password());

		if (!verifyTotpCode(secretBase32, code)) return invalid();

		const recoveryCodes = generateRecoveryCodes();
		const recoveryCodeHashes = await Promise.all(recoveryCodes.map((c) => hashRecoveryCode(c)));

		await prisma.$transaction(async (tx) => {
			await tx.user.update({
				where: { id: user.id },
				data: {
					totpSecretEncrypted: encryptTotpSecret(secretBase32),
					totpEnabled: true,
					totpEnabledAt: new Date()
				}
			});
			await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
			await tx.recoveryCode.createMany({
				data: recoveryCodeHashes.map((codeHash) => ({ userId: user.id, codeHash }))
			});
		});

		return { totpEnableSuccess: true, recoveryCodes };
	},
	disableTotp: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const currentPassword = getFormValue(formData, 'currentPassword');
		const code = getFormValue(formData, 'code').trim();

		const invalid = () => fail(400, { totpDisableError: m.settings_mfa_error_disable_failed() });
		if (!currentPassword || !TOTP_CODE_PATTERN.test(code)) return invalid();

		const account = await prisma.user.findUnique({
			where: { id: user.id },
			select: { passwordHash: true, totpEnabled: true, totpSecretEncrypted: true }
		});
		if (!account || !account.totpEnabled || !account.totpSecretEncrypted) return invalid();

		const passwordOk = await verifyPassword(currentPassword, account.passwordHash);
		if (!passwordOk) return invalid();

		// A rotated/corrupted encryption key makes the GCM decryption fail (invalid auth
		// tag): treated as an invalid code rather than crashing the request.
		let codeOk: boolean;
		try {
			codeOk = verifyTotpCode(decryptTotpSecret(account.totpSecretEncrypted), code);
		} catch {
			codeOk = false;
		}
		if (!codeOk) return invalid();

		await prisma.$transaction(async (tx) => {
			await tx.user.update({
				where: { id: user.id },
				data: { totpEnabled: false, totpSecretEncrypted: null, totpEnabledAt: null }
			});
			await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
		});

		return { totpDisableSuccess: m.settings_mfa_success_disabled() };
	}
};

function detectRuntime(): 'docker' | 'local' {
	return existsSync('/.dockerenv') ? 'docker' : 'local';
}

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

function isUploadedFile(value: FormDataEntryValue | null): value is File {
	return (
		typeof value === 'object' &&
		value !== null &&
		'name' in value &&
		'size' in value &&
		'text' in value &&
		typeof value.name === 'string' &&
		typeof value.size === 'number' &&
		typeof value.text === 'function'
	);
}

function isPrismaUniqueError(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: string }).code === 'P2002'
	);
}
