import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVENT } from './names';

/**
 * Two gates over the shipped source for the authorization events (L4a contract, invariants 4 and 5).
 *
 * WHAT THEY READ: every tracked `.ts` and `.svelte` file under `src/` that is not a spec, a db-smoke,
 * the generated Paraglide catalogue or a generated client, through `git ls-files`, which is what a
 * fresh clone has. Same population as `authnConstructor.spec.ts`.
 *
 * (a) ONE CONSTRUCTOR. `logging/authz.ts` is the only code that builds `authz_fail` or `authz_admin`,
 * because it is where the pseudonyms are taken: a route building the event itself could put a raw id
 * under a pseudonym's name. The calibration is the real constructor, found by the same detector.
 *
 * (b) THE 404 GATE. Every line answering `fail(404` or `error(404` is a refused reference unless it
 * says otherwise, so it must be preceded by the log call (same line, or the previous line of code,
 * skipping blank and comment-only lines) or carry `// authz-exempt: <reason>` on that line or in the
 * comment run directly above it. The detector is a pure function so the planted cases below run it
 * over known sources in this same file.
 */

const ROOT = process.cwd();

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
	.split('\n')
	.filter((path) => /\.(ts|svelte)$/.test(path))
	.filter((path) => !/\.spec\.ts$|\.db-smoke\.ts$|\/paraglide\/|\/generated\//.test(path));

const read = (path: string) => readFileSync(`${ROOT}/${path}`, 'utf8');

describe('the authorization events have one constructor (L4a invariant 5)', () => {
	const ALLOWED = new Set([
		'src/lib/server/logging/authz.ts',
		'src/lib/server/logging/events.ts',
		'src/lib/server/logging/names.ts'
	]);
	const KEYS = ['authzFail', 'authzAdmin'] as const;
	const WIRE = ['authz_fail', 'authz_admin'];

	/** The wire names of the authorization events a source builds, by key or by literal. */
	function mentions(source: string): string[] {
		const byKey = KEYS.filter((key) => new RegExp(`\\b(?:E|EVENT)\\.${key}\\b`).test(source)).map(
			(key) => EVENT[key] as string
		);
		const byLiteral = WIRE.filter(
			(name) => source.includes(`'${name}'`) || source.includes(`"${name}"`)
		);
		return [...new Set([...byKey, ...byLiteral])].sort();
	}

	it('reads the files and the two event names it is about', () => {
		expect([files.length > 100, KEYS.map((key) => EVENT[key])]).toEqual([true, WIRE]);
	});

	// Red until authz.ts builds both events: the seam mentions neither. Separates « the detector can
	// see a constructor » from a detector that matches nothing and reports every file clean below.
	it('finds both events in the real constructor with the same detector (calibration)', () => {
		expect(mentions(read('src/lib/server/logging/authz.ts'))).toEqual([
			'authz_admin',
			'authz_fail'
		]);
	});

	it('finds no authorization event built anywhere else in src', () => {
		const elsewhere = files
			.filter((path) => !ALLOWED.has(path))
			.flatMap((path) => mentions(read(path)).map((hit) => `${path}: ${hit}`));
		expect(elsewhere).toEqual([]);
	});
});

const LOG_CALL = /\blog(?:ReferenceRefused|RoleRefused)\(/;
const EXEMPT = /\/\/\s*authz-exempt:\s*\S/;
const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*)/;

/** Every 404 line of a source, and the ones neither guarded nor exempt, as 1-based line numbers. */
function scan404(source: string): { lines: number[]; unguarded: number[] } {
	const text = source.split('\n');
	const lines: number[] = [];
	const unguarded: number[] = [];
	text.forEach((line, index) => {
		if (!line.includes('fail(404') && !line.includes('error(404')) return;
		lines.push(index + 1);
		if (LOG_CALL.test(line) || EXEMPT.test(line)) return;
		let above = index - 1;
		while (above >= 0 && (text[above].trim() === '' || COMMENT_ONLY.test(text[above]))) {
			if (EXEMPT.test(text[above])) return;
			above -= 1;
		}
		if (above >= 0 && LOG_CALL.test(text[above])) return;
		unguarded.push(index + 1);
	});
	return { lines, unguarded };
}

describe('every 404 in shipped src is a logged refusal or says why not (L4a invariant 4)', () => {
	// The planted positive and its pair, in the same file as the gate. Separates « the detector
	// reports an unguarded 404 » from one that reports nothing, and « it accepts each guard form »
	// from one that refuses everything.
	it('reports an unguarded 404 in a planted source (calibration)', () => {
		const planted = [
			'export const actions = {',
			'\tdelete: async () => {',
			'\t\tif (!row) return fail(404, {});',
			'\t}',
			'};'
		].join('\n');
		expect(scan404(planted)).toEqual({ lines: [3], unguarded: [3] });
	});

	it('accepts the log call on the previous code line, on the same line, and an exempt reason', () => {
		const planted = [
			'if (!row) {',
			'\tlogReferenceRefused(userId, "rule");',
			'',
			'\t// the answer the visitor sees',
			'\treturn fail(404, {});',
			'}',
			'if (!member) { logRoleRefused(userId); throw error(404, "x"); }',
			'// authz-exempt: admin power is unscoped by design',
			'if (!target) return fail(404, {});',
			'if (!other) return fail(404, {}); // authz-exempt: same reason',
			'// authz-exempt:',
			'if (!bare) return fail(404, {});'
		].join('\n');
		// The last one carries the marker with no reason, so it is still reported.
		expect(scan404(planted)).toEqual({ lines: [5, 7, 9, 10, 12], unguarded: [12] });
	});

	const scanned = files.map((path) => ({ path, ...scan404(read(path)) }));

	// The population the contract measured on main 356917d with its own grep command. A changed
	// figure means a 404 line was added or removed: read the diff before moving the number.
	it('reads every file and the 44 lines of the 404 class', () => {
		expect({
			filesRead: files.length > 100,
			lines404: scanned.reduce((sum, file) => sum + file.lines.length, 0),
			filesWith404: scanned.filter((file) => file.lines.length > 0).length
		}).toEqual({ filesRead: true, lines404: 44, filesWith404: 12 });
	});

	it('finds no 404 line that is neither preceded by its log call nor exempt with a reason', () => {
		const offenders = scanned.flatMap((file) =>
			file.unguarded.map((line) => `${file.path}:${line}`)
		);
		expect(offenders).toEqual([]);
	});
});
