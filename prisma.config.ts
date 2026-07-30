import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'prisma/config';
import {
	assertDatabaseUrlMatchesProvider,
	DEFAULT_SQLITE_URL,
	migrationsPathFor,
	resolveDatabaseProvider,
	schemaPathFor,
	toPrismaConnectionUrl
} from './src/lib/server/database/provider.ts';

const envPath = '.env';

if (existsSync(envPath)) {
	for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
		const match = /^(DATABASE_URL|DATABASE_PROVIDER)=(.*)$/.exec(line.trim());
		if (!match || process.env[match[1]]) continue;

		process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
	}
}

// The Prisma CLI reads the same two variables the app does, so `npx prisma migrate deploy`
// targets the schema and the migration history of the configured provider with nothing passed
// on the command line. Each provider keeps its own history: the same logical change is
// different SQL on each engine, and Prisma records only a migration's name as applied.
const provider = resolveDatabaseProvider(process.env);
assertDatabaseUrlMatchesProvider(provider, process.env.DATABASE_URL);

export default defineConfig({
	schema: schemaPathFor(provider),
	migrations: {
		path: migrationsPathFor(provider)
	},
	datasource: {
		// Normalised, not passed through: the CLI accepts only `mysql://` for the `mysql`
		// provider, while `DATABASE_PROVIDER=mariadb` invites `mariadb://`. See
		// toPrismaConnectionUrl.
		url: toPrismaConnectionUrl(provider, process.env.DATABASE_URL ?? DEFAULT_SQLITE_URL)
	}
});
