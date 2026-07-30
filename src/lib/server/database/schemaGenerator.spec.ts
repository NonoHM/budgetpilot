import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	generateSchema,
	generatedHeader,
	NATIVE_TYPE_OVERRIDES,
	withDatasourceProvider,
	withNativeTypes,
	type NativeTypeOverrides
} from './schemaGenerator';

const projectRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const sourceSchema = readFileSync(resolve(projectRoot, 'prisma/schema.prisma'), 'utf8');

const MINIMAL_SCHEMA = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
}

model Transaction {
  id           String  @id @default(cuid())
  /// A doc comment mentioning label, which must not be treated as a field.
  label        String
  dedupeKey    String?
  metadataJson String?

  @@unique([id, dedupeKey])
  @@index([label])
}
`;

describe('withDatasourceProvider', () => {
	it.each(['postgresql', 'mysql'] as const)('rewrites the provider to %s', (provider) => {
		expect.assertions(2);

		const result = withDatasourceProvider(MINIMAL_SCHEMA, provider);

		expect(result).toContain(`provider = "${provider}"`);
		expect(result).not.toContain('provider = "sqlite"');
	});

	it('leaves the generator block alone', () => {
		expect.assertions(1);

		// Both blocks carry a `provider =` line. Only the datasource one describes the engine.
		expect(withDatasourceProvider(MINIMAL_SCHEMA, 'mysql')).toContain(
			'provider = "prisma-client-js"'
		);
	});

	it('throws when there is no datasource block', () => {
		expect.assertions(1);

		expect(() => withDatasourceProvider('model User {\n  id String @id\n}\n', 'mysql')).toThrow(
			/No datasource block/
		);
	});
});

// Scoped to MINIMAL_SCHEMA's own fields. The real table is asserted against the real schema
// further down: the guard requires every override to apply, so a small fixture needs a small
// table.
const FIXTURE_OVERRIDES: NativeTypeOverrides = {
	'Transaction.label': { mysql: '@db.Text' },
	'Transaction.metadataJson': { mysql: '@db.Text' }
};

describe('withNativeTypes', () => {
	it('annotates the overridden fields for mysql and nothing else', () => {
		expect.assertions(3);

		const result = withNativeTypes(MINIMAL_SCHEMA, 'mysql', FIXTURE_OVERRIDES);

		expect(result).toContain('label        String @db.Text');
		expect(result).toContain('metadataJson String? @db.Text');
		// dedupeKey is deliberately left at varchar(191) while the unique constraint still sits
		// on the raw key: MySQL cannot unique-index `text` without a prefix length.
		expect(result).toContain('dedupeKey    String?\n');
	});

	it('leaves doc comments and block attributes untouched', () => {
		expect.assertions(2);

		const result = withNativeTypes(MINIMAL_SCHEMA, 'mysql', FIXTURE_OVERRIDES);

		// A `/// ...` line mentioning a field name is not a field declaration, and `@@index`
		// naming a field is not one either. Annotating either would produce an invalid schema.
		expect(result).toContain('/// A doc comment mentioning label, which must not be');
		expect(result).toContain('@@index([label])');
	});

	it('changes nothing for postgresql', () => {
		expect.assertions(1);

		// PostgreSQL maps `String` to `text`, so it has no override at all: its schema differs
		// from the source by the datasource block alone.
		expect(withNativeTypes(sourceSchema, 'postgresql')).toBe(sourceSchema);
	});

	it('throws when an override targets a field that no longer exists', () => {
		expect.assertions(1);

		// The drift this guard exists for: a renamed or removed field would otherwise let MySQL
		// quietly fall back to varchar(191) on a column that outgrows it, with nothing said.
		const withoutLabel = MINIMAL_SCHEMA.replace(/\s{2}label\s+String\n/, '');

		expect(() => withNativeTypes(withoutLabel, 'mysql', FIXTURE_OVERRIDES)).toThrow(
			/Transaction\.label/
		);
	});

	it('applies every mysql override against the real schema', () => {
		expect.assertions(1);

		// The same guard, run against the schema actually shipped, so a field rename in a future
		// PR fails here rather than silently downgrading a column.
		expect(() => withNativeTypes(sourceSchema, 'mysql')).not.toThrow();
	});
});

describe('NATIVE_TYPE_OVERRIDES', () => {
	it('never annotates a column that carries an index or a unique constraint', () => {
		expect.assertions(1);

		// MySQL cannot index `text` without a prefix length, and a prefix index merges rows
		// differing past it. Any override on an indexed column is either an invalid schema or
		// silent data loss, so the table is checked against the real schema's index blocks.
		const indexedFields = new Set<string>();
		let model: string | null = null;
		for (const line of sourceSchema.split('\n')) {
			const modelStart = /^model\s+(\w+)\s*\{/.exec(line);
			if (modelStart) model = modelStart[1];
			else if (model && line.startsWith('}')) model = null;

			const block = /^\s{2}@@(?:unique|index|id)\(\[([^\]]+)\]/.exec(line);
			if (!model || !block) continue;
			for (const field of block[1].split(',')) indexedFields.add(`${model}.${field.trim()}`);
		}

		const annotatedAndIndexed = Object.keys(NATIVE_TYPE_OVERRIDES).filter((key) =>
			indexedFields.has(key)
		);

		expect(annotatedAndIndexed).toEqual([]);
	});
});

describe('generateSchema', () => {
	it('carries a do-not-edit banner naming the source', () => {
		expect.assertions(2);

		const result = generateSchema(
			MINIMAL_SCHEMA,
			'mysql',
			'prisma/schema.prisma',
			FIXTURE_OVERRIDES
		);

		expect(result).toContain('GENERATED FILE, DO NOT EDIT');
		expect(result).toContain('Produced from prisma/schema.prisma');
	});

	it('is deterministic, so the CI staleness check is meaningful', () => {
		expect.assertions(1);

		// `--check` compares committed bytes against a fresh run: a generator that varied
		// between runs would fail CI on an untouched tree.
		expect(generateSchema(sourceSchema, 'mysql', 'prisma/schema.prisma')).toBe(
			generateSchema(sourceSchema, 'mysql', 'prisma/schema.prisma')
		);
	});

	it.each(['postgresql', 'mysql'] as const)(
		'matches the committed %s schema on disk',
		(provider) => {
			expect.assertions(1);

			// The same assertion `npm run db:schemas:check` makes in CI, made again here so a
			// stale generated schema fails the unit suite too.
			const committed = readFileSync(
				resolve(projectRoot, `prisma/schema.${provider}.prisma`),
				'utf8'
			);

			expect(generateSchema(sourceSchema, provider, 'prisma/schema.prisma')).toBe(committed);
		}
	);
});

describe('generatedHeader', () => {
	it('explains what differs, per provider', () => {
		expect.assertions(2);

		expect(generatedHeader('prisma/schema.prisma', 'mysql')).toContain('varchar(191)');
		expect(generatedHeader('prisma/schema.prisma', 'postgresql')).toContain('none for PostgreSQL');
	});
});
