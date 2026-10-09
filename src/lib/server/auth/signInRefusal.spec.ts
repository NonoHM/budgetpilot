import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * #876: a logged sign-in refusal is classified for the proxy header because `refuseSignIn` is the
 * only caller of `logSignInFailed`. A route calling the log constructor directly would write the
 * line and leave the header undecided, and the doors' unit specs would only notice for the outcomes
 * they drive. This turns « one call per refusal » from a convention into a check.
 *
 * WHAT IT READS: every tracked `.ts` and `.svelte` file under `src/` that is not a spec, through
 * `git ls-files`, which is what a fresh clone has. WHAT IT LOOKS FOR: any MENTION of the name, so an
 * aliased import or a bracket access is caught as well as a call. A route writing the event without
 * the constructor at all (`log({ event: E.authnLoginFail })`) is `authnConstructor.spec.ts`'s to
 * refuse. The calibration is the definition and the one real caller, found by the same detector.
 */

const ROOT = process.cwd();
const NAME = /\blogSignInFailed\b/;

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
	.split('\n')
	.filter((path) => /\.(ts|svelte)$/.test(path))
	.filter((path) => !/\.spec\.ts$|\.db-smoke\.ts$|\/paraglide\/|\/generated\//.test(path));

describe('a sign-in refusal is logged only through refuseSignIn', () => {
	it('reads the tree, and the detector finds the definition and the real caller', () => {
		expect({
			read: files.length > 100,
			caller: NAME.test(readFileSync(`${ROOT}/src/lib/server/auth/signInRefusal.ts`, 'utf8')),
			definition: NAME.test(readFileSync(`${ROOT}/src/lib/server/logging/authn.ts`, 'utf8'))
		}).toEqual({ read: true, caller: true, definition: true });
	});

	it('finds logSignInFailed named nowhere else in src', () => {
		const named = files.filter((path) => NAME.test(readFileSync(`${ROOT}/${path}`, 'utf8')));
		expect(named).toEqual([
			'src/lib/server/auth/signInRefusal.ts',
			'src/lib/server/logging/authn.ts'
		]);
	});
});
