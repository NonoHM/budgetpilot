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
import { createPrismaClient } from '../src/lib/server/database/client.ts';
import { runNameKeyBackfill } from '../src/lib/server/naming/backfill.ts';
import { renderNameKeyReport } from '../src/lib/server/naming/report.ts';

const dryRun = process.argv.includes('--dry-run');

// Same client the app builds, so this preview reaches the same database the app will.
const prisma = createPrismaClient();

try {
	const report = await runNameKeyBackfill({ prisma, dryRun });
	console.log(renderNameKeyReport(report));
} catch (error) {
	console.error('Name normalization failed:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	await prisma.$disconnect();
}
