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
	/**
	 * Every `Model.field` the real schema indexes, both shapes.
	 *
	 * The block attributes (`@@unique`, `@@index`, `@@id`) are the obvious half. The field-level
	 * `@unique`/`@id` half is the one that matters most and is easiest to miss: `User.email`,
	 * `Session.tokenHash` and `Invitation.tokenHash` carry their uniqueness inline, so a check
	 * that only read block attributes would skip exactly the columns most dangerous to widen to
	 * `text`. A prefix index on `Session.tokenHash` would match a session by prefix.
	 */
	function indexedFields(): Set<string> {
		const fields = new Set<string>();
		let model: string | null = null;
		for (const line of sourceSchema.split('\n')) {
			const modelStart = /^model\s+(\w+)\s*\{/.exec(line);
			if (modelStart) model = modelStart[1];
			else if (model && line.startsWith('}')) model = null;
			if (!model) continue;

			const block = /^\s{2}@@(?:unique|index|id)\(\[([^\]]+)\]/.exec(line);
			if (block) {
				for (const field of block[1].split(',')) fields.add(`${model}.${field.trim()}`);
				continue;
			}

			const inline = /^\s{2}(\w+)\s+\S+.*\s@(?:unique|id)\b/.exec(line);
			if (inline) fields.add(`${model}.${inline[1]}`);
		}
		return fields;
	}

	// This rule used to be "no override at all on an indexed column", which was the right rule
	// while every override was `@db.Text`. It is narrowed rather than dropped, because the two
	// override shapes fail differently. `text` is the dangerous one: MySQL cannot index it
	// without a prefix length, and a prefix index silently merges rows differing past the
	// prefix, which on `Transaction.dedupeKey` would have merged two distinct transactions.
	// A `varchar(n)` indexes whole values, so it merges nothing and truncates nothing; an
	// over-length write is rejected outright. `User.email` needs exactly that to reach its
	// RFC 5321 length of 254 under a unique index.
	it('never annotates an indexed column with an unbounded type', () => {
		expect.assertions(1);

		const indexed = indexedFields();
		const unboundedAndIndexed = Object.entries(NATIVE_TYPE_OVERRIDES)
			.filter(([key]) => indexed.has(key))
			.filter(([, byProvider]) =>
				Object.values(byProvider).some((attribute) => !/^@db\.VarChar\(\d+\)$/.test(attribute))
			)
			.map(([key]) => key);

		expect(unboundedAndIndexed).toEqual([]);
	});

	it('keeps every indexed column inside InnoDB key limit', () => {
		expect.assertions(1);

		// A varchar override on an indexed column is only safe while the whole key fits InnoDB's
		// 3072-byte limit on the DYNAMIC row format, at 4 bytes per utf8mb4 character. Nothing
		// enforces that but arithmetic, so the arithmetic is a test: a future PR widening a
		// column that sits in a multi-column index finds out here rather than on an operator's
		// `migrate deploy`.
		const INNODB_KEY_LIMIT_BYTES = 3072;
		const BYTES_PER_CHAR = 4;
		const DEFAULT_VARCHAR_CHARS = 191;

		const declaredChars = (field: string): number => {
			const attribute = NATIVE_TYPE_OVERRIDES[field]?.mysql;
			const varchar = attribute && /^@db\.VarChar\((\d+)\)$/.exec(attribute);
			return varchar ? Number(varchar[1]) : DEFAULT_VARCHAR_CHARS;
		};

		// Only `String` columns count toward the key: an Int, a DateTime or an enum is small and
		// fixed, and none of them can be widened by an override.
		const stringFields = new Set<string>();
		let model: string | null = null;
		for (const line of sourceSchema.split('\n')) {
			const modelStart = /^model\s+(\w+)\s*\{/.exec(line);
			if (modelStart) model = modelStart[1];
			else if (model && line.startsWith('}')) model = null;
			const field = /^\s{2}(\w+)\s+String\??\s/.exec(line);
			if (model && field) stringFields.add(`${model}.${field[1]}`);
		}

		const keyBytes = (fields: string[]): number =>
			fields
				.filter((field) => stringFields.has(field))
				.reduce((total, field) => total + declaredChars(field) * BYTES_PER_CHAR, 0);

		const oversized: string[] = [];
		model = null;
		for (const line of sourceSchema.split('\n')) {
			const modelStart = /^model\s+(\w+)\s*\{/.exec(line);
			if (modelStart) model = modelStart[1];
			else if (model && line.startsWith('}')) model = null;
			if (!model) continue;

			// Multi-column keys: every String member counts toward the same limit.
			const block = /^\s{2}@@(unique|index|id)\(\[([^\]]+)\]/.exec(line);
			if (block) {
				const bytes = keyBytes(block[2].split(',').map((field) => `${model}.${field.trim()}`));
				if (bytes > INNODB_KEY_LIMIT_BYTES) {
					oversized.push(`${model}.@@${block[1]}: ${bytes} bytes`);
				}
				continue;
			}

			// Field-level `@unique`/`@id`, a single-column key. This is where `User.email` lives.
			const inline = /^\s{2}(\w+)\s+\S+.*\s@(unique|id)\b/.exec(line);
			if (!inline) continue;
			const bytes = keyBytes([`${model}.${inline[1]}`]);
			if (bytes > INNODB_KEY_LIMIT_BYTES) {
				oversized.push(`${model}.${inline[1]} @${inline[2]}: ${bytes} bytes`);
			}
		}

		expect(oversized).toEqual([]);
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
