import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// No real database in this suite (everything is mocked elsewhere): the default values are
// checked directly in the Prisma schema, the source of truth for what Prisma inserts when a
// field is omitted while creating a User.
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const schemaPath = resolve(projectRoot, 'prisma/schema.prisma');

describe('User — AI preference defaults', () => {
	it('enables aiInsightsEnabled by default (opt-out, not opt-in)', () => {
		expect.assertions(1);

		const schema = readFileSync(schemaPath, 'utf-8');
		const line = schema.split('\n').find((entry) => entry.trim().startsWith('aiInsightsEnabled'));

		expect(line).toContain('@default(true)');
	});

	it('disables aiIncludeLabels by default (labels never reach the LLM without explicit consent)', () => {
		expect.assertions(1);

		const schema = readFileSync(schemaPath, 'utf-8');
		const line = schema.split('\n').find((entry) => entry.trim().startsWith('aiIncludeLabels'));

		expect(line).toContain('@default(false)');
	});

	it('applies the same defaults in the migration as in the schema', () => {
		expect.assertions(2);

		// Under prisma/migrations/sqlite/ since each provider keeps its own history. The
		// PostgreSQL and MySQL baselines are generated from this same schema, so they cannot
		// disagree with it the way a hand-written migration could.
		const migrationPath = resolve(
			projectRoot,
			'prisma/migrations/sqlite/20260701212541_add_ai_insights_toggles/migration.sql'
		);
		const migration = readFileSync(migrationPath, 'utf-8');

		expect(migration).toContain('"aiInsightsEnabled" BOOLEAN NOT NULL DEFAULT true');
		expect(migration).toContain('"aiIncludeLabels" BOOLEAN NOT NULL DEFAULT false');
	});
});
