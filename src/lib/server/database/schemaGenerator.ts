// Relative, `.ts`-suffixed import: this module is run by plain Node from
// scripts/generate-prisma-schemas.mjs, with no Vite resolution and no `$lib` alias.
import { clientOutputPathFor, type DatabaseProvider } from './provider.ts';

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
 * cuid ids (25), sha256 hex keys (64), bcrypt hashes (60), category names (capped at 80 on every
 * write path), ISO country codes, enum-like discriminators.
 *
 * Two shapes of override, and the difference matters. `@db.Text` is for columns with no useful
 * upper bound, and is only ever valid on a column carrying no index. `@db.VarChar(n)` is for
 * columns with a real bound the app enforces, and is the only form allowed on an indexed column.
 */
export const NATIVE_TYPE_OVERRIDES: NativeTypeOverrides = {
	// Free text from a bank statement or from the user. Length has no useful upper bound, and
	// none of these is indexed, so `text` costs nothing.
	'Transaction.label': { mysql: '@db.Text' },
	'Transaction.notes': { mysql: '@db.Text' },
	// Unbounded, and safe to widen now that its unique constraint sits on `dedupeKeyHash`
	// instead. While the constraint was still on the raw key this had to stay varchar(191),
	// because MySQL cannot unique-index `text` without a prefix length, and a prefix index
	// merges two transactions differing past it.
	'Transaction.dedupeKey': { mysql: '@db.Text' },
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
	'BankConnection.lastSyncError': { mysql: '@db.Text' },
	// Bank-supplied, and neither is indexed. `bankOperationType` is Enable Banking's
	// `bank_transaction_code.description`, a free-text label with no documented bound; the two
	// `aspspName` columns are the bank's own name as its API reports it.
	'Transaction.bankOperationType': { mysql: '@db.Text' },
	'BankConnection.aspspName': { mysql: '@db.Text' },
	'BankAuthorizationRequest.aspspName': { mysql: '@db.Text' },

	// Fixed-length overrides on indexed columns. These are safe where `@db.Text` is not: a
	// `varchar(n)` carries a whole-value index, so no prefix truncation and no silently merged
	// rows. The budget is InnoDB's 3072-byte key limit on the DYNAMIC row format (verified on
	// the `mariadb:11` image the CI matrix runs), against 4 bytes per utf8mb4 character.

	// RFC 5321 caps an address at 254 characters and `validateEmail()` enforces exactly that, so
	// varchar(191) made MySQL the only provider that rejected a legal address. 254 x 4 = 1016
	// bytes, well inside the limit for these single-column unique indexes.
	'User.email': { mysql: '@db.VarChar(254)' },
	'Invitation.email': { mysql: '@db.VarChar(254)' },
	// A bank names its own accounts and the connector does not cap what it returns, so this is
	// the one indexed column an outside party can overflow. `resolveImportBucketAccount()` now
	// caps what it writes, and the column is widened as well so that restoring a backup taken
	// before that cap cannot fail on MySQL alone. `nameKey` is derived from `name`, so it needs
	// the same room. Widest index over them is `@@unique([userId, name, source])`:
	// (191 + 255 + 191) x 4 = 2548 bytes.
	'Account.name': { mysql: '@db.VarChar(255)' },
	'Account.nameKey': { mysql: '@db.VarChar(255)' }

	// Deliberately absent, do not add without reading this:
	//
	// - `@db.Text` on any column under an `@@index` or `@@unique`. MySQL cannot index `text`
	//   without a prefix length, and a prefix index silently merges rows differing past it. A
	//   test asserts this against the real schema, so a `text` override on an indexed column
	//   fails the suite. A fixed-length `@db.VarChar(n)` is allowed there instead, subject to
	//   the byte budget above.
	// - Every column `server/backup/schema.ts` accepts above 191 characters on restore, which
	//   `server/backup/import.ts` then writes verbatim. That list was fifteen columns wide and
	//   is now one: `backup/schema.ts` bounds the other fourteen at `MAX_PORTABLE_STRING`
	//   (= 191, the narrowest provider's width), so a value MySQL cannot store is refused by
	//   the validator on every engine instead of reaching an insert on one.
	//
	//   The remaining entry is `Account.providerAccountId`, indexed, accepted at 500. It is the
	//   only one whose length no app code decides — the bank's API supplies the uid and the
	//   sync writes it uncapped — so narrowing it would reject a SQLite or PostgreSQL install's
	//   own export rather than close a divergence. Closing it means capping the write path and
	//   giving the column a `@db.VarChar(n)` here; `backup/schema.ts` carries the same note.
	//
	//   Regenerate this list mechanically, never by eye: cross-check every `.max(n)` with
	//   n > 191 in `server/backup/schema.ts` against the keys of this table. The hand-maintained
	//   version of this comment was wrong three ways at once — it omitted `Category.name`
	//   entirely and filed `ImportBatch.source` and `Transaction.source` as unindexed when both
	//   carry an `@@index([source])`.
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
 * Rewrites the `generator` block's `output` to this provider's client directory.
 *
 * Each provider needs its own generated client, and a client embeds the schema it came from,
 * so three schemas sharing one `output` would overwrite each other and leave exactly one
 * client on disk. That was the state before this generator handled the block: the image
 * shipped a SQLite client and regenerated at boot for anything else.
 *
 * Derived rather than hand-written for the same reason the datasource block is: a path edited
 * in one schema and forgotten in another is drift that nothing catches until a provider's
 * client turns out to be someone else's.
 */
export function withGeneratorOutput(schema: string, provider: DatabaseProvider): string {
	const generator = /generator\s+\w+\s*\{[^}]*\}/.exec(schema);
	if (!generator) throw new Error('No generator block found in the source schema');

	const rewritten = generator[0].replace(
		/(output\s*=\s*)"[^"]*"/,
		(_match, assignment: string) => `${assignment}"${clientOutputPathFor(provider)}"`
	);
	if (rewritten === generator[0]) {
		throw new Error('The generator block in the source schema has no output to rewrite');
	}
	return schema.replace(generator[0], rewritten);
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
// Differences from the source: the datasource provider below, the generated client's output
// directory, and the native column types in the generator's NATIVE_TYPE_OVERRIDES table
// (${differences}).
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
		withGeneratorOutput(withDatasourceProvider(source, provider), provider),
		provider,
		overrides
	)}`;
}
