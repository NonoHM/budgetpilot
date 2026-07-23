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
