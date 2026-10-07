import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SETTINGS, type Setting } from './settings';

/**
 * THE REGISTRY AND THE TREE MUST AGREE (R14). Three directions, each its own test, so one red never
 * hides another:
 *
 * 1. Every variable production code reads by name is declared in `SETTINGS`. A setting read
 *    nowhere in the registry is a setting with no default, no range and no line in the reference
 *    page, which is the drift the registry exists to end.
 * 2. Every `app` entry is read somewhere. An entry nothing reads documents a setting that does
 *    nothing.
 * 3. Every key `.env.example` carries, set or commented out, is declared.
 *
 * **What it reads, and what it cannot see.** Tracked production files (`git ls-files`, which is
 * what a clone and CI have), through the two spellings a read takes here: a member of
 * `process.env`, of an injected `env` or of `source` (`env.X`, `env?.X`, `env['X']`), and a computed
 * key (`env[name]`). A computed key cannot be resolved by reading, so each one is listed below by
 * file and identifier with the reason its names are registered elsewhere, and a new one fails until
 * it is listed. A name passed through a variable to a function that reads `process.env` with a
 * computed key inside another file would be invisible, which is why every computed-key site is
 * enumerated rather than trusted.
 *
 * The census that found the three spellings (2026-10-07) also found that a `process.env.X` search
 * alone counts zero of the `BP_*` names, so the calibrations below plant one of each spelling.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function trackedFiles(...patterns: string[]): string[] {
	return execFileSync('git', ['ls-files', ...patterns], { cwd: REPO_ROOT, encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
}

const PRODUCTION = trackedFiles(
	'src/*.ts',
	'src/*.js',
	'src/*.svelte',
	'boot.mjs',
	'healthcheck.mjs'
)
	.filter((path) => !/\.(spec|test|db-smoke)\.ts$/.test(path))
	.filter((path) => !path.startsWith('src/lib/server/database/generated/'))
	.filter((path) => !path.startsWith('src/lib/paraglide/'));

const read = (path: string) => readFileSync(REPO_ROOT + path, 'utf8');

const NAMED_READ =
	/(?:process\.env|\benv|\bsource)\??(?:\.([A-Z][A-Z0-9_]+)\b|\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\])/g;
const COMPUTED_READ = /(?:process\.env|\benv|\bsource)\??\[\s*([A-Za-z_$][\w$]*)\s*\]/g;

/** Every name read by name in `text`. Exported to the calibration through the same function. */
function namesReadIn(text: string): string[] {
	return [...text.matchAll(NAMED_READ)].map((match) => match[1] ?? match[2]);
}

/** Every computed-key read in `text`, as `<path>#<identifier>`. */
function computedReadsIn(path: string, text: string): string[] {
	return [...text.matchAll(COMPUTED_READ)].map((match) => `${path}#${match[1]}`);
}

/**
 * Every computed-key read in production code, with where its names come from. A stale entry fails
 * too, so the list cannot outlive the code it describes.
 */
const COMPUTED_READS_EXPLAINED: Record<string, string> = {
	'src/lib/server/env/operatorBound.ts#name':
		'the shared reader of whole numbers; every caller passes a registry name (`IntegerSettingName` or one of the five bounds, each pinned by `assertConfigured.spec.ts`)',
	'src/lib/server/env/readSetting.ts#name':
		'the shared reader of choices; its parameter is typed to the registry names whose unknown values are refused',
	'src/lib/server/logging/settings.ts#name':
		'reads `BP_LOG_LEVEL` and `BP_SECURITY_LOG` through two constants in the same file, both registered',
	'src/lib/server/net/clientAddress.ts#TRUSTED_PROXIES_ENV': 'a constant holding `TRUSTED_PROXIES`',
	'src/lib/server/net/clientAddress.ts#name':
		'`ADDRESS_HEADER` and `XFF_DEPTH`, listed as literals beside the read',
	'src/lib/server/security/sourceScan.ts#i':
		'not an environment read: indexes a string named `source` character by character'
};

