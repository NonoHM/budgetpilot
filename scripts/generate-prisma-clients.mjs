#!/usr/bin/env node
/**
 * Generates the Prisma client for every supported provider.
 *
 * The application imports all three statically (see database/client.ts), so all three have to
 * exist before anything builds, type-checks or runs — including a plain SQLite install, which
 * never touches the other two at runtime but still compiles them.
 *
 * One pass per provider, because `prisma generate` reads a single schema and each provider has
 * its own. `prisma.config.ts` resolves which schema from DATABASE_PROVIDER, so each pass needs
 * nothing on the command line.
 *
 * Each pass gets a placeholder DATABASE_URL matching the provider it generates. Generation never
 * connects, so the value is never dialled — but prisma.config.ts rejects a URL whose scheme
 * belongs to another engine, and the real DATABASE_URL (from the environment or from .env) names
 * exactly one of the three. Without a placeholder, generating the other two would fail that
 * check on any machine with a .env, which is every developer machine.
 *
 * Usage:
 *   node scripts/generate-prisma-clients.mjs     # or: npm run db:generate
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { DATABASE_PROVIDERS } from '../src/lib/server/database/provider.ts';

/** Never connected to. Only the scheme matters, and only to satisfy prisma.config.ts. */
const PLACEHOLDER_URLS = {
	sqlite: 'file:./generate-only-placeholder.db',
	postgresql: 'postgresql://generate:only@127.0.0.1:5432/placeholder',
	mysql: 'mysql://generate:only@127.0.0.1:3306/placeholder'
};

for (const provider of DATABASE_PROVIDERS) {
	console.log(`Generating the Prisma client for ${provider}`);

	const { status, error } = spawnSync('npx', ['prisma', 'generate'], {
		stdio: 'inherit',
		env: {
			...process.env,
			DATABASE_PROVIDER: provider,
			DATABASE_URL: PLACEHOLDER_URLS[provider]
		}
	});

	if (error) throw error;
	if (status !== 0) {
		console.error(`Failed to generate the Prisma client for ${provider}`);
		process.exit(status ?? 1);
	}
}
