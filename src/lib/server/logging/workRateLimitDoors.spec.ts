import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every door that asks the IMPORT or BANK_SYNC_START limiter writes the refusal's line (#250 L4b).
 * The route logs, not the limiter (`rateLimit.spec.ts`, « the limiter module writes no log line »),
 * so a sixth door could ask and forget to log; this gate is what stops it.
 *
 * WHAT IT READS: every tracked `.ts` file under `src/` that is not a spec. WHAT IT LOOKS FOR: each
 * call of the two wrappers, and `logWorkRateLimited(` between that call and the next `return`,
 * which is the refusal's answer. The calibration is the count: five doors, three import and two
 * bank-sync, so a detector matching nothing fails the first test.
 */

const ROOT = process.cwd();
const CALL = /\b(isImportRateLimited|isBankSyncStartRateLimited)\(/g;

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
	.split('\n')
	.filter((path) => path.endsWith('.ts'))
	.filter((path) => !/\.spec\.ts$|\.db-smoke\.ts$|\/paraglide\/|\/generated\//.test(path))
	.filter((path) => path !== 'src/lib/server/auth/rateLimit.ts');

const doors = files.flatMap((path) => {
	const source = readFileSync(`${ROOT}/${path}`, 'utf8');
	return [...source.matchAll(CALL)].map((match) => {
		const after = source.slice(match.index);
		const refusal = after.slice(0, after.indexOf('return'));
		return { at: `${path}:${source.slice(0, match.index).split('\n').length}`, refusal };
	});
});

describe('every door asking a work-kind limiter logs the refusal', () => {
	it('reads the files and finds the five doors', () => {
		expect([files.length > 100, doors.length]).toEqual([true, 5]);
	});

	it('finds the log call before each refusal answers', () => {
		expect(
			doors.filter((door) => !door.refusal.includes('logWorkRateLimited(')).map((d) => d.at)
		).toEqual([]);
	});
});
