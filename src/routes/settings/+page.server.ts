import { existsSync } from 'node:fs';
import { APP_VERSION } from '$lib/server/appVersion';
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
import { isReauthRateLimited, recordReauthAttempt } from '$lib/server/auth/rateLimit';
import { resolveClientAddress } from '$lib/server/net/clientAddress';
import { prisma } from '$lib/server/db';
import { BackupImportError, restoreBackup } from '$lib/server/backup/import';
import { backupExportSchema } from '$lib/server/backup/schema';
import { countJsonNodes, resolveBackupMaxJsonNodes } from '$lib/server/backup/parseBounds';
import {
	listTagsWithCounts,
	renameTag as renameTagService,
	recolorTag as recolorTagService,
	deleteTag as deleteTagService
} from '$lib/server/tags/service';
import { normalizeId } from '$lib/server/transactions/where';
import {
	deleteColumnMapping,
	listColumnMappings,
	resolveColumnMappingsPerUser
} from '$lib/server/import/mapping/store';
import { rememberedMappingView } from '$lib/domain/rememberedMapping';
import { accountListRows, invitationApplies } from '$lib/server/accounts/projection';
import {
	AccountWriteError,
	archiveStatementAccount,
	linkNetWorthAccount,
	MAX_ACCOUNT_NAME_LENGTH,
	renameStatementAccount,
	type AccountWriteRefusal
} from '$lib/server/accounts/service';
import { readLinkableNetWorthAccounts } from '$lib/server/net-worth/service';
import type { PageServerLoad } from './$types';

const TOTP_CODE_PATTERN = /^[0-9]{6}$/;

const BACKUP_MAX_BYTES = 20_000_000;

export const load: PageServerLoad = async ({ cookies, locals }) => {
	const user = requireUser(locals.user);
	const currentToken = cookies.get(SESSION_COOKIE);
	const currentTokenHash = currentToken ? hashSessionToken(currentToken) : null;

	const [account, sessions, tags, columnMappings, accountRows, linkableNetWorthAccounts] =
		await Promise.all([
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
			}),
			listTagsWithCounts(user.id),
			listColumnMappings(user.id),
			/**
			 * The Comptes section, read here and PROJECTED before it leaves the server.
			 *
			 * Archived rows are in the query on purpose: `accountsForList` keeps them and
			 * `accountsForPicker` drops them, and a screen that hid what it archived would leave the
			 * user no way to undo it. `netWorthAccount` is joined for the name alone, so the row can
			 * say which line it feeds without the page holding an id it would have to resolve.
			 */
			prisma.account.findMany({
				where: { userId: user.id },
				select: {
					id: true,
					name: true,
					nameKey: true,
					source: true,
					institution: true,
					discriminant: true,
					archivedAt: true,
					netWorthAccountId: true,
					netWorthAccount: { select: { name: true } },
					_count: { select: { transactions: true } }
				},
				orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }, { id: 'asc' }]
			}),
			readLinkableNetWorthAccounts(user.id)
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
			version: APP_VERSION,
			latestSessionCreatedAt: latestSession?.createdAt ?? null
		},
		sessions: mappedSessions,
		tags,
		// Shaped HERE rather than in the markup: whether a row can name its columns is a property
		// of the stored record, and a positional mapping has none to name. See
		// `domain/rememberedMapping.ts` for why that decision is not an `{#if}` in a template.
		columnMappings: columnMappings.map((mapping) =>
			rememberedMappingView({ ...mapping, importBatchCount: mapping._count.importBatches })
		),
		columnMappingCap: resolveColumnMappingsPerUser(),
		accounts: accountListRows(accountRows),
		// The invitation reads the SAME predicate the rows' `generic` flag does, so the sentence and
		// the rows it points at cannot disagree. Computed here rather than derived on the page from
		// `accounts.some((row) => row.generic)`, which would be a second expression of one rule.
		accountsInvitation: invitationApplies(accountRows),
		accountNameMaxLength: MAX_ACCOUNT_NAME_LENGTH,
		linkableNetWorthAccounts,
		aiSettings: {
			insightsEnabled: account.aiInsightsEnabled,
			includeLabels: account.aiIncludeLabels,
			llmGloballyEnabled: process.env.LLM_ENABLED === 'true'
		}
	};
};

