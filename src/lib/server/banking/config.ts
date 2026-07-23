import { parseHostsCsv } from '$lib/server/hosts';

/**
 * Bank sync configuration gate. Mirrors the LLM gating pattern (LLM_ENABLED +
 * LLM_ALLOWED_HOSTS in insights/local-llm.ts): opt-in env flag, fail-safe default
 * (disabled), and a configurable host allowlist — never a hardcoded or
 * implicitly-inferred trusted URL.
 *
 * No route or network call consumes this yet (schema/infrastructure step only).
 */

// Official Enable Banking API host — the baseline allowlist, overridable (not extended)
// via BANK_SYNC_ALLOWED_HOSTS, exactly like LLM_ALLOWED_HOSTS overrides its baseline.
const DEFAULT_ALLOWED_HOSTS = ['api.enablebanking.com'];

export function isBankSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.BANK_SYNC_ENABLED === 'true';
}

function getAllowedHosts(env: NodeJS.ProcessEnv): string[] {
	const hosts = parseHostsCsv(env.BANK_SYNC_ALLOWED_HOSTS);
	return hosts.length > 0 ? hosts : DEFAULT_ALLOWED_HOSTS;
}

/**
 * Validates a bank provider base URL against the allowlist. Returns the normalized
 * base URL, or null when the host isn't allowlisted or the URL is invalid.
 *
 * Unlike the LLM validator there is NO http:// carve-out: bank credentials and
 * financial data only ever travel over https, localhost included (a mock/test
 * connector doesn't do network at all, so it never needs this).
 */
export function getBankProviderBaseUrl(
	value: string,
	env: NodeJS.ProcessEnv = process.env
): string | null {
	try {
		const url = new URL(value);
		if (!getAllowedHosts(env).includes(url.hostname)) return null;
		if (url.protocol !== 'https:') return null;
		url.pathname = url.pathname.replace(/\/+$/, '');
		url.search = '';
		url.hash = '';
		return url.toString().replace(/\/+$/, '');
	} catch {
		return null;
	}
}

/**
 * Path of the consent-callback route. Must match EXACTLY what is registered in the
 * provider's redirect-URL allowlist (Enable Banking rejects any deviation) — never
 * build the callback path anywhere else.
 */
export const BANK_SYNC_CALLBACK_PATH = '/imports/bank-connections/callback';

/**
 * Server-side redirect-URL allowlist (contract invariant: never rely solely on
 * provider-side registration). BANK_SYNC_REDIRECT_ALLOWED_ORIGINS is a CSV of full
 * origins (e.g. "http://localhost:5173,https://budget.example.com"). Fail-safe: when
 * unset, NO redirect URL is valid and a consent flow cannot start. The origin comes
 * from the incoming request (client-influenced Host header), hence the exact-match
 * validation rather than trusting it.
 *
 * Returns the full callback URL for `origin`, or null when the origin isn't allowlisted.
 */
export function getBankSyncRedirectUrl(
	origin: string,
	env: NodeJS.ProcessEnv = process.env
): string | null {
	const allowed = (env.BANK_SYNC_REDIRECT_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((entry) => normalizeOrigin(entry))
		.filter((entry): entry is string => entry !== null);
	const normalized = normalizeOrigin(origin);
	if (!normalized || !allowed.includes(normalized)) return null;
	return `${normalized}${BANK_SYNC_CALLBACK_PATH}`;
}

/** Parses a value into a canonical URL origin ("scheme://host[:port]"); null when invalid. */
function normalizeOrigin(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		return url.origin;
	} catch {
		return null;
	}
}
