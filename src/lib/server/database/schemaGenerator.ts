// Relative, `.ts`-suffixed import: this module is run by plain Node from
// scripts/generate-prisma-schemas.mjs, with no Vite resolution and no `$lib` alias.
import type { DatabaseProvider } from './provider.ts';

/**
 * Derives the PostgreSQL and MySQL Prisma schemas from the authored SQLite one.
 *
 * Prisma's `datasource.provider` cannot be an environment variable, so supporting three engines
 * means three schema files. Writing them by hand guarantees drift: a field added to one and
 * forgotten in the others produces a migration that exists on a single provider, and nothing
 * catches it until an operator's upgrade fails on the others. So one file is authored and the
 * rest are derived from it.
 *
 * The transformation is kept here, apart from the CLI that runs it, because it is the whole
 * mechanism the generated schemas and therefore their migration histories rely on. `--check`
 * in CI only proves the committed files match this code's output; only tests prove the output
 * is right.
 */

/** Native column type attributes to append, keyed by `Model.field` then by provider. */
export type NativeTypeOverrides = Record<string, Partial<Record<DatabaseProvider, string>>>;

/**
 * Native column types that differ from Prisma's default for a provider.
 *
 * Every entry exists for one reason: MySQL maps `String` to `varchar(191)`, a length limit the
 * other two providers do not have. PostgreSQL maps `String` to `text` and SQLite is untyped, so
 * neither needs an entry and the PostgreSQL schema differs from the source by its datasource
 * block alone.
 *
 * A column left out of this table is one whose content is bounded well under 191 characters:
 * cuid ids (25), sha256 hex keys (64), bcrypt hashes (60), category and account names, ISO
 * country codes, enum-like discriminators.
 */
export const NATIVE_TYPE_OVERRIDES: NativeTypeOverrides = {
	// Free text from a bank statement or from the user. Length has no useful upper bound, and
	// none of these is indexed, so `text` costs nothing.
	'Transaction.label': { mysql: '@db.Text' },
	'Transaction.notes': { mysql: '@db.Text' },
	'Transaction.metadataJson': { mysql: '@db.Text' },
	'ImportBatch.fileName': { mysql: '@db.Text' },
	// Match patterns, including user-supplied regexes.
	'CategorizationRule.pattern': { mysql: '@db.Text' },
	'CategoryRule.matchText': { mysql: '@db.Text' },
	// AES-256-GCM ciphertext ("iv:authTag:ciphertext", base64url). Grows with the plaintext, and
	// bank connection credentials are a JSON document.
	'User.totpSecretEncrypted': { mysql: '@db.Text' },
	'BankConnection.credentialsEncrypted': { mysql: '@db.Text' },
	'BankAuthorizationRequest.stateEncrypted': { mysql: '@db.Text' },
	// A sanitized machine summary today, but the one column that quotes a third party.
	'BankConnection.lastSyncError': { mysql: '@db.Text' }

	// Deliberately absent, do not add without reading this:
	//
	// - `Transaction.dedupeKey` is unbounded too, but it sits under `@@unique([userId,
	//   dedupeKey])`, and MySQL cannot put a unique index on `text` without a prefix length. A
	//   prefix index would merge two transactions differing past the prefix, which is the silent
	//   data loss `Transaction.dedupeKeyHash` was added to remove. It becomes `@db.Text` in the
	//   same change that moves that constraint onto the hash, not before.
	// - `User.email` and `Invitation.email` need 254 characters, above MySQL's 191 default.
	//   Sizing every bounded-but-not-tiny column is its own pass.
};

/** Rewrites the `datasource` block's provider. */
export function withDatasourceProvider(schema: string, provider: DatabaseProvider): string {
	const datasource = /datasource\s+\w+\s*\{[^}]*\}/.exec(schema);
	if (!datasource) throw new Error('No datasource block found in the source schema');

	const rewritten = datasource[0].replace(
		/(provider\s*=\s*)"[^"]*"/,
		(_match, assignment: string) => `${assignment}"${provider}"`
	);
	if (rewritten === datasource[0]) {
		throw new Error('The datasource block in the source schema has no provider to rewrite');
	}
	return schema.replace(datasource[0], rewritten);
}

/**
 * Appends this provider's native type attribute to every overridden field.
 *
 * Line-oriented on purpose. A field declaration is one line in a formatted Prisma schema, and
 * tracking the enclosing `model` is all the parsing needed to key overrides by `Model.field`
 * rather than by a bare field name that several models share.
 */
export function withNativeTypes(
	schema: string,
	provider: DatabaseProvider,
	overrides: NativeTypeOverrides = NATIVE_TYPE_OVERRIDES
): string {
	const applied = new Set<string>();
	let model: string | null = null;

	const lines = schema.split('\n').map((line) => {
		const modelStart = /^model\s+(\w+)\s*\{/.exec(line);
		if (modelStart) {
			model = modelStart[1];
			return line;
		}
		if (model && line.startsWith('}')) {
			model = null;
			return line;
		}
		if (!model) return line;

		// Two-space indent followed by a name and a type. Skips `/// doc comments`, blank lines,
		// and `@@index`/`@@unique` block attributes, none of which start with a word character.
		const field = /^\s{2}(\w+)\s+\S/.exec(line);
		if (!field) return line;

		const attribute = overrides[`${model}.${field[1]}`]?.[provider];
		if (!attribute) return line;

		applied.add(`${model}.${field[1]}`);
		return `${line.trimEnd()} ${attribute}`;
	});

	// A stale override silently applies to nothing, which is exactly the drift this generator
	// exists to prevent: the field was renamed or removed, and MySQL quietly went back to
	// varchar(191) on a column that outgrows it.
	const missing = Object.entries(overrides)
		.filter(([key, byProvider]) => byProvider[provider] && !applied.has(key))
		.map(([key]) => key);
	if (missing.length > 0) {
		throw new Error(
			`Native type overrides target fields that do not exist in the source schema: ${missing.join(', ')}`
		);
	}

	return lines.join('\n');
}

/** The banner every generated schema carries, so nobody edits one by hand. */
export function generatedHeader(sourcePath: string, provider: DatabaseProvider): string {
	const differences =
		provider === 'mysql'
			? 'MySQL caps `String` at varchar(191)'
			: 'none for PostgreSQL, which maps `String` to `text`';
	return `// GENERATED FILE, DO NOT EDIT.
//
// Produced from ${sourcePath} by scripts/generate-prisma-schemas.mjs.
// Edit the source schema and run \`npm run db:schemas\`; CI fails if this file is stale.
//
// Differences from the source: the datasource provider below, and the native column types in
// the generator's NATIVE_TYPE_OVERRIDES table (${differences}).
`;
}

/** The full generated schema for a provider. */
export function generateSchema(
	source: string,
	provider: DatabaseProvider,
	sourcePath: string,
	overrides: NativeTypeOverrides = NATIVE_TYPE_OVERRIDES
): string {
	return `${generatedHeader(sourcePath, provider)}\n${withNativeTypes(
		withDatasourceProvider(source, provider),
		provider,
		overrides
	)}`;
}
