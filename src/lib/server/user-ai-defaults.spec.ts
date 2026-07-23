import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// No real database in this suite (everything is mocked elsewhere): we check
// the default values directly in the Prisma schema, the source of truth for what
// Prisma inserts when a field isn't provided when creating a User.
const schemaPath = resolve(
	fileURLToPath(new URL('../../..', import.meta.url)),
	'prisma/schema.prisma'
);

describe('User — valeurs par défaut des préférences IA', () => {
	it('active aiInsightsEnabled par défaut (opt-out, pas opt-in)', () => {
		expect.assertions(1);

		const schema = readFileSync(schemaPath, 'utf-8');
		const line = schema.split('\n').find((entry) => entry.trim().startsWith('aiInsightsEnabled'));

		expect(line).toContain('@default(true)');
	});

	it('désactive aiIncludeLabels par défaut (les libellés ne partent pas au LLM sans consentement explicite)', () => {
		expect.assertions(1);

		const schema = readFileSync(schemaPath, 'utf-8');
		const line = schema.split('\n').find((entry) => entry.trim().startsWith('aiIncludeLabels'));

		expect(line).toContain('@default(false)');
	});

	it('la migration correspondante applique les mêmes défauts que le schéma', () => {
		expect.assertions(2);

		const migrationPath = resolve(
			fileURLToPath(new URL('../../..', import.meta.url)),
			'prisma/migrations/20260701212541_add_ai_insights_toggles/migration.sql'
		);
		const migration = readFileSync(migrationPath, 'utf-8');

		expect(migration).toContain('"aiInsightsEnabled" BOOLEAN NOT NULL DEFAULT true');
		expect(migration).toContain('"aiIncludeLabels" BOOLEAN NOT NULL DEFAULT false');
	});
});
