/**
 * Shared helpers for configurable host allowlists (LLM_ALLOWED_HOSTS,
 * BANK_SYNC_ALLOWED_HOSTS, ...). An allowlist env var is a comma-separated list of
 * hostnames; parsing and IPv6 normalization must behave identically everywhere.
 */

/** URL#hostname wraps IPv6 addresses in brackets; align bare entries (e.g. "::1" → "[::1]"). */
export function normalizeHostEntry(host: string): string {
	if (!host || host.startsWith('[')) return host;
	return host.includes(':') ? `[${host}]` : host;
}

/** Parses a comma-separated host list; returns [] for an absent/blank value. */
export function parseHostsCsv(raw: string | undefined): string[] {
	const trimmed = raw?.trim();
	if (!trimmed) return [];
	return trimmed
		.split(',')
		.map((host) => normalizeHostEntry(host.trim()))
		.filter(Boolean);
}
