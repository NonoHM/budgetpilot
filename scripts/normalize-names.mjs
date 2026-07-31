#!/usr/bin/env node
/**
 * Previews or applies the name-normalization backfill (see src/lib/server/naming/).
 *
 *   npm run db:normalize-names -- --dry-run   # print the plan, write nothing
 *   npm run db:normalize-names                # apply it
 *
 * You normally never need this: the app runs the same backfill itself at startup, so
 * upgrading is still just `docker compose up -d`. The command exists so you can read
 * exactly which rows will be merged, by name, before you upgrade.
 *
 * It imports the very same modules the app uses, so what it prints is what runs.
 */
import process from 'node:process';
import { withBootBackfillLock } from '../src/lib/server/database/advisoryLock.ts';
import { createPrismaClient } from '../src/lib/server/database/client.ts';
import { runNameKeyBackfill } from '../src/lib/server/naming/backfill.ts';
import { renderNameKeyReport } from '../src/lib/server/naming/report.ts';

const dryRun = process.argv.includes('--dry-run');

// Same client the app builds, so this preview reaches the same database the app will.
const prisma = createPrismaClient();

try {
	// Applying takes the same lock the app takes at startup, so running this against a live
	// instance queues behind its boot backfill instead of merging alongside it. This is the same
	// global, non-per-user merge, so the race is the same one; the only difference is that an
	// operator can now start it by hand. A dry run only reads, so it never waits for anything.
	const report = dryRun
		? await runNameKeyBackfill({ prisma, dryRun })
		: await withBootBackfillLock('name-keys', () => runNameKeyBackfill({ prisma }));
	console.log(renderNameKeyReport(report));
} catch (error) {
	console.error('Name normalization failed:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	await prisma.$disconnect();
}
