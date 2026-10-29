/** Parses a value into a canonical URL origin ("scheme://host[:port]"); null when invalid. */
export function normalizeOrigin(value: string): string | null {
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

/**
 * The origin a link the app hands out is built on (#1147): ORIGIN, never the request. With ORIGIN
 * unset adapter-node takes `request.url` from the Host header, so a link built on it names whatever
 * host the client sent. SvelteKit 3 drops the adapter's runtime ORIGIN (#1148); this stays the one
 * place that reads it for links.
 */
export function configuredOrigin(env: Record<string, string | undefined>): string | null {
	return normalizeOrigin(env.ORIGIN ?? '');
}
