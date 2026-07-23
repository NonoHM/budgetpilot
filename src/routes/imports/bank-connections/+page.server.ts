import { fail, isHttpError, redirect, type Actions } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { isBankSyncEnabled } from '$lib/server/banking/config';
import {
	BankSyncError,
	deleteBankConnection,
	listBankAspsps,
	listUserBankConnections,
	startBankAuthorization,
	syncBankConnection
} from '$lib/server/banking/sync/service';
import {
	createNetWorthAccount,
	linkBankAccountToNetWorth,
	readLinkableNetWorthAccounts
} from '$lib/server/net-worth/service';
import { isBankSyncStartRateLimited, recordBankSyncStartAttempt } from '$lib/server/auth/rateLimit';
import { normalizeId } from '$lib/server/transactions/where';
import type { PageServerLoad } from './$types';

/** The only provider exposed in the UI (the mock connector stays test/demo-only). */
const PROVIDER = 'enablebanking';
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
const DEFAULT_COUNTRY = 'FR';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	// $env/dynamic/private, not process.env: under `vite dev` only the former sees .env.
	const enabled = isBankSyncEnabled(env);

	const countryParam = url.searchParams.get('country') ?? '';
	const country = COUNTRY_PATTERN.test(countryParam) ? countryParam.toUpperCase() : DEFAULT_COUNTRY;

	const [connections, linkableNetWorthAccounts] = await Promise.all([
		listUserBankConnections(user.id),
		readLinkableNetWorthAccounts(user.id)
	]);

	// Provider-supplied bank list for the connect form; unavailable ≠ empty (the form
	// must not silently offer nothing when the provider call fails).
	let banks: string[] | null = null;
	if (enabled) {
		try {
			banks = (await listBankAspsps(PROVIDER, country, { env })).map((bank) => bank.name);
		} catch {
			banks = null;
		}
	}

	return {
		enabled,
		country,
		connections,
		linkableNetWorthAccounts,
		banks,
		connected: url.searchParams.get('connected') === '1',
		errorMessage: mapCallbackError(url.searchParams.get('error'))
	};
};