const entries = Object.entries(SETTINGS) as [string, Setting][];
const declared = new Set(entries.map(([name]) => name));

describe('settings drift between the registry and the tree', () => {
	// Calibration, in the same file and through the same functions: each spelling a read takes
	// here, planted, must be found. A pattern that matched nothing would pass every test below.
	it('finds a planted read in each spelling', () => {
		const planted = [
			'process.env.BP_PLANTED_A',
			"env['BP_PLANTED_B']",
			'env?.BP_PLANTED_C',
			'source.BP_PLANTED_D'
		].join('\n');
		expect({
			named: namesReadIn(planted),
			computed: computedReadsIn('planted.ts', 'const raw = env[plantedName];')
		}).toStrictEqual({
			named: ['BP_PLANTED_A', 'BP_PLANTED_B', 'BP_PLANTED_C', 'BP_PLANTED_D'],
			computed: ['planted.ts#plantedName']
		});
	});

	// Break-checked: the `TRUSTED_PROXIES` entry removed from SETTINGS (a read the registry declares
	// versus one it does not) lists `TRUSTED_PROXIES` in `undeclared`.
	it('declares every variable production code reads by name', () => {
		const readByName = new Map<string, string>();
		for (const path of PRODUCTION) {
			for (const name of namesReadIn(read(path))) readByName.set(name, path);
		}
		// Measured on 2026-10-07 on this branch: 370 files, 24 names read by name (30 before the six
		// #754 settings moved to `readIntegerSetting`, which names them as an argument instead). The
		// floors sit below both, so an ordinary edit does not move them and an instrument that read
		// nothing cannot pass.
		expect({
			filesRead: PRODUCTION.length > 300,
			namesRead: readByName.size >= 20,
			undeclared: [...readByName].filter(([name]) => !declared.has(name))
		}).toStrictEqual({ filesRead: true, namesRead: true, undeclared: [] });
	});

	it('explains every computed-key read, and keeps no stale explanation', () => {
		const found = PRODUCTION.flatMap((path) => computedReadsIn(path, read(path)));
		expect({
			unexplained: found.filter((site) => !(site in COMPUTED_READS_EXPLAINED)),
			stale: Object.keys(COMPUTED_READS_EXPLAINED).filter((site) => !found.includes(site))
		}).toStrictEqual({ unexplained: [], stale: [] });
	});

	// An `app` entry counts as read when its name is read by name, or appears as a quoted literal in
	// production code outside the registry (the five bounds and the two log settings hold their
	// names in constants; the six #754 settings pass theirs to `readIntegerSetting`).
	// Break-checked: an entry `BP_PLANTED_UNREAD` added to SETTINGS (an entry something reads
	// versus one nothing reads) lists it in `unread`.
	it('reads every setting the registry says the app reads', () => {
		const corpus = PRODUCTION.filter((path) => path !== 'src/lib/server/env/settings.ts')
			.map(read)
			.join('\n');
		const unread = entries
			.filter(([, setting]) => setting.readBy === 'app')
			.map(([name]) => name)
			.filter(
				(name) => !namesReadIn(corpus).includes(name) && !new RegExp(`['"]${name}['"]`).test(corpus)
			);
		expect(unread).toStrictEqual([]);
	});

	// Break-checked: a line `#BP_PLANTED_EXAMPLE=` added to .env.example (a documented key the
	// registry declares versus one it does not) lists it.
	it('declares every key .env.example carries, set or commented out', () => {
		const keys = [...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(
			(match) => match[1]
		);
		// Measured on 2026-10-07: 41 keys, one of them commented out (`#ORIGIN=`).
		expect({
			keysRead: keys.length >= 35,
			undeclared: keys.filter((key) => !declared.has(key))
		}).toStrictEqual({ keysRead: true, undeclared: [] });
	});
});
