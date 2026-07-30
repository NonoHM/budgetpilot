#!/usr/bin/env node
/**
 * Writes the PostgreSQL and MySQL Prisma schemas derived from `prisma/schema.prisma`.
 *
 * `prisma/schema.prisma` is the authored source and stays on SQLite, the default provider, so
 * `npx prisma migrate dev`, `prisma format` and every editor extension keep working with no
 * arguments for the setup almost everyone runs.
 *
 * The transformation itself lives in src/lib/server/database/schemaGenerator.ts, where it is
 * unit-tested. This file is the command line around it: paths, argv, exit codes.
 *
 * Usage:
 *   node scripts/generate-prisma-schemas.mjs           # write the generated schemas
 *   node scripts/generate-prisma-schemas.mjs --check   # fail if they are out of date (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
	DATABASE_PROVIDERS,
	DEFAULT_DATABASE_PROVIDER,
	schemaPathFor
} from '../src/lib/server/database/provider.ts';
import { generateSchema } from '../src/lib/server/database/schemaGenerator.ts';

const SOURCE_PATH = schemaPathFor(DEFAULT_DATABASE_PROVIDER);
const GENERATED_PROVIDERS = DATABASE_PROVIDERS.filter(
	(provider) => provider !== DEFAULT_DATABASE_PROVIDER
);

const check = process.argv.includes('--check');
const source = readFileSync(path.resolve(SOURCE_PATH), 'utf8');
const stale = [];

for (const provider of GENERATED_PROVIDERS) {
	const target = schemaPathFor(provider);
	const expected = generateSchema(source, provider, SOURCE_PATH);

	if (!check) {
		writeFileSync(path.resolve(target), expected);
		console.log(`Wrote ${target}`);
		continue;
	}

	let actual = null;
	try {
		actual = readFileSync(path.resolve(target), 'utf8');
	} catch {
		// Missing counts as stale.
	}
	if (actual !== expected) stale.push(target);
}

if (stale.length > 0) {
	console.error(
		`Generated Prisma schemas are out of date: ${stale.join(', ')}\n` +
			'Run `npm run db:schemas` and commit the result.'
	);
	process.exit(1);
}
if (check) console.log('Generated Prisma schemas are up to date.');
