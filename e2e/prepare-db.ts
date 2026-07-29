// Recreates the throwaway e2e database, BEFORE the app server starts.
//
// Run as the first step of playwright.config.ts's `webServer` command rather than from
// globalSetup, because Playwright spawns the webServer and waits for it to be reachable
// before globalSetup runs. Deleting and re-migrating from globalSetup therefore pulled the
// database out from under a process that had already booted against it: the server kept an
// open handle on the deleted file, and any query it had already made was answered by a
// schema that no longer existed on disk.
//
// That was survivable only while nothing queried the database at startup. It stopped being
// survivable once `hooks.server.ts`'s `init` began checking whether the name-key backfill
// still had work to do, which fails outright against a stale schema. Preparing the database
// first removes the race instead of timing around it.
//
// Never touches dev.db / prisma/dev.db: the path comes from E2E_DATABASE_URL (see config.ts),
// and `migrate deploy` is used rather than `migrate reset`, which is forbidden project-wide
// even on a throwaway file.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { E2E_ENV } from './config.ts';

const DB_DIR = path.resolve('e2e/.data');
const AUTH_DIR = path.resolve('e2e/.auth');

rmSync(DB_DIR, { recursive: true, force: true });
mkdirSync(DB_DIR, { recursive: true });
mkdirSync(AUTH_DIR, { recursive: true });

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
	cwd: path.resolve('.'),
	env: { ...process.env, ...E2E_ENV },
	stdio: 'inherit'
});
