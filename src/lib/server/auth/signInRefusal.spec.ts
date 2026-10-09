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
 * `git ls-files`, which is what a fresh clone has. WHAT IT LOOKS FOR: a CALL of `logSignInFailed`,
 * which excludes its own definition. The calibration is the one real caller, found by the same
 * detector.
 */

const ROOT = process.cwd();
const CALL = /(?<!function )\blogSignInFailed\s*\(/;

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
	.split('\n')
	.filter((path) => /\.(ts|svelte)$/.test(path))
	.filter((path) => !/\.spec\.ts$|\.db-smoke\.ts$|\/paraglide\/|\/generated\//.test(path));

describe('a sign-in refusal is logged only through refuseSignIn', () => {
	it('reads the tree, and the detector finds the real caller and skips the definition', () => {
		expect({
			read: files.length > 100,
			caller: CALL.test(readFileSync(`${ROOT}/src/lib/server/auth/signInRefusal.ts`, 'utf8')),
			definition: CALL.test(readFileSync(`${ROOT}/src/lib/server/logging/authn.ts`, 'utf8'))
		}).toEqual({ read: true, caller: true, definition: false });
	});

	it('finds no other caller of logSignInFailed in src', () => {
		const callers = files.filter((path) => CALL.test(readFileSync(`${ROOT}/${path}`, 'utf8')));
		expect(callers).toEqual(['src/lib/server/auth/signInRefusal.ts']);
	});
});
