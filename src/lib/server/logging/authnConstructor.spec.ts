import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from './events';
import { EVENT } from './names';

/**
 * `logging/authn.ts` is the only code that builds an authentication event (L3). The claim matters
 * because the helper is where the pseudonyms are taken: a route building an event itself could put
 * a raw address or user id under a pseudonym's name, and the event types alone would not stop it,
 * since a brand is a cast away. This gate turned the claim from a convention into a check (second
 * contradiction pass on L3).
 *
 * WHAT IT READS: every tracked `.ts` and `.svelte` file under `src/` that is not a spec, through
 * `git ls-files`, which is what a fresh clone has. WHAT IT LOOKS FOR: the `EVENT` key or the wire
 * name of each event the registry marks `security: true`, which are the authentication
 * events and `crypt_decrypt_fail` (#904), which carries the user pseudonym too. The calibration is
 * the real constructor: `authn.ts` must be found by the same detector.
 */

const ROOT = process.cwd();
const ALLOWED = new Set([
	'src/lib/server/logging/authn.ts',
	'src/lib/server/logging/events.ts',
	'src/lib/server/logging/names.ts'
]);

const securityEvents = Object.entries(REGISTRY)
	.filter(([, spec]) => spec.security)
	.map(([name]) => name);
const keys = Object.entries(EVENT)
	.filter(([, name]) => securityEvents.includes(name))
	.map(([key]) => key);

function mentions(source: string): string[] {
	return [
		...keys.filter((key) => new RegExp(`\\b(?:E|EVENT)\\.${key}\\b`).test(source)),
		...securityEvents.filter((name) => source.includes(`'${name}'`) || source.includes(`"${name}"`))
	];
}

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
	.split('\n')
	.filter((path) => /\.(ts|svelte)$/.test(path))
	.filter((path) => !/\.spec\.ts$|\.db-smoke\.ts$|\/paraglide\/|\/generated\//.test(path));

describe('the authentication events have one constructor', () => {
	it('reads the files and the events it is about', () => {
		expect([files.length > 100, securityEvents.length, keys.length]).toEqual([true, 11, 11]);
	});

	it('finds the real constructor with the same detector (calibration)', () => {
		const constructor = readFileSync(`${ROOT}/src/lib/server/logging/authn.ts`, 'utf8');
		expect(mentions(constructor).length).toBe(11);
	});

	it('finds no authentication event built anywhere else in src', () => {
		const elsewhere = files
			.filter((path) => !ALLOWED.has(path))
			.flatMap((path) =>
				mentions(readFileSync(`${ROOT}/${path}`, 'utf8')).map((hit) => `${path}: ${hit}`)
			);
		expect(elsewhere).toEqual([]);
	});
});
