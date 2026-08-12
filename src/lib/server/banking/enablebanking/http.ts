import { getBankProviderBaseUrl, isBankSyncEnabled } from '$lib/server/banking/config';
import { fetchWithRedirectGuard } from '$lib/server/net/redirectGuard';
import { createEnableBankingJwt, getEnableBankingCredentials } from './jwt';

/**
 * Gated HTTP client for the Enable Banking API. This is the ONLY code path allowed
 * to reach the provider: every request re-checks isBankSyncEnabled() and validates
 * the base URL through the BANK_SYNC_ALLOWED_HOSTS allowlist (https-only) — there is
 * no bypass, so disabling the flag structurally prevents any network call.
 *
 * Error discipline: thrown errors carry the HTTP status and, when the provider
 * returns one, its machine-readable error code — NEVER the raw response body, query
 * params or headers (they can echo authorization codes, IBANs or transaction data).
 */

const DEFAULT_BASE_URL = 'https://api.enablebanking.com';

export class EnableBankingApiError extends Error {
	constructor(
		readonly status: number,
		/** Provider's machine-readable error code when present (e.g. ASPSP_RATE_LIMIT_EXCEEDED). */
		readonly providerCode: string | null,
		message: string
	) {
		super(message);
		this.name = 'EnableBankingApiError';
	}
}

export interface EnableBankingHttpOptions {
	env?: NodeJS.ProcessEnv;
	/** Injectable for tests — the automated suite never performs a real network call. */
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

export interface EnableBankingRequestInput {
	method?: 'GET' | 'POST';
	path: string;
	query?: Record<string, string | undefined>;
	body?: unknown;
}

/** Performs one authenticated API request and returns the parsed JSON body. */
export async function enableBankingRequest(
	input: EnableBankingRequestInput,
	options: EnableBankingHttpOptions = {}
): Promise<unknown> {
	const env = options.env ?? process.env;
	if (!isBankSyncEnabled(env)) {
		throw new Error('Bank sync is disabled (BANK_SYNC_ENABLED)');
	}

	const baseUrl = getBankProviderBaseUrl(env.ENABLE_BANKING_BASE_URL || DEFAULT_BASE_URL, env);
	if (!baseUrl) {
		throw new Error('Enable Banking base URL is not allowlisted (BANK_SYNC_ALLOWED_HOSTS)');
	}

	const credentials = getEnableBankingCredentials(env);
	if (!credentials) {
		throw new Error(
			'Enable Banking credentials are not configured: set ENABLE_BANKING_APP_ID plus ENABLE_BANKING_PRIVATE_KEY or ENABLE_BANKING_PRIVATE_KEY_PATH'
		);
	}

	const url = new URL(`${baseUrl}${input.path}`);
	for (const [key, value] of Object.entries(input.query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, value);
	}

	const token = await createEnableBankingJwt(credentials, options.now?.() ?? new Date());
	const fetchImpl = options.fetchImpl ?? fetch;
	// #215: do not blind-follow redirects. Every redirect target is re-validated against the SAME
	// allowlist as the base URL (getBankProviderBaseUrl), so a compromised/MITM'd provider cannot
	// bounce this authenticated fetch to an internal host. A non-allowlisted target throws.
	const response = await fetchWithRedirectGuard(
		url.toString(),
		{
			method: input.method ?? 'GET',
			headers: {
				Authorization: `Bearer ${token}`,
				...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
				Accept: 'application/json'
			},
			...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {})
		},
		{
			fetchImpl,
			isRedirectTargetAllowed: (target) => getBankProviderBaseUrl(target.href, env) !== null
		}
	);

	if (!response.ok) {
		throw new EnableBankingApiError(
			response.status,
			await readProviderErrorCode(response),
			`Enable Banking API error (status ${response.status})`
		);
	}

	try {
		return await response.json();
	} catch {
		throw new EnableBankingApiError(
			response.status,
			null,
			'Enable Banking API returned invalid JSON'
		);
	}
}

/** Extracts only the provider's error `code` field — never the message or full body. */
async function readProviderErrorCode(response: Response): Promise<string | null> {
	try {
		const body: unknown = await response.json();
		if (
			typeof body === 'object' &&
			body !== null &&
			'code' in body &&
			typeof (body as { code?: unknown }).code === 'string'
		) {
			return (body as { code: string }).code;
		}
		return null;
	} catch {
		return null;
	}
}
