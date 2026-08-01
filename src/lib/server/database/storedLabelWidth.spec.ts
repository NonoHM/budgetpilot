import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STORED_LABEL_MAX_CHARS } from '$lib/domain/recurrence';
import { MAX_PORTABLE_STRING } from '$lib/server/backup/schema';

/**
 * The 191-character cap on `RecurringStreamAction.label` and `.normalizedLabel` is stated in four
 * places that have to agree, and until this file only two of them were tied to each other:
 *
 *  1. `STORED_LABEL_MAX_CHARS` in `domain/recurrence.ts` — what the write path truncates to;
 *  2. `MAX_PORTABLE_STRING` in `server/backup/schema.ts` — what a backup may carry back in;
 *  3. the column itself, in all three schemas, which is what actually rejects an over-long write;
 *  4. the doc comment on each of the two fields, which is what a reader of the schema believes.
 *
 * (1) and (2) are asserted equal in the upcoming-bills service spec. Nothing tied either to the
 * column or to the comment, which is the hand-maintained-inventory shape that was already found
 * wrong three ways at once in `schemaGenerator.ts` — so this reads all four out of their real
 * sources and compares them. Numbers are parsed, never restated: a test that repeats the figure
 * is a fifth copy of it rather than a check on the other four.
 *
 * Idiom follows `schemaGenerator.spec.ts`, which already parses the committed schemas.
 */

const projectRoot = fileURLToPath(new URL('../../../..', import.meta.url));

const MODEL = 'RecurringStreamAction';
const CAPPED_COLUMNS = ['normalizedLabel', 'label'] as const;

const SCHEMAS = [
	['sqlite', 'prisma/schema.prisma'],
	['postgresql', 'prisma/schema.postgresql.prisma'],
	['mysql', 'prisma/schema.mysql.prisma']
] as const;

type Provider = (typeof SCHEMAS)[number][0];

/** No provider here gives a bare `String` a character limit; only MySQL does. */
const UNBOUNDED = Number.POSITIVE_INFINITY;

function readSchema(path: string): string {
	return readFileSync(resolve(projectRoot, path), 'utf8');
}

/** The body of `model RecurringStreamAction { ... }`, doc comment lines included. */
function modelBody(schema: string): string[] {
	const match = new RegExp(String.raw`^model ${MODEL} \{\n([\s\S]*?)^\}`, 'm').exec(schema);
	if (!match) throw new Error(`No ${MODEL} model in the schema`);
	return match[1].split('\n');
}

/** One field's declaration line plus the `///` lines directly above it, which document it. */
function fieldDeclaration(schema: string, field: string): { line: string; doc: string } {
	const lines = modelBody(schema);
	const index = lines.findIndex((line) => new RegExp(String.raw`^\s{2}${field}\s`).test(line));
	if (index === -1) throw new Error(`No ${MODEL}.${field} field in the schema`);

	const doc: string[] = [];
	for (let i = index - 1; i >= 0 && lines[i].trimStart().startsWith('///'); i -= 1) {
		doc.unshift(lines[i]);
	}
	return { line: lines[index], doc: doc.join('\n') };
}

/**
 * Prisma's default `varchar(n)` for a bare `String` on MySQL, read out of the generated banner
 * rather than written here. The banner is the artifact's own statement of that width, so a
 * generator that starts claiming a different one is caught instead of being believed.
 */
function mysqlDefaultVarcharChars(): number {
	const [header] = readSchema('prisma/schema.mysql.prisma').split('generator client {');
	const match = /varchar\((\d+)\)/.exec(header);
	if (!match) throw new Error('The MySQL schema banner no longer states the default varchar width');
	return Number(match[1]);
}

/**
 * How many characters the column can actually hold, per provider.
 *
 * MySQL is the only one that bounds a bare `String`; PostgreSQL maps it to `text` and SQLite to
 * `TEXT`, neither of which has a width. So "the column agrees with the constant" is a different
 * claim per provider, and both are asserted below rather than one shape being forced on all three.
 */
function columnCapacity(provider: Provider, declaration: string): number {
	const native = /@db\.(\w+)(?:\((\d+)\))?/.exec(declaration);
	if (!native) return provider === 'mysql' ? mysqlDefaultVarcharChars() : UNBOUNDED;
	// A `@db.VarChar(n)` from NATIVE_TYPE_OVERRIDES is the only annotation that sets a width;
	// `@db.Text` and the rest remove the bound entirely.
	if (native[1] === 'VarChar' && native[2] !== undefined) return Number(native[2]);
	return UNBOUNDED;
}

/** The figure the field's doc comment states, which is what a reader of the schema goes by. */
function documentedCap(doc: string): number {
	const matches = [...doc.matchAll(/capped at (\d+) by the write path/gi)];
	if (matches.length !== 1) {
		throw new Error(
			`Expected exactly one "capped at N by the write path" doc comment, found ${matches.length}`
		);
	}
	return Number(matches[0][1]);
}

describe(`the stored-label cap on ${MODEL}`, () => {
	it('is the same number in the domain and in the backup validator', () => {
		expect.assertions(1);

		// Sources (1) and (2). Also asserted in the upcoming-bills service spec; repeated here so
		// this file fails as a whole when the four stop agreeing, whichever one moved.
		expect(MAX_PORTABLE_STRING).toBe(STORED_LABEL_MAX_CHARS);
	});

	it.each(CAPPED_COLUMNS)('is what MySQL gives %s, exactly', (field) => {
		expect.assertions(1);

		// Source (3), MySQL leg. MySQL's varchar(191) is the narrowest of the three columns and
		// therefore the one the write path is calibrated to fill: equality, not "at least". A
		// `@db.Text` or a wider `@db.VarChar` here would mean the truncation throws away characters
		// the column could have stored; a narrower one would mean a legal write is rejected.
		const { line } = fieldDeclaration(readSchema('prisma/schema.mysql.prisma'), field);

		expect(columnCapacity('mysql', line)).toBe(STORED_LABEL_MAX_CHARS);
	});

	it.each(SCHEMAS)('fits in the %s column', (provider, path) => {
		expect.assertions(CAPPED_COLUMNS.length);

		// Source (3), all three schemas. PostgreSQL and SQLite store `text`, so the honest claim
		// for them is capacity, not equality: they cannot disagree with the constant by being too
		// wide, only by acquiring a width narrower than it.
		const schema = readSchema(path);
		for (const field of CAPPED_COLUMNS) {
			const { line } = fieldDeclaration(schema, field);
			expect(columnCapacity(provider, line)).toBeGreaterThanOrEqual(STORED_LABEL_MAX_CHARS);
		}
	});

	it.each(SCHEMAS)('is the figure the %s schema documents', (_provider, path) => {
		expect.assertions(CAPPED_COLUMNS.length);

		// Source (4). Parsed out of the comment, so deleting or rewording it fails in
		// `documentedCap` and changing its number fails here.
		const schema = readSchema(path);
		for (const field of CAPPED_COLUMNS) {
			const { doc } = fieldDeclaration(schema, field);
			expect(documentedCap(doc)).toBe(STORED_LABEL_MAX_CHARS);
		}
	});
});
