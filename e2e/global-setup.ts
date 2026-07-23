// Playwright globalSetup: runs once before the test suite. Responsible for fully recreating an
// isolated, throwaway SQLite DB, migrating it, waiting for the webServer, and seeding a minimal
// dataset + storageState via real HTTP routes. NEVER touches dev.db / prisma/dev.db — this is a
// dedicated file under e2e/.data/, entirely separate from local dev data (see e2e/config.ts).
//
// Ordering note (verified empirically, see PR description / commit message): Playwright starts
// the `webServer` process and waits for it to be reachable BEFORE invoking globalSetup — so this
// function always runs after the webServer process has been spawned. Because our webServer's
// readiness check is configured with `port` (not `url`), it's a bare TCP connect, not a real HTTP
// request — it never invokes a SvelteKit route handler, so the app never touches the (about to
// be deleted) DB file before step 1 below runs. This function's own HTTP polling (step 3) is the
// first *real* request the app receives, and it only happens once migration (step 2) is done.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { E2E_BASE_URL, E2E_ENV } from './config';
import { seedE2eData } from './seed';

const DB_DIR = path.resolve('e2e/.data');
const AUTH_DIR = path.resolve('e2e/.auth');
const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'user.json');

export default async function globalSetup(): Promise<void> {
	// 1. Isolation model: full recreation (delete + re-migrate) on every run, not a per-test
	// reset. Simpler and fast enough for a smoke-test-sized suite; per-test isolation is a
	// separate, out-of-scope decision if the suite grows.
	rmSync(DB_DIR, { recursive: true, force: true });
	mkdirSync(DB_DIR, { recursive: true });
	mkdirSync(AUTH_DIR, { recursive: true });

	// 2. Apply existing migrations only — never `migrate reset` (forbidden even on a throwaway
	// DB, per project convention: keep a single reviewed path for schema application).
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
		cwd: path.resolve('.'),
		env: { ...process.env, ...E2E_ENV },
		stdio: 'inherit'
	});

	// 3. Wait for the webServer to actually serve requests (simple HTTP polling on '/login', a
	// route that never touches the DB for an unauthenticated GET).
	await waitForServer(`${E2E_BASE_URL}/login`);

	// 4. Programmatic register/login + minimal seed dataset, then persist storageState so every
	// spec file under e2e/ inherits the authenticated session automatically.
	await seedE2eData({ storageStatePath: STORAGE_STATE_PATH });

	if (!existsSync(STORAGE_STATE_PATH)) {
		throw new Error(`e2e global-setup: storageState was not written to ${STORAGE_STATE_PATH}`);
	}
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// Server not accepting connections yet — keep polling.
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`e2e global-setup: webServer never became reachable at ${url}`);
}
