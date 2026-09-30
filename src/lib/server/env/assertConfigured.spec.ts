import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

// The collector imports every check's module, and several of them reach the Prisma client. Nothing
// here queries a database, so the client is replaced rather than constructed.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

// Wrapped, not replaced: every bound still reads through the real parser, and the wrapper records
// WHICH variable each check asked it for. That record is how « goes through the shared parser » is
// observed rather than assumed (see « operator bounds » below).
vi.mock('$lib/server/env/operatorBound', async (importOriginal) => {
	const original = await importOriginal<typeof import('./operatorBound')>();
	return { ...original, readOperatorBound: vi.fn(original.readOperatorBound) };
});

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

/**
 * EVERY OPERATOR BOUND READS ITS VALUE THE SAME WAY, ENUMERATED FROM `ENVIRONMENT_CHECKS` (#745).
 *
 * Every registered check is classified: either it is one of the non-bounds below, each with the
 * reason it is not a number an operator moves, or it is an operator bound, whose registry label is
 * the variable it reads. So a new boot check cannot join the registry unclassified: a bound that
 * skips `readOperatorBound` fails both tests below, and a check that is not a bound fails them until
 * it is written into this list with its reason. The list is the one hand-written set here, and it
 * is a CLASSIFICATION the test owns rather than a copy of the registry: the registry itself is read.
 */
const { readOperatorBound } = await import('./operatorBound');
const { assertBootstrapTokenConfigured } = await import('$lib/server/auth/bootstrapToken');
const { assertRateLimitSecretConfigured } = await import('$lib/server/auth/rateLimit');
const { assertEncryptionKeyConfigured } = await import('$lib/server/crypto');
const { assertDatabaseConfigured } = await import('$lib/server/database/bootCheck');
const { assertForwardingConfigSafe } = await import('$lib/server/net/clientAddress');
const NOT_OPERATOR_BOUNDS = new Map<unknown, string>([
	[assertDatabaseConfigured, 'a connection string and an engine name'],
	[assertEncryptionKeyConfigured, 'a secret key'],
	[assertRateLimitSecretConfigured, 'a secret key'],
	[assertBootstrapTokenConfigured, 'a secret token'],
	[assertForwardingConfigSafe, 'two variables that must not be set at all']
]);
const OPERATOR_BOUNDS = ENVIRONMENT_CHECKS.filter(([, run]) => !NOT_OPERATOR_BOUNDS.has(run));

/**
 * What one bound does with one spelling, in words that can be compared as a table: refused with
 * the decimal-digits reason, refused for another reason (quoted), read as a value (taken from the
 * « differs from the default » line every bound's check writes), or the default (no such line).
 */
async function readingOf(name: string, run: () => void | Promise<void>, spelling: string) {
	const previous = process.env[name];
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	process.env[name] = spelling;
	try {
		await run();
		const first = warn.mock.calls[0]?.[0];
		if (first === undefined) return 'the default';
		const read = String(first).match(new RegExp(`${name}=(\\S+) differs from the default`));
		return read ? `read as ${read[1]}` : `accepted, with an unexpected warning: ${String(first)}`;
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		return message.startsWith(
			`${name} must be a whole number of at least 1, written in the digits 0 to 9 only (got ${JSON.stringify(spelling)}).`
		)
			? 'refused: not decimal digits'
			: `refused otherwise: ${message}`;
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
		warn.mockRestore();
	}
}

// The first five are spellings `Number()` read as a number nobody wrote (before #745, on every
// bound: `0x10` as 16, `1e1` as 10, `12.0` as 12, `+5` as 5, `0b11` as 3); the rest were already
// refused and stay refused, now for the one reason. `12` is the calibration: a plain decimal must
// come back as `read as 12`, so a probe that reads nothing cannot pass.
const REFUSED_SPELLINGS = ['0x10', '1e1', '12.0', '+5', '0b11', '-1', '0', '1_0', '1 2', '１２'];
const EXPECTED_READINGS: Record<string, string> = {
	'12': 'read as 12',
	' 12 ': 'read as 12',
	'': 'the default',
	'   ': 'the default',
	...Object.fromEntries(
		REFUSED_SPELLINGS.map((spelling) => [spelling, 'refused: not decimal digits'])
	)
};

