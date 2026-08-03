// Shared constants for the e2e infra (playwright.config.ts, global-setup.ts, seed.ts).
// Single source of truth for the dedicated port/DB path so config, migration, and the seeded
// HTTP client all agree — never hardcode these values a second time elsewhere under e2e/.
import { existsSync, readFileSync } from 'node:fs';

// Distinct from 4173 (npm run preview default) and from 3000/5173 (dev) so the e2e suite can
// run alongside a local `npm run dev` without a port collision.
export const E2E_PORT = 4174;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

// Throwaway SQLite file, entirely recreated (deleted + re-migrated) on every run — see
// global-setup.ts. Never dev.db / prisma/dev.db.
export const E2E_DATABASE_URL = 'file:./e2e/.data/test.db';

/**
 * The single locale this suite runs in, for every channel that can carry one: the browser cookie
 * (e2e/fixtures.ts), the node-side message functions the selectors are built from (same file),
 * and the headers below. Anything that renders app copy must be pinned from THIS constant, or
 * the halves drift apart and the failure surfaces as a timeout on a locator, never as "wrong
 * language".
 */
export const E2E_LOCALE = 'fr';

/**
 * Headers for every `request.newContext()` in the seeds. Two unrelated reasons, both load-bearing:
 *
 * - `Origin`: SvelteKit's built-in CSRF check compares it against the request's own origin, and
 *   undici's fetch (used by APIRequestContext) does not add it for same-origin requests the way a
 *   browser would (same reason scripts/seed-dev.mjs sets it).
 * - `Accept-Language`: an APIRequestContext carries none of the browser fixture's cookies, so the
 *   app negotiates its locale from this header alone — and with no header at all it falls to the
 *   base locale, which is English. That bit for real: `seedTagFixture` probes for the "no results"
 *   copy to decide whether it has already run, comparing a FRENCH message function against an
 *   ENGLISH page. The probe never matched, the seed silently created nothing, and eight tags
 *   tests then failed on locators for rows that were never seeded. Pin it here rather than at
 *   each call site.
 */
export const E2E_API_HEADERS: Record<string, string> = {
	Origin: E2E_BASE_URL,
	'Accept-Language': E2E_LOCALE
};

/** Parses .env.test (dedicated fake secrets, never the real .env) into a plain object. */
function loadEnvTestFile(): Record<string, string> {
	const path = '.env.test';
	if (!existsSync(path)) return {};

	const result: Record<string, string> = {};
	for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return result;
}

// Env passed to both the webServer process and the `prisma migrate deploy` child process, so
// both agree on the same dedicated DATABASE_URL and the same (fake, test-only) secrets.
export const E2E_ENV: Record<string, string> = {
	...loadEnvTestFile(),
	DATABASE_URL: E2E_DATABASE_URL,
	NODE_ENV: 'production'
};
