import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { searchableSourceFiles } from './security/sourceScan';

/**
 * THE TWO AI PREFERENCE COLUMNS ARE KEPT AND READ BY NOTHING (#1010, decision record #1009).
 *
 * 1.3 ships no AI use, so nothing reads `User.aiInsightsEnabled` or `User.aiIncludeLabels`. They are
 * not dropped in 1.3 because 1.2 reads both: a 1.3 database rolled back to the 1.2 image must still
 * have them, with the defaults 1.2 relies on (labels never reach a model without consent). The drop
 * is B0 (#1011), the first change of 1.4 (expand and contract).
 *
 * So two properties, and each test separates two states:
 * - the schemas still map a field to EACH old column, with its old default: separates « rollback
 *   reads the columns 1.2 expects » from « a rename moved the column » (a `@map` dropped or changed);
 * - no tracked code names either field or either column: separates « deprecated and unread » from
 *   « a reader survived or came back ». Tests count too, so B0 drops the columns with nothing to edit.
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

describe('the deprecated AI preference columns (#1010)', () => {
	it.each(SCHEMAS.flatMap((schema) => COLUMNS.map((entry) => ({ schema, ...entry }))))(
		'$schema maps $field to the column $column with its old default',
		({ schema, field, column, default: value }) => {
			const line = readFileSync(schema, 'utf8')
				.split('\n')
				.find((entry) => entry.trim().startsWith(`${field} `));
			expect(line, `${field} declared in ${schema}`).toBeDefined();
			expect(line!.replace(/\s+/g, ' ').trim()).toBe(
				`${field} Boolean @default(${value}) @map("${column}")`
			);
		}
	);

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
