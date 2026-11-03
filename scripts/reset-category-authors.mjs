#!/usr/bin/env node
/**
 * Forgets who set every transaction's category (#1013), after rolling forward from 1.3.
 *
 *   npm run db:reset-category-authors -- --dry-run   # print how many authors it would forget
 *   npm run db:reset-category-authors                # forget them
 *
 * Only after running a version older than 1.4 on a 1.4 database: those versions change categories
 * without recording who set them, and one such change cannot be told apart afterwards. No category
 * and no figure changes; every author reads unknown, so nothing that learns only from a member's
 * own choices (#1014) reads those rows as theirs.
 *
 * It imports the very same module the app uses, so what it prints is what runs.
 */
import process from 'node:process';
import { createPrismaClient } from '../src/lib/server/database/client.ts';
import { resetCategoryAuthors } from '../src/lib/server/transactions/categoryAuthorsReset.ts';
import { applySecretSources } from '../src/lib/server/env/secretSources.ts';

const dryRun = process.argv.includes('--dry-run');

// DATABASE_PASSWORD_FILE (#826, #1099), as scripts/normalize-names.mjs.
try {
	applySecretSources(process.env);
} catch (error) {
	console.error('Category author reset failed:', error instanceof Error ? error.message : error);
	process.exit(1);
}

const prisma = createPrismaClient();

try {
	const count = await resetCategoryAuthors(prisma, { dryRun });
	console.log(
		dryRun
			? `Would forget who set ${count} transaction categories. Nothing written.`
			: `Forgot who set ${count} transaction categories.`
	);
} catch (error) {
	console.error('Category author reset failed:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	await prisma.$disconnect();
}
