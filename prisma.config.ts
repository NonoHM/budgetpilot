import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

const envPath = '.env';

if (existsSync(envPath)) {
	for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
		const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
		if (!match || process.env.DATABASE_URL) continue;

		process.env.DATABASE_URL = match[1].replace(/^["']|["']$/g, '');
	}
}

export default defineConfig({
	schema: 'prisma/schema.prisma',
	migrations: {
		path: 'prisma/migrations'
	},
	datasource: {
		url: process.env.DATABASE_URL ?? 'file:./dev.db'
	}
});