export const actions: Actions = {
	start: async ({ locals, request, url, getClientAddress }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const bank = getFormValue(formData, 'bank');
		const countryValue = getFormValue(formData, 'country');
		if (!bank || bank.length > 200 || !COUNTRY_PATTERN.test(countryValue)) {
			return fail(400, { error: m.bank_connections_error_generic() });
		}

		const ip = getClientAddress();
		if (await isBankSyncStartRateLimited(user.id, ip)) {
			return fail(429, { error: m.bank_connections_error_too_many_attempts() });
		}
		await recordBankSyncStartAttempt(user.id, ip);

		let authorizationUrl: string;
		try {
			const started = await startBankAuthorization(
				{
					userId: user.id,
					provider: PROVIDER,
					aspspName: bank,
					aspspCountry: countryValue.toUpperCase(),
					origin: url.origin
				},
				{ env }
			);
			authorizationUrl = started.authorizationUrl;
		} catch (caught) {
			return fail(400, { error: mapBankSyncError(caught) });
		}
		// Outside the try block: a thrown redirect must never be swallowed by the catch.
		redirect(303, authorizationUrl);
	},

	renew: async ({ locals, request, url, getClientAddress }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const connectionId = normalizeId(getFormValue(formData, 'connectionId'));
		if (!connectionId) return fail(400, { error: m.bank_connections_error_generic() });

		const ip = getClientAddress();
		if (await isBankSyncStartRateLimited(user.id, ip)) {
			return fail(429, { error: m.bank_connections_error_too_many_attempts() });
		}
		await recordBankSyncStartAttempt(user.id, ip);

		let authorizationUrl: string;
		try {
			const started = await startBankAuthorization(
				{
					userId: user.id,
					provider: PROVIDER,
					// Ignored in renewal mode — the bank comes from the stored connection.
					aspspName: '',
					aspspCountry: '',
					origin: url.origin,
					renewConnectionId: connectionId
				},
				{ env }
			);
			authorizationUrl = started.authorizationUrl;
		} catch (caught) {
			return fail(400, { error: mapBankSyncError(caught) });
		}
		// Outside the try block: a thrown redirect must never be swallowed by the catch.
		redirect(303, authorizationUrl);
	},

	sync: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const connectionId = normalizeId(getFormValue(formData, 'connectionId'));
		if (!connectionId) return fail(400, { error: m.bank_connections_error_generic() });

		try {
			// force stays false even for this user-initiated action: the 6h throttle is the
			// PSD2 unattended-call budget (~4/day) and the primary protection of it.
			const result = await syncBankConnection({ userId: user.id, connectionId }, { env });
			switch (result.outcome) {
				case 'synced':
					return {
						success: m.bank_connections_sync_success({
							imported: String(result.importedRows),
							duplicates: String(result.duplicateRows)
						})
					};
				case 'throttled':
					// Informational, not an error: the 6h PSD2 throttle is expected behavior.
					return fail(429, { warning: m.bank_connections_sync_throttled() });
				case 'consent_expired':
					return fail(409, { error: m.bank_connections_sync_consent_expired() });
				case 'unavailable':
					return fail(409, { error: m.bank_connections_sync_unavailable() });
				case 'error':
					return fail(502, { error: m.bank_connections_sync_error() });
			}
		} catch (caught) {
			return fail(400, { error: mapBankSyncError(caught) });
		}
	},

	delete: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const connectionId = normalizeId(getFormValue(formData, 'connectionId'));
		if (!connectionId) return fail(400, { error: m.bank_connections_error_generic() });

		const deleted = await deleteBankConnection(user.id, connectionId);
		if (!deleted) return fail(404, { error: m.bank_connections_error_generic() });
		return { success: m.bank_connections_deleted_success() };
	},

	/**
	 * Explicit net worth link for one bank-sync bucket — server foundation only, no UI yet
	 * (bank-sync step "net worth link", points 1-3). Three modes, never automatic:
	 * - `existing`: link to an already-owned, linkable NetWorthAccount (netWorthAccountId).
	 * - `create`: create a new NetWorthAccount (same fields as /net-worth's form) then link it.
	 * - `none`: clear the bucket's link.
	 * All ownership/type/D4 (no two synced buckets on one NetWorthAccount) validation lives
	 * in linkBankAccountToNetWorth — this action only parses the form and delegates.
	 */
	linkAccount: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const accountId = normalizeId(getFormValue(formData, 'accountId'));
		if (!accountId) return fail(400, { error: m.bank_connections_error_generic() });

		const mode = getFormValue(formData, 'mode');
		try {
			if (mode === 'none') {
				await linkBankAccountToNetWorth(user.id, accountId, null);
			} else if (mode === 'existing') {
				const netWorthAccountId = normalizeId(getFormValue(formData, 'netWorthAccountId'));
				if (!netWorthAccountId) return fail(400, { error: m.bank_connections_error_generic() });
				await linkBankAccountToNetWorth(user.id, accountId, netWorthAccountId);
			} else if (mode === 'create') {
				const created = await createNetWorthAccount(user.id, {
					name: getFormValue(formData, 'name'),
					type: getFormValue(formData, 'type'),
					balance: getFormValue(formData, 'balance'),
					asOfDate: getFormValue(formData, 'asOfDate') || undefined
				});
				await linkBankAccountToNetWorth(user.id, accountId, created.id);
			} else {
				return fail(400, { error: m.bank_connections_error_generic() });
			}
		} catch (caught) {
			const status = isHttpError(caught) ? caught.status : 400;
			const message = isHttpError(caught)
				? caught.body.message
				: m.bank_connections_error_generic();
			return fail(status, { error: message });
		}

		return { success: m.net_worth_success_updated() };
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

function mapBankSyncError(caught: unknown): string {
	if (!(caught instanceof BankSyncError)) return m.bank_connections_error_generic();
	switch (caught.code) {
		case 'disabled':
			return m.bank_connections_disabled_notice();
		case 'redirect_not_allowed':
			return m.bank_connections_error_redirect();
		case 'unknown_bank':
			return m.bank_connections_error_unknown_bank();
		case 'invalid_state':
		case 'authorization_failed':
			return m.bank_connections_error_authorization();
		default:
			return m.bank_connections_error_generic();
	}
}

/** Maps the callback's machine error code (query param) to a display message. */
function mapCallbackError(code: string | null): string | null {
	if (!code) return null;
	switch (code) {
		case 'cancelled':
			return m.bank_connections_error_cancelled();
		case 'invalid_state':
		case 'authorization_failed':
			return m.bank_connections_error_authorization();
		case 'disabled':
			return m.bank_connections_disabled_notice();
		default:
			return m.bank_connections_error_generic();
	}
}
