import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadDefaultRuleCatalog } from './catalog';

/**
 * The migration that repairs already-seeded rules, and the catalogue that seeds new ones, agree.
 *
 * ## Why this seam exists at all
 *
 * `createMissingDefaultRules` only ever CREATES what is missing: a rule already present under its
 * `defaultRuleKey` is skipped forever, by design, so that a rule a user deleted never comes back.
 * Correcting a shipped pattern therefore cannot go through seeding, and a data migration is the
 * only path to an install that already exists.
 *
 * That leaves two sources for one value — the JSON the seeder reads, and a literal inside a `.sql`
 * file nothing else looks at. They can drift silently and the drift is invisible: a new user and an
 * existing user would simply categorise their bakery differently, with no error anywhere.
 *
 * ## Read from the file rather than restated
 *
 * The expectation comes out of the migration text and is compared against `loadDefaultRuleCatalog()`.
 * Retyping either side here would make this test a third source and the comparison an identity.
 *
 * The three engine copies are compared to each other for the same reason, modulo the one difference
 * that is real: MySQL treats a backslash as an escape character inside a string literal, so its
 * copy doubles them and SQLite's and PostgreSQL's do not. That asymmetry is verified rather than
 * assumed — the migration was run on all three engines and the stored bytes compared — and it is
 * exactly the kind of thing that gets "fixed" later by someone making the files look alike.
 */

const MIGRATION = '20260819120000_tighten_overmatching_default_rules';

function migrationText(engine: 'sqlite' | 'postgresql' | 'mysql'): string {
	return readFileSync(`prisma/migrations/${engine}/${MIGRATION}/migration.sql`, 'utf8');
}

/** Every `WHEN '<key>' THEN '<pattern>'` pair, in file order. */
function targetsIn(sql: string): Array<[string, string]> {
	return [...sql.matchAll(/WHEN '([^']+)' THEN '([^']+)'/g)].map((match) => [match[1], match[2]]);
}

describe('the repair migration writes exactly what the catalogue now seeds', () => {
	it('agrees with the catalogue on every key it touches', () => {
		expect.assertions(2);

		const catalog = new Map(loadDefaultRuleCatalog().map((entry) => [entry.key, entry.match]));
		const targets = targetsIn(migrationText('sqlite'));

		// Calibration: a migration whose CASE stopped parsing would make the comparison below vacuous.
		expect(targets).toHaveLength(5);
		expect(targets.map(([key, pattern]) => [key, pattern])).toStrictEqual(
			targets.map(([key]) => [key, catalog.get(key)])
		);
	});

	it('marks every key it touches as a regex in the catalogue too', () => {
		// The pattern and the isRegex flag are two halves of one decision, and the migration sets the
		// flag with a literal rather than reading it. A catalogue entry left as a substring while the
		// migration promoted the row would match the raw text `\bcora\b` against labels, i.e. never.
		expect.assertions(5);

		const byKey = new Map(loadDefaultRuleCatalog().map((entry) => [entry.key, entry]));
		for (const [key] of targetsIn(migrationText('sqlite'))) {
			expect(byKey.get(key)?.isRegex).toBe(true);
		}
	});

	it('says the same thing in all three engine copies, doubling backslashes only for MySQL', () => {
		expect.assertions(2);

		const sqlite = targetsIn(migrationText('sqlite'));

		expect(targetsIn(migrationText('postgresql'))).toStrictEqual(sqlite);
		// MySQL's string literals treat `\` as an escape, so its copy carries `\\b` to store `\b`.
		// Verified against all three engines: the stored bytes are identical (`5c62636f72615c62`).
		expect(targetsIn(migrationText('mysql'))).toStrictEqual(
			sqlite.map(([key, pattern]) => [key, pattern.replaceAll('\\', '\\\\')])
		);
	});
});
