import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Prisma } from './database/generated/sqlite/browser';
import { searchableSourceFiles } from './security/sourceScan';

/**
 * THE TWO AI PREFERENCE COLUMNS ARE KEPT AND IGNORED BY THE CLIENT (#1011, decision record #1009).
 *
 * 1.3 stopped every read of `User.aiInsightsEnabled` and `User.aiIncludeLabels` (#1010), but kept
 * both fields in the datamodel, and a Prisma client writes every declared default on `create` and
 * selects every declared scalar on a read with no `select`. Measured on 2026-10-31: the 1.3 client
 * against a database without the columns fails `create` and a whole-row read with P2022. So dropping
 * them in 1.4 would break a 1.4 to 1.3 image rollback.
 *
 * 1.4 therefore takes GitLab's first step of removing a column (« Ignoring the column (release M) »,
 * docs.gitlab.com, « Avoiding downtime in migrations »): `@ignore` (« Ignored fields are excluded
 * from the generated Prisma Client », Prisma schema reference). The column stays, with its database
 * default, so 1.3 still finds it; 1.4 never touches it, so the drop in a later release cannot break
 * a rollback to 1.4.
 *
 * Three properties, and each test separates two states:
 * - each schema maps both fields to the old column with its old default AND `@ignore`: separates
 *   « kept and ignored » from « still selected » (no `@ignore`), « dropped » and « moved » (`@map`);
 * - the generated client has neither field: separates « Prisma excludes it » from our belief that it
 *   does;
 * - no tracked code names either field or either column: separates « unread » from « a reader came
 *   back ».
 */

const SCHEMAS = [
	'prisma/schema.prisma',
	'prisma/schema.postgresql.prisma',
	'prisma/schema.mysql.prisma'
];

const COLUMNS = [
	{ field: 'deprecatedAiInsightsEnabled', column: 'aiInsightsEnabled', default: 'true' },
	{ field: 'deprecatedAiIncludeLabels', column: 'aiIncludeLabels', default: 'false' }
];

/** Either spelling, as an identifier or inside a string (raw SQL, a select written as text). */
const NAMED = /\b(?:deprecatedAi|ai)(?:InsightsEnabled|IncludeLabels)\b/g;

/** Code a reader could live in. Prose (docs, the changelog) may name a column; it reads nothing. */
const CODE = ['.ts', '.svelte', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml'];

/** The schemas are the one place the fields are declared, and migrations are history. */
const DECLARED = [/^prisma\//, /^src\/lib\/server\/deprecatedAiColumns\.spec\.ts$/];

function namesIn(text: string): number {
	return [...text.matchAll(NAMED)].length;
}

describe('the deprecated AI preference columns (#1011)', () => {
	it.each(SCHEMAS.flatMap((schema) => COLUMNS.map((entry) => ({ schema, ...entry }))))(
		'$schema keeps $field on the column $column with its old default, ignored by the client',
		({ schema, field, column, default: value }) => {
			const line = readFileSync(schema, 'utf8')
				.split('\n')
				.find((entry) => entry.trim().startsWith(`${field} `));
			expect(line, `${field} declared in ${schema}`).toBeDefined();
			expect(line!.replace(/\s+/g, ' ').trim()).toBe(
				`${field} Boolean @default(${value}) @map("${column}") @ignore`
			);
		}
	);

	it('the generated client has neither field', () => {
		const fields = Object.keys(Prisma.UserScalarFieldEnum);
		// A field every User has, so an empty or wrong enum cannot pass for « excluded ».
		expect(fields, `${fields.length} User fields in the client`).toContain('passwordHash');
		expect(fields.filter((name) => namesIn(name) > 0)).toEqual([]);
	});

	it('the detector finds a name in each spelling it claims to cover', () => {
		// Calibration in the same run: the same matcher the sweep uses, on one line per spelling.
		const planted = [
			'select: { aiInsightsEnabled: true }',
			'data: { aiIncludeLabels: false }',
			'user.deprecatedAiInsightsEnabled',
			'SELECT "deprecatedAiIncludeLabels" FROM "User"'
		];
		expect(planted.map(namesIn)).toEqual([1, 1, 1, 1]);
		expect(namesIn('const aiInsightsEnabledness = 1; // aiInsights')).toBe(0);
	});

	it('no tracked code names either field or either column', () => {
		const files = searchableSourceFiles()
			.filter((path) => CODE.some((extension) => path.endsWith(extension)))
			.filter((path) => !DECLARED.some((pattern) => pattern.test(path)));
		const hits = files
			.map((path) => ({ path, count: namesIn(readFileSync(path, 'utf8')) }))
			.filter((entry) => entry.count > 0);
		// The population, beside the finding: a sweep over no files would also report none.
		expect(files.length, 'tracked code files read').toBeGreaterThan(500);
		expect(hits, `${files.length} files read`).toEqual([]);
	});
});