describe('operator bounds', () => {
	// Red on the tree before #745, with every bound's row reading `0x10` as 16, `1e1` as 10, `0b11`
	// as 3, `12.0` as 12 and `+5` as 5: the measurement, reproduced.
	//
	// Break-checked on 2026-09-26, one clause each, separately, each red:
	// - `CSV_MAX_COLUMNS` read with `Number(raw)` again (one bound bypassing the parser, versus all
	//   five through it): its row reads `0x10` as 16, `0b11` as 3, `12.0` as 12;
	// - the parser's digit test widened to hex (hex accepted versus refused): `0x10` read as 16 on
	//   every row;
	// - the parser's digit test widened to an exponent (exponent accepted versus refused): `1e1` read
	//   as 10 on every row;
	// - the parser's blank guard removed (blank as a value versus blank as unset): `''` and `'   '`
	//   refused on every row instead of the default; with the guard removed AND the digit test
	//   widened to accept nothing, `''` read as 0.
	// A bound missing from the registry altogether is not visible here, since this iterates the
	// registry: the `ENVIRONMENT_CHECKS` test above is the one that reddens (the `CSV_MAX_COLUMNS`
	// entry deleted: registered 0 times).
	it('refuses every spelling but decimal digits on every registered bound, naming the variable', async () => {
		const readings: Record<string, Record<string, string>> = {};
		for (const [name, run] of OPERATOR_BOUNDS) {
			readings[name] = {};
			for (const spelling of Object.keys(EXPECTED_READINGS)) {
				readings[name][spelling] = await readingOf(name, run, spelling);
			}
		}
		expect({ boundsProbed: OPERATOR_BOUNDS.length > 0, readings }).toStrictEqual({
			boundsProbed: true,
			readings: Object.fromEntries(OPERATOR_BOUNDS.map(([name]) => [name, EXPECTED_READINGS]))
		});
	});

	// The probe above sees behaviour, and a bound refusing hex with a regex of its own would pass it
	// while keeping a second copy of the rule. This one sees WHICH reading ran: every registered check
	// is run once and the variables it asked the shared parser for are recorded. A bound must ask for
	// exactly its own variable (its registry label), a non-bound for none.
	//
	// Break-checked on 2026-09-26, one clause each, separately, each red:
	// - `CSV_MAX_COLUMNS` read by its own copy of the digit test and message instead of the parser
	//   (the rule duplicated versus called; the probe above stays GREEN on this one, which is why this
	//   test exists): its entry records no variable;
	// - `CSV_MAX_COLUMNS` read with `Number(raw)` again: same, and the probe above reddens too;
	// - `assertCsvColumnBoundConfigured` added to NOT_OPERATOR_BOUNDS (a bound the enumeration
	//   misses versus probes; the probe above stays green, having skipped it): its entry records
	//   `CSV_MAX_COLUMNS` where a non-bound must record none;
	// - an exemption for a function that is not registered (a stale classification versus a current
	//   one): `staleExemptions` is 1.
	it('has every registered bound ask the shared parser for its own variable, and nothing else ask', async () => {
		const parse = vi.mocked(readOperatorBound);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const asked: Record<string, string[]> = {};
		try {
			for (const [label, run] of ENVIRONMENT_CHECKS) {
				parse.mockClear();
				try {
					await run();
				} catch {
					// A check refusing this test process's environment still asked for what it asked for.
				}
				asked[label] = parse.mock.calls.map(([bound]) => bound.name);
			}
		} finally {
			warn.mockRestore();
		}
		expect({
			checksRun: Object.keys(asked).length,
			staleExemptions: [...NOT_OPERATOR_BOUNDS.keys()].filter(
				(run) => !ENVIRONMENT_CHECKS.some(([, registered]) => registered === run)
			).length,
			asked
		}).toStrictEqual({
			checksRun: ENVIRONMENT_CHECKS.length,
			staleExemptions: 0,
			asked: Object.fromEntries(
				ENVIRONMENT_CHECKS.map(([label, run]) => [
					label,
					NOT_OPERATOR_BOUNDS.has(run) ? [] : [label]
				])
			)
		});
	});
});