export const actions: Actions = {
	changePassword: async ({ cookies, getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
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

		// This action re-verifies the current password, so it is a password-guessing oracle behind a
		// session: throttled by the shared re-auth limiter. See rateLimit.ts (isReauthRateLimited).
		if (await isReauthRateLimited(user.id, ip)) {
			return fail(400, { passwordError: m.settings_error_reauth_too_many() });
		}

		const account = await prisma.user.findUnique({
			where: { id: user.id },
			select: {
				passwordHash: true
			}
		});
		if (!account) throw redirect(303, '/login');

		const currentPasswordOk = await verifyPassword(currentPassword, account.passwordHash);
		if (!currentPasswordOk) {
			await recordReauthAttempt(user.id, ip);
			return fail(400, { passwordError: m.settings_error_password_update_failed() });
		}

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
	deleteAccount: async ({ cookies, getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
		const formData = await request.formData();
		const confirmation = getFormValue(formData, 'confirmation');
		const currentPassword = getFormValue(formData, 'currentPassword');
		const code = getFormValue(formData, 'code').trim();

		// The phrase confirms INTENT and is checked first, before the limiter and before any secret:
		// it is a fixed word, not a secret, so a mistyped phrase must never consume a re-auth attempt
		// (otherwise fumbling the confirmation would lock the owner out of their own delete). Compared
		// against the localised phrase (#203) so an English user types DELETE, not SUPPRIMER.
		if (confirmation !== m.settings_delete_confirmation_phrase()) {
			return fail(400, { deleteError: m.settings_error_confirmation_required() });
		}

		// The phrase confirms intent; the credential authenticates. Deleting an account is at least as
		// sensitive as disabling TOTP, so it re-verifies the password and, when TOTP is on, a valid
		// code, the same pair disableTotp requires. Throttled by the shared re-auth limiter so this
		// new password/TOTP check is not an uncounted brute-force oracle (rateLimit.ts).
		if (await isReauthRateLimited(user.id, ip)) {
			return fail(400, { deleteError: m.settings_error_reauth_too_many() });
		}

		const account = await prisma.user.findUnique({
			where: { id: user.id },
			select: { passwordHash: true, totpEnabled: true, totpSecretEncrypted: true }
		});
		if (!account) throw redirect(303, '/login');

		const passwordOk = await verifyPassword(currentPassword, account.passwordHash);
		const codeOk =
			account.totpEnabled && account.totpSecretEncrypted
				? TOTP_CODE_PATTERN.test(code) && verifyTotpCodeSafely(account.totpSecretEncrypted, code)
				: true;
		if (!passwordOk || !codeOk) {
			await recordReauthAttempt(user.id, ip);
			return fail(400, { deleteError: m.settings_error_delete_credentials() });
		}

		await prisma.$transaction(async (tx) => {
			await tx.session.deleteMany({
				where: { userId: user.id }
			});
			// Transactions BEFORE the user, and this ordering is load-bearing rather than tidy.
			//
			// Deleting the user cascades to both Category and Transaction, and the database picks
			// the order. TransactionSplit cascades from Transaction but is RESTRICT on Category —
			// deliberately, so deleting a category can never destroy money. If the engine happens
			// to cascade into Category first, that RESTRICT fires and the whole delete fails.
			//
			// Provider-divergent, which is what makes it dangerous: SQLite and MySQL happen to
			// reach Transaction first and succeed, PostgreSQL does not. Measured, not reasoned —
			// found when a db-smoke suite's cleanup failed on one engine of three with
			// `Foreign key constraint violated on the constraint: TransactionSplit_categoryId_fkey`.
			// Without this line a PostgreSQL user who has ever split a transaction cannot delete
			// their own account at all.
			await tx.transaction.deleteMany({ where: { userId: user.id } });
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

		// BEFORE `JSON.parse`, and the placement is the whole fix (#276). The byte cap above and the
		// schema below both bound something real and neither bounds this: 20 MB of `[{},{},...]`
		// passes the cap, costs 801 MB inside the parse, and is refused microseconds later for
		// having no `formatVersion`. Every byte is spent before the first check runs, so the bound
		// has to sit ahead of the parse. A linear scan, 28.5 ms on a 20 MB payload.
		const maxJsonNodes = resolveBackupMaxJsonNodes();
		const jsonNodes = countJsonNodes(rawText);
		if (jsonNodes > maxJsonNodes) {
			return fail(400, {
				restoreError: m.settings_error_restore_too_complex({ max: maxJsonNodes })
			});
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
	confirmTotpSetup: async ({ getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
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

		// Re-verifies the current password (and the freshly-scanned code), so it is throttled by the
		// shared re-auth limiter like the other three (rateLimit.ts).
		if (await isReauthRateLimited(user.id, ip)) {
			return invalid(m.settings_error_reauth_too_many());
		}

		const account = await prisma.user.findUnique({
			where: { id: user.id },
			select: { passwordHash: true }
		});
		if (!account) throw redirect(303, '/login');

		const passwordOk = await verifyPassword(currentPassword, account.passwordHash);
		if (!passwordOk) {
			await recordReauthAttempt(user.id, ip);
			return invalid(m.settings_mfa_error_setup_invalid_password());
		}

		if (!verifyTotpCode(secretBase32, code)) {
			await recordReauthAttempt(user.id, ip);
			return invalid();
		}

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
	disableTotp: async ({ getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
		const formData = await request.formData();
		const currentPassword = getFormValue(formData, 'currentPassword');
		const code = getFormValue(formData, 'code').trim();

		const invalid = () => fail(400, { totpDisableError: m.settings_mfa_error_disable_failed() });
		if (!currentPassword || !TOTP_CODE_PATTERN.test(code)) return invalid();

		// The sharpest of the four re-auth actions: it verifies the current password AND the current
		// TOTP code, so without a limiter the 6-digit second factor that protects the account could
		// itself be brute-forced off by anyone already holding a session. Throttled by the shared
		// re-auth limiter (rateLimit.ts).
		if (await isReauthRateLimited(user.id, ip)) {
			return fail(400, { totpDisableError: m.settings_error_reauth_too_many() });
		}

		const account = await prisma.user.findUnique({
			where: { id: user.id },
			select: { passwordHash: true, totpEnabled: true, totpSecretEncrypted: true }
		});
		if (!account || !account.totpEnabled || !account.totpSecretEncrypted) return invalid();

		const passwordOk = await verifyPassword(currentPassword, account.passwordHash);
		const codeOk = passwordOk && verifyTotpCodeSafely(account.totpSecretEncrypted, code);
		if (!passwordOk || !codeOk) {
			await recordReauthAttempt(user.id, ip);
			return invalid();
		}

		await prisma.$transaction(async (tx) => {
			await tx.user.update({
				where: { id: user.id },
				data: { totpEnabled: false, totpSecretEncrypted: null, totpEnabledAt: null }
			});
			await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
		});

		return { totpDisableSuccess: m.settings_mfa_success_disabled() };
	},
	// Tag creation deliberately has no action here: the design forbids it in Settings. A tag is
	// created only by typing a name on a transaction (see domain/tags.ts, resolveTagByName).
	renameTag: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));

		if (!id) return fail(400, { tagsError: m.tags_error_invalid() });

		const result = await renameTagService(user.id, id, getFormValue(formData, 'newName'));
		switch (result) {
			case 'ok':
				return { tagsSuccess: m.tags_success_renamed() };
			case 'duplicate':
				return fail(400, { tagsError: m.tags_error_duplicate() });
			case 'empty-name':
				return fail(400, { tagsError: m.tags_error_invalid_name() });
			case 'not-found':
				// Deliberately the SAME message and status whether the id never existed or belongs
				// to another user: the service's updateMany({ id, userId }) already collapses both
				// into one zero-count outcome, and this branch must not reintroduce a distinction it
				// refused to make. See the security section of the tags design spec.
				return fail(404, { tagsError: m.tags_error_not_found() });
		}
	},
	recolorTag: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));

		if (!id) return fail(400, { tagsError: m.tags_error_invalid() });

		// Unreachable from the UI, which only ever submits one of the eight palette swatches:
		// tested anyway, because the UI is not the enforcement. recolorTagService validates
		// against the closed token set before touching the database.
		const result = await recolorTagService(user.id, id, getFormValue(formData, 'colorToken'));
		switch (result) {
			case 'ok':
				return { tagsSuccess: m.tags_success_recolored() };
			case 'invalid-color':
				return fail(400, { tagsError: m.tags_error_invalid_color() });
			case 'not-found':
				// Same generic message as renameTag's not-found branch, for the same reason.
				return fail(404, { tagsError: m.tags_error_not_found() });
		}
	},
	deleteTag: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));

		if (!id) return fail(400, { tagsError: m.tags_error_invalid() });

		const result = await deleteTagService(user.id, id);
		if (result === 'not-found') {
			// Same generic message as renameTag's not-found branch, for the same reason.
			return fail(404, { tagsError: m.tags_error_not_found() });
		}

		return { tagsSuccess: m.tags_success_deleted() };
	},

	/**
	 * Forgets one remembered correspondance.
	 *
	 * The id arrives from the client and is authorised against the caller inside the statement
	 * (ASVS 5.0 V8.1.1) — see `deleteColumnMapping`, which filters on `(id, userId)` rather than
	 * looking the row up and checking afterwards.
	 *
	 * A row belonging to someone else answers `not-found`, identically to one that never existed,
	 * so the response is not an oracle for whether another user's id is real.
	 */
	/**
	 * The three account writes, each reading exactly the fields its form shows.
	 *
	 * MASS ASSIGNMENT IS THE CATEGORY AND A ONE-FIELD FORM IS WHERE NOBODY LOOKS FOR IT. Each action
	 * reads named keys off the submission and hands them to a service whose signature accepts
	 * nothing else, so `source`, `discriminant`, `netWorthAccountId` and `archivedAt` posted beside
	 * a rename have nowhere to arrive. That is an allow list expressed as three signatures rather
	 * than as a filter somebody has to keep complete.
	 *
	 * Every refusal is a 400 with a sentence, never a 5xx: `accountRefusal` maps the six reasons the
	 * service can produce, and anything else rethrows to the generic handler rather than being
	 * rendered as a guess.
	 */
	renameAccount: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));
		if (!id) return fail(400, { accountsError: m.accounts_error_not_found() });

		try {
			await renameStatementAccount({
				userId: user.id,
				accountId: id,
				name: getFormValue(formData, 'newName')
			});
		} catch (caught) {
			return accountRefusal(caught);
		}
		return { accountsSuccess: m.accounts_success_renamed() };
	},

	archiveAccount: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));
		if (!id) return fail(400, { accountsError: m.accounts_error_not_found() });

		// Positive: only the literal 'false' reactivates. An absent field archives, which is the
		// direction a hand-crafted request must not be able to obtain by omission — same reading
		// `does NOT consent to the delete when the answer is absent` makes for the import consent.
		const archived = getFormValue(formData, 'archived') !== 'false';
		try {
			await archiveStatementAccount({ userId: user.id, accountId: id, archived });
		} catch (caught) {
			return accountRefusal(caught);
		}
		return {
			accountsSuccess: archived ? m.accounts_success_archived() : m.accounts_success_unarchived()
		};
	},

	linkAccountNetWorth: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));
		if (!id) return fail(400, { accountsError: m.accounts_error_not_found() });

		// An empty selection means « aucun » and clears the link. Normalised to null HERE so the
		// service never has to decide what an empty string means about an object reference.
		const target = normalizeId(getFormValue(formData, 'netWorthAccountId'));
		try {
			await linkNetWorthAccount({
				userId: user.id,
				accountId: id,
				netWorthAccountId: target || null
			});
		} catch (caught) {
			return accountRefusal(caught);
		}
		return { accountsSuccess: m.accounts_success_linked() };
	},

	deleteColumnMapping: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));

		if (!id) return fail(400, { columnMappingError: m.settings_mappings_error_invalid() });

		const result = await deleteColumnMapping(user.id, id);
		if (result === 'not-found') {
			return fail(404, { columnMappingError: m.settings_mappings_error_not_found() });
		}

		return { columnMappingSuccess: m.settings_mappings_success_deleted() };
	}
};

