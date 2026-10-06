import { existsSync } from 'node:fs';
import { APP_VERSION } from '$lib/server/appVersion';
import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	clearSessionCookie,
	commitEndingSession,
	commitWithRotatedToken,
	hashPassword,
	requireUser,
	revokeSessionsOtherThan
} from '$lib/server/auth';
import {
	buildTotpUri,
	encryptTotpSecret,
	generateRecoveryCodes,
	generateTotpQrCodeDataUrl,
	generateTotpSecretBase32,
	hashRecoveryCode
} from '$lib/server/auth/totp';
import { reauthenticate, reauthRefusalMessage } from '$lib/server/auth/reauth';
import { resolveClientAddress } from '$lib/server/net/clientAddress';
import { prisma } from '$lib/server/db';
import { BackupImportError, restoreBackup } from '$lib/server/backup/import';
import {
	backupExportSchema,
	restoreRefusal,
	type RestoreDateKind
} from '$lib/server/backup/schema';
import { STORABLE_YEAR_BOUNDS } from '$lib/i18n/refusalLabel';
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
import { forgetRememberedAccount, listRememberedAccounts } from '$lib/server/import/accountMemory';
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

const BACKUP_MAX_BYTES = 20_000_000;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);

	const [
		account,
		sessions,
		tags,
		columnMappings,
		rememberedAccounts,
		accountRows,
		linkableNetWorthAccounts
	] = await Promise.all([
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
				createdAt: true,
				expiresAt: true,
				revokedAt: true
			},
			orderBy: { createdAt: 'desc' }
		}),
		listTagsWithCounts(user.id),
		listColumnMappings(user.id),
		// « Comptes mémorisés » (#599): the owner's condition that a remembered answer is
		// VISIBLE and REVOCABLE. Scoped by `user.id` in the query itself.
		listRememberedAccounts(user.id),
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
		// By the row the hook resolved, never by the cookie: a re-authentication earlier in this same
		// request has rotated the token, and the hash the browser presented matches no row any more.
		isCurrent: session.id === user.sessionId,
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
		rememberedAccounts,
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
		const newPassword = getFormValue(formData, 'newPassword');
		const confirmPassword = getFormValue(formData, 'confirmPassword');

		// The NEW password's shape is the person's own input (#854 class 1), so it is refused before
		// any secret is read and without consuming a re-authentication attempt.
		if (!newPassword || !confirmPassword) {
			return fail(400, { passwordError: m.settings_error_password_update_failed() });
		}

		if (newPassword !== confirmPassword || newPassword.length < 12 || newPassword.length > 256) {
			return fail(400, { passwordError: m.settings_error_password_update_failed() });
		}

		// R3 on #841: password, plus TOTP when enabled (7.5.1). It checked the password only before.
		const reauth = await reauthenticate('changePassword', { user, ip, form: formData });
		if (!reauth.ok) return fail(400, { passwordError: reauthRefusalMessage(reauth) });

		const newPasswordHash = await hashPassword(newPassword);

		// R3 on #841: every session but this one is revoked, and this one's token is replaced in the
		// same commit (#249), so no token that existed before the new password outlives it.
		await commitWithRotatedToken(user, cookies, async (tx) => {
			await tx.user.update({
				where: { id: user.id },
				data: {
					passwordHash: newPasswordHash
				}
			});

			await revokeSessionsOtherThan(tx, user);
		});

		return {
			passwordSuccess: m.settings_success_password_updated()
		};
	},
	// #253, R3 on #841: one factor (7.5.2). Without it, a stolen cookie could evict the owner from
	// every other device, and the control the owner would reach for is the one that removed them.
	revokeOtherSessions: async ({ cookies, getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
		const formData = await request.formData();

		const reauth = await reauthenticate('revokeOtherSessions', {
			user,
			ip,
			form: formData
		});
		if (!reauth.ok) return fail(400, { sessionsError: reauthRefusalMessage(reauth) });

		await commitWithRotatedToken(user, cookies, (tx) => revokeSessionsOtherThan(tx, user));

		return {
			sessionsSuccess: m.settings_success_sessions_revoked()
		};
	},
	revokeSession: async ({ cookies, getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
		const formData = await request.formData();
		const sessionId = getFormValue(formData, 'sessionId');

		if (!sessionId) {
			return fail(400, { sessionsError: m.settings_error_session_revoke_failed() });
		}

		// Before the lookup, so a caller who has not re-authenticated learns nothing about which
		// session ids exist (#253, R3 on #841: one factor, 7.5.2).
		const reauth = await reauthenticate('revokeSession', { user, ip, form: formData });
		if (!reauth.ok) return fail(400, { sessionsError: reauthRefusalMessage(reauth) });

		// `userId` IN the where clause (R6 on #841, the revokeSession half of #830): another account's
		// session id resolves to nothing, exactly like one that does not exist. Asserted against a real
		// engine in `reauth.db-smoke.ts`.
		const target = await prisma.session.findFirst({
			where: { id: sessionId, userId: user.id },
			select: { id: true }
		});
		if (!target) {
			return fail(404, { sessionsError: m.settings_error_session_revoke_failed() });
		}
		if (target.id === user.sessionId) {
			return fail(400, { sessionsError: m.settings_error_session_revoke_current() });
		}

		await commitWithRotatedToken(user, cookies, (tx) =>
			tx.session.updateMany({
				where: { id: sessionId, userId: user.id, revokedAt: null },
				data: { revokedAt: new Date() }
			})
		);

		return {
			sessionsSuccess: m.settings_success_session_revoked()
		};
	},
	deleteAccount: async ({ cookies, getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
		const formData = await request.formData();
		const confirmation = getFormValue(formData, 'confirmation');

		// The phrase confirms INTENT and is checked first, before the limiter and before any secret:
		// it is a fixed word, not a secret, so a mistyped phrase must never consume a re-auth attempt
		// (otherwise fumbling the confirmation would lock the owner out of their own delete). Compared
		// against the localised phrase (#203) so an English user types DELETE, not SUPPRIMER.
		if (confirmation !== m.settings_delete_confirmation_phrase()) {
			return fail(400, { deleteError: m.settings_error_confirmation_required() });
		}

		// The phrase confirms intent; the credential authenticates (R3 on #841: password, plus TOTP
		// when enabled, 7.5.1).
		const reauth = await reauthenticate('deleteAccount', { user, ip, form: formData });
		if (!reauth.ok) return fail(400, { deleteError: reauthRefusalMessage(reauth) });

		// The session is claimed first and deleted with the rest (#249): one that ended before the
		// claim deletes nothing.
		await commitEndingSession(user, cookies, async (tx) => {
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
	restoreData: async ({ cookies, getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
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

		// #228: a restore replaces every record the account owns, as destructive as deleteAccount, so
		// it asks what deleteAccount asks. Placed BEFORE the file is read, counted and parsed: a caller
		// who has not re-authenticated spends none of that work and learns nothing about the file.
		const reauth = await reauthenticate('restoreData', { user, ip, form: formData });
		if (!reauth.ok) return fail(400, { restoreError: reauthRefusalMessage(reauth) });

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
			// #758: a date no engine stores faithfully is not corruption. An install on SQLite
			// accepted such a row before the import parser refused it, and exported it faithfully;
			// the sentence names the kinds of record to look in.
			const refusal = restoreRefusal(parsed.error);
			return fail(400, {
				restoreError:
					refusal.reason === 'date-out-of-range'
						? m.settings_error_restore_date_out_of_range({
								...STORABLE_YEAR_BOUNDS,
								kinds: restoreDateKindsSentence(refusal.kinds)
							})
						: m.settings_error_restore_corrupted()
			});
		}

		try {
			// The restore and the new session token commit together (#249). A refusal above, about the
			// file, changes nothing, the token included.
			await restoreBackup(user.id, parsed.data, (change, options) =>
				commitWithRotatedToken(user, cookies, change, options)
			);
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
	confirmTotpSetup: async ({ cookies, getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
		const formData = await request.formData();
		const secretBase32 = getFormValue(formData, 'secretBase32');

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
		if (!secretBase32) return invalid();

		// R3 on #841: the password, plus a code from the secret being enrolled (7.5.1). A wrong
		// password and a wrong code now read alike (#854 class 2), where they used to differ.
		const reauth = await reauthenticate('confirmTotpSetup', {
			user,
			ip,
			form: formData,
			newTotpSecret: secretBase32
		});
		if (!reauth.ok) return invalid(reauthRefusalMessage(reauth));

		const recoveryCodes = generateRecoveryCodes();
		const recoveryCodeHashes = await Promise.all(recoveryCodes.map((c) => hashRecoveryCode(c)));

		await commitWithRotatedToken(user, cookies, async (tx) => {
			await tx.user.update({
				where: { id: user.id },
				data: {
					totpSecretEncrypted: encryptTotpSecret(secretBase32),
					totpEnabled: true,
					totpEnabledAt: new Date(),
					// The confirming code is the first one spent (#818), written with the secret it is a
					// step of, so the code typed here, which someone may have watched, cannot then sign
					// in. Not at re-authentication: see `judgeEnrolmentCode`.
					totpLastUsedStep: reauth.totpStep
				}
			});
			await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
			await tx.recoveryCode.createMany({
				data: recoveryCodeHashes.map((codeHash) => ({ userId: user.id, codeHash }))
			});
		});

		return { totpEnableSuccess: true, recoveryCodes };
	},
	disableTotp: async ({ cookies, getClientAddress, locals, request }) => {
		const user = requireUser(locals.user);
		const ip = resolveClientAddress({ getClientAddress, request });
		const formData = await request.formData();

		// R3 on #841: password plus TOTP, and the account must have a second factor to disable. The
		// limiter matters most here: without it the six-digit code protecting the account could itself
		// be guessed off by anyone holding a session.
		const reauth = await reauthenticate('disableTotp', { user, ip, form: formData });
		if (!reauth.ok) return fail(400, { totpDisableError: reauthRefusalMessage(reauth) });

		await commitWithRotatedToken(user, cookies, async (tx) => {
			await tx.user.update({
				where: { id: user.id },
				// The last accepted step goes with the secret it was a step of (#818): kept, a new
				// secret enrolled within the same 30 seconds would have its first code refused as used.
				data: {
					totpEnabled: false,
					totpSecretEncrypted: null,
					totpEnabledAt: null,
					totpLastUsedStep: null
				}
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
	},

	/**
	 * « Oublier » on a remembered account (#599). A POST form action, so SvelteKit's origin check
	 * refuses it from another site (ASVS v5.0.0-3.5.1, v5.0.0-3.5.3).
	 *
	 * The posted id is a claim: `forgetRememberedAccount` deletes with `userId` in the same where
	 * clause, and another user's id, an unknown id and a malformed one are the same « introuvable »
	 * answer, so the response says nothing about ids the caller does not own (ASVS v5.0.0-8.2.2).
	 */
	forgetRememberedAccount: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const id = normalizeId(getFormValue(formData, 'id'));
		const result = id ? await forgetRememberedAccount(user.id, id) : 'not-found';
		if (result === 'not-found') {
			return fail(404, {
				rememberedAccountError: m.settings_remembered_accounts_error_not_found()
			});
		}
		return { rememberedAccountSuccess: m.settings_remembered_accounts_success_forgotten() };
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

/**
 * A kind of record a restore refusal names (#758). Dedicated keys rather than the navigation's
 * labels, which were capitalised as headings and, in English, did not name the record (« Upcoming »):
 * these sit mid-sentence inside a parenthesis, lower case in both locales. A switch with no default
 * arm, so a kind added to `RESTORE_DATE_KINDS` fails to compile until it is named here.
 */
function restoreDateKindLabel(kind: RestoreDateKind): string {
	switch (kind) {
		case 'exportedAt':
			return m.settings_restore_kind_export_date();
		case 'bankConnections':
			return m.settings_restore_kind_bank_connections();
		case 'importBatches':
			return m.settings_restore_kind_imports();
		case 'transactions':
			return m.settings_restore_kind_transactions();
		// Two kinds, one word for the reader: a net worth line and its snapshots are both patrimoine.
		case 'netWorthAccounts':
		case 'netWorthSnapshots':
			return m.settings_restore_kind_net_worth();
		case 'savingsGoals':
			return m.settings_restore_kind_savings_goals();
		case 'recurringStreamActions':
			return m.settings_restore_kind_upcoming_bills();
	}
}

/** The kinds at fault as the sentence lists them: labelled, then each label once, in file order. */
function restoreDateKindsSentence(kinds: readonly RestoreDateKind[]): string {
	return [...new Set(kinds.map(restoreDateKindLabel))].join(', ');
}
