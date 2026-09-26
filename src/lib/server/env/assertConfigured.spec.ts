import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

// The collector imports every check's module, and several of them reach the Prisma client. Nothing
// here queries a database, so the client is replaced rather than constructed.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

const {
	assertEnvironmentConfigured,
	buildEnvironmentReport,
	collectEnvironmentProblems,
	ENVIRONMENT_CHECKS
} = await import('./assertConfigured');

// A fake check is the right unit here: what this module contributes is the COLLECTION, and using
// the nine real checks would make these cases a test of nine other modules instead.
const failing = (message: string) => () => {
	throw new Error(message);
};
const passing = () => {};

describe('collectEnvironmentProblems', () => {
	it('reports every failure, not the first', async () => {
		const problems = await collectEnvironmentProblems([
			['A', failing('A is wrong')],
			['B', passing],
			['C', failing('C is wrong')]
		]);
		expect(problems).toEqual(['A is wrong', 'C is wrong']);
	});

	// This is the whole point: four consecutive boots, each revealing one more variable. The
	// assertion is that the second boot never happens.
	it('does not stop at the first failure', async () => {
		const problems = await collectEnvironmentProblems([
			['A', failing('first')],
			['B', failing('second')],
			['C', failing('third')]
		]);
		expect(problems).toEqual(['first', 'second', 'third']);
	});

	it('awaits async checks', async () => {
		const problems = await collectEnvironmentProblems([
			['A', async () => Promise.reject(new Error('async failure'))],
			['B', failing('sync failure')]
		]);
		expect(problems).toEqual(['async failure', 'sync failure']);
	});

	it('names the check when something that is not an Error is thrown', async () => {
		const problems = await collectEnvironmentProblems([['WEIRD', () => Promise.reject('nope')]]);
		expect(problems).toEqual(['WEIRD: nope']);
	});

	it('returns nothing when every check passes', async () => {
		expect(
			await collectEnvironmentProblems([
				['A', passing],
				['B', passing]
			])
		).toEqual([]);
	});
});

describe('buildEnvironmentReport', () => {
	it('numbers every problem and keeps each message intact', () => {
		const report = buildEnvironmentReport(['first thing', 'second thing']);
		expect(report).toContain('1. first thing');
		expect(report).toContain('2. second thing');
	});

	it('states the count when there is more than one', () => {
		expect(buildEnvironmentReport(['a', 'b', 'c'])).toContain('3 configuration problems');
	});

	it('does not say "3 problems" when there is one', () => {
		expect(buildEnvironmentReport(['only'])).toContain('one configuration problem');
	});

	// Every individual message names a variable and none of them says which file it goes in.
	it('names where the values go', () => {
		expect(buildEnvironmentReport(['a'])).toMatch(/\.env/);
	});
});

/**
 * EVERY BOOT CHECK THE CODE EXPORTS, ENUMERATED FROM THE TREE RATHER THAN TYPED HERE (#738).
 *
 * A hand-written list of checks in this file would be a copied constant: a check added to the code
 * and to neither list would leave it green. So the set is read from the source of truth, by the
 * rule stated on `ENVIRONMENT_CHECKS`: a boot check is a function EXPORTED from a module under
 * `src/lib` and named `assert<Thing>Configured` or `assert<Thing>Safe`, other than the collector.
 *
 * How it is read, and what it cannot see. Every `.ts` module under `src/lib` (specs, db-smokes and
 * declarations excluded) is read as text; each one that NAMES such a function anywhere is imported,
 * and its RUNTIME exports are filtered by the name. The text pass only chooses which modules to
 * import, so an unusual export form (`export { x as assertFooConfigured }`) is still found. A check
 * named outside the convention is invisible to the forward direction; the reverse direction refuses
 * a REGISTERED entry that no conventionally named export accounts for, so the registry cannot drift
 * from the convention quietly.
 *
 * At module level rather than inside the test: importing the checks' modules can outlast the 5 s
 * test timeout under a full parallel run (`rateLimit.spec.ts` records the same).
 */
const SRC_LIB = fileURLToPath(new URL('../..', import.meta.url));
const BOOT_CHECK_NAME = /^assert[A-Z]\w*(?:Configured|Safe)$/;
const NAMES_A_BOOT_CHECK = /\bassert[A-Z]\w*(?:Configured|Safe)\b/;
const modulesRead = (readdirSync(SRC_LIB, { recursive: true }) as string[])
	.filter((path) => path.endsWith('.ts') && !/\.(spec|test|db-smoke|d)\.ts$/.test(path))
	.map((path) => join(SRC_LIB, path));
const exportedChecks: { where: string; run: unknown }[] = [];
for (const path of modulesRead) {
	if (!NAMES_A_BOOT_CHECK.test(readFileSync(path, 'utf8'))) continue;
	const exports: Record<string, unknown> = await import(/* @vite-ignore */ path);
	for (const [name, value] of Object.entries(exports)) {
		if (BOOT_CHECK_NAME.test(name) && typeof value === 'function') {
			exportedChecks.push({ where: `${relative(SRC_LIB, path)}#${name}`, run: value });
		}
	}
}

describe('ENVIRONMENT_CHECKS', () => {
	it('registers every exported boot check exactly once, and nothing else', () => {
		// The calibration, in the same pass: the collector's own `assertEnvironmentConfigured` is an
		// exported function under `src/lib` with a boot-check name, so an enumeration that read
		// nothing, or whose name filter matches nothing, cannot find it. It is then set aside by
		// IDENTITY, not by name. `modulesRead` is the absolute figure beside it.
		const collector = exportedChecks.filter(({ run }) => run === assertEnvironmentConfigured);
		const checks = exportedChecks.filter(({ run }) => run !== assertEnvironmentConfigured);

		// One value, so every figure is computed and shown whichever is red. `registrations` maps
		// each exported check to how many entries of `ENVIRONMENT_CHECKS` hold that very function;
		// `outsideTheConvention` names every registered entry no exported, conventionally named
		// check accounts for.
		//
		// Break-checked on 2026-09-25, one clause each, separately, each red:
		// - the `TOTP_ENCRYPTION_KEY` entry deleted (registered vs not): registered 0 times;
		// - that entry listed twice (once vs twice): registered 2 times;
		// - an exported `assertPlantedConfigured` added to `crypto.ts`, registered nowhere (a new
		//   check added unregistered): registered 0 times;
		// - an exported `checkPlantedKey` registered as `PLANTED` (a registered entry named outside
		//   the rule): every check still registered once, `PLANTED` listed in `outsideTheConvention`;
		// - the name filter replaced by one matching nothing (an enumeration that finds nothing):
		//   `collectorFound` 0 and every registered label listed in `outsideTheConvention`.
		expect({
			modulesRead: modulesRead.length > 0,
			collectorFound: collector.length,
			registrations: Object.fromEntries(
				checks.map(({ where, run }) => [
					where,
					ENVIRONMENT_CHECKS.filter(([, registered]) => registered === run).length
				])
			),
			outsideTheConvention: ENVIRONMENT_CHECKS.filter(
				([, registered]) => !checks.some(({ run }) => run === registered)
			).map(([label]) => label)
		}).toStrictEqual({
			modulesRead: true,
			collectorFound: 1,
			registrations: Object.fromEntries(checks.map(({ where }) => [where, 1])),
			outsideTheConvention: []
		});
	});
});