function detectRuntime(): 'docker' | 'local' {
	return existsSync('/.dockerenv') ? 'docker' : 'local';
}

// A rotated/corrupted encryption key makes the GCM decryption fail (invalid auth tag): treated as
// an invalid code rather than letting the request crash with a 500. Shared by disableTotp and
// deleteAccount, which both verify the stored (encrypted) secret.
function verifyTotpCodeSafely(secretEncrypted: string, code: string): boolean {
	try {
		return verifyTotpCode(decryptTotpSecret(secretEncrypted), code);
	} catch {
		return false;
	}
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

/**
 * One sentence per refusal an account write can produce, and a rethrow for anything else.
 *
 * Exhaustive over `AccountWriteRefusal` on purpose: a `switch` the compiler checks is what stops a
 * seventh reason being added to the service and silently rendering somebody else's sentence. That
 * is the defect the create endpoint's catch-all `return` had, found while widening this union.
 *
 * Nothing here is a 5xx. The last audit drove 49 actions through two hostile passes with zero, and
 * a refusal a user can read is the whole difference between a rule and a crash.
 */
function accountRefusal(caught: unknown) {
	if (!(caught instanceof AccountWriteError)) throw caught;
	return fail(400, { accountsError: accountRefusalSentence(caught.reason) });
}

function accountRefusalSentence(reason: AccountWriteRefusal): string {
	switch (reason) {
		case 'name-required':
			return m.accounts_error_name_required();
		case 'name-taken':
			return m.accounts_error_name_taken();
		case 'name-too-long':
			return m.accounts_error_name_too_long({ max: MAX_ACCOUNT_NAME_LENGTH });
		case 'net-worth-not-found':
			return m.accounts_error_net_worth_not_found();
		// #501, and it borrows the net worth catalogue's sentence rather than adding a twin to this
		// one, the same way `discriminant-taken` below borrows the import sheet's. D4 is ONE rule and
		// /imports/bank-connections already refuses in these words: a second string saying the same
		// thing is a second thing to keep true. The switch stays exhaustive on purpose, so a refusal
		// added to `AccountWriteRefusal` is a compile error here until a sentence exists for it
		// rather than a wrong sentence chosen by a default branch.
		case 'net-worth-already-synced':
			return m.net_worth_error_already_synced();
		case 'not-found':
			return m.accounts_error_not_found();
		// A fragment collision is unreachable from these three forms: none of them carries a
		// discriminant and no service they call sets one. Named rather than folded into a default,
		// so adding a form that DOES would be a compile error here rather than a wrong sentence.
		case 'discriminant-taken':
			return m.import_account_create_error_fragment_taken();
	}
}
