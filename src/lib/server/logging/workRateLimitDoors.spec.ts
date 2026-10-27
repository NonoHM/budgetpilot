import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every door that asks the IMPORT or BANK_SYNC_START limiter writes the refusal's line (#250 L4b).
 * The route logs, not the limiter (`rateLimit.spec.ts`, « the limiter module writes no log line »),
 * so a sixth door could ask and forget to log; this gate is what stops it.
 *
 * WHAT IT READS: every tracked `.ts` file under `src/` that is not a spec, comments removed, so a
 * comment naming the call cannot stand in for it. WHAT IT LOOKS FOR: each call of the two wrappers,
 * and between that call and the next `return` (the refusal's answer) a `logWorkRateLimited` call
 * passing the KIND of the wrapper asked, so an import door logging a bank-sync refusal fails too. An
 * aliased import would hide a door from the name, so aliasing either wrapper fails on its own. The
 * calibration is the count: five doors, three import and two bank-sync.
 */

const ROOT = process.cwd();
const KIND = { isImportRateLimited: 'IMPORT', isBankSyncStartRateLimited: 'BANK_SYNC_START' };
const CALL = /\b(isImportRateLimited|isBankSyncStartRateLimited)\(/g;
const ALIAS = /\b(?:isImportRateLimited|isBankSyncStartRateLimited)\s+as\b/;

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
	.split('\n')
	.filter((path) => path.endsWith('.ts'))
	.filter((path) => !/\.spec\.ts$|\.db-smoke\.ts$|\/paraglide\/|\/generated\//.test(path))
	.filter((path) => path !== 'src/lib/server/auth/rateLimit.ts');

const sources = files.map((path) => ({
	path,
	code: readFileSync(`${ROOT}/${path}`, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '')
}));

const doors = sources.flatMap(({ path, code }) =>
	[...code.matchAll(CALL)].map((match) => {
		const after = code.slice(match.index);
		const refusal = after.slice(0, after.indexOf('return'));
		const kind = KIND[match[1] as keyof typeof KIND];
		return {
			at: `${path} (${match[1]})`,
			logged: refusal.includes(`logWorkRateLimited('${kind}'`)
		};
	})
);

describe('every door asking a work-kind limiter logs the refusal', () => {
	it('reads the files and finds the five doors', () => {
		expect([files.length > 100, doors.length]).toEqual([true, 5]);
	});

	it('finds the log call, with the kind asked, before each refusal answers', () => {
		expect(doors.filter((door) => !door.logged).map((door) => door.at)).toEqual([]);
	});

	it('finds no aliased import of either wrapper', () => {
		expect(sources.filter(({ code }) => ALIAS.test(code)).map(({ path }) => path)).toEqual([]);
	});
});
