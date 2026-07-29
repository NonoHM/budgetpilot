// Playwright globalSetup: runs once before the test suite, and only after Playwright has spawned
// the webServer. It waits for that server to serve requests, then seeds a minimal dataset +
// storageState through real HTTP routes.
//
// Creating the throwaway database is deliberately NOT done here: Playwright runs globalSetup
// after the server is already up, so deleting and re-migrating from this point pulled the schema
// out from under a process that had already booted against it. That work moved into
// e2e/prepare-db.ts, run as the first step of the webServer command. NEVER touches dev.db /
// prisma/dev.db — the path comes from e2e/config.ts.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { E2E_BASE_URL } from './config';
import { seedE2eData } from './seed';

const AUTH_DIR = path.resolve('e2e/.auth');
const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'user.json');

export default async function globalSetup(): Promise<void> {
	// 1. Wait for the webServer to actually serve requests (simple HTTP polling on '/login', a
	// route that never touches the DB for an unauthenticated GET).
	await waitForServer(`${E2E_BASE_URL}/login`);

	// 2. Programmatic register/login + minimal seed dataset, then persist storageState so every
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
