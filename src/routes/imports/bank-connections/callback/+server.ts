import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireUser } from '$lib/server/auth';
import { BankSyncError, completeBankAuthorization } from '$lib/server/banking/sync/service';
import type { RequestHandler } from './$types';

/**
 * Consent-flow callback — the EXACT path registered in the provider's redirect-URL
 * allowlist (see BANK_SYNC_CALLBACK_PATH); Enable Banking rejects any deviation.
 *
 * The query params carry SECRET material (the authorization `code`): they are handed
 * to the sync service verbatim and NEVER logged, and every outcome redirects with a
 * machine code only — no param ever survives into the target URL.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireUser(locals.user);

	const params: Record<string, string> = {};
	for (const [key, value] of url.searchParams) params[key] = value;

	// Provider-side denial/cancellation (e.g. the user aborted at the bank).
	if (params.error && !params.code) {
		redirect(303, '/imports/bank-connections?error=cancelled');
	}

	let failureCode: string | null = null;
	try {
		// $env/dynamic/private, not process.env: under `vite dev` only the former sees .env.
		await completeBankAuthorization({ userId: user.id, params }, { env });
	} catch (caught) {
		failureCode = caught instanceof BankSyncError ? caught.code : 'failed';
	}

	if (failureCode) {
		redirect(303, `/imports/bank-connections?error=${encodeURIComponent(failureCode)}`);
	}
	redirect(303, '/imports/bank-connections?connected=1');
};
