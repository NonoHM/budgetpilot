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
 * (b) THE 404 GATE. Every 404 answer is a refused reference unless it says otherwise: `fail(404`
 * and `error(404` with any whitespace, line breaks included, between the parenthesis and the status,
 * and `status: 404`. Each must be preceded by `logReferenceRefused(` (earlier on the same line, or
 * the previous line of code before the statement the 404 belongs to, skipping blank and comment-only
 * lines) or carry `// authz-exempt: <reason>` on that line or in the comment run directly above it.
 * Only `logReferenceRefused` guards a 404: `logRoleRefused` belongs to a 403, so a role refusal above
 * a 404 is reported (L4a design point 9). The detector is a pure function so the planted cases below
 * run it over known sources in this same file.
 *
 * THE KNOWN LIMIT. The gate reads lines, not control flow. A log call written UNCONDITIONALLY on the
 * line above an `if` whose body answers 404 on the same line (`logReferenceRefused(...); if (!row)
 * return fail(404, ...)`) passes it while logging every request, and so does a guard naming the wrong
 * kind. Neither is this gate's to catch: the per-site specs' negatives (an owned reference writes no
 * `authz_fail`) and their exact attribute assertions are what turn those red.
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

const LOG_CALL = /\blogReferenceRefused\(/;
const EXEMPT = /\/\/\s*authz-exempt:\s*\S/;
const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*)/;
/** A 404 answer, wherever its status sits: across a line break, or as a `status` property. */
const ANSWER_404 = /\b(?:fail|error)\(\s*404\b|\bstatus:\s*404\b/g;
/** A code line whose expression goes on into the next one: the 404 below it is the same statement. */
const CONTINUES = /[({[,]\s*$/;
/** A line that opens a block rather than continuing an expression, so the walk stops there. */
const OPENS_BLOCK = /\)\s*\{\s*$|=>\s*\{\s*$|^\s*(?:if|else|for|while|switch|try|catch|do|case)\b/;

/** Every 404 line of a source, and the ones neither guarded nor exempt, as 1-based line numbers. */
function scan404(source: string): { lines: number[]; unguarded: number[] } {
	const text = source.split('\n');
	const isCode = (index: number) => text[index].trim() !== '' && !COMMENT_ONLY.test(text[index]);
	// The line and column each match STARTS on, so a wrapped `error(\n 404` counts once, at `error(`.
	const starts = new Map<number, number>();
	for (const match of source.matchAll(ANSWER_404)) {
		const before = source.slice(0, match.index);
		const line = before.split('\n').length - 1;
		if (!starts.has(line)) starts.set(line, match.index - (before.lastIndexOf('\n') + 1));
	}
	const lines = [...starts.keys()].sort((a, b) => a - b);
	const unguarded = lines.filter((index) => {
		const line = text[index];
		if (EXEMPT.test(line) || LOG_CALL.test(line.slice(0, starts.get(index)))) return false;
		// Up to the line the statement starts on: a `status: 404` inside a wrapped object literal
		// belongs to the `return json(..., {` above it, and the guard comes before that line.
		let start = index;
		for (let above = index - 1; above >= 0; above -= 1) {
			if (!isCode(above)) continue;
			if (!CONTINUES.test(text[above]) || OPENS_BLOCK.test(text[above])) break;
			start = above;
		}
		if (start !== index && EXEMPT.test(text[start])) return false;
		let above = start - 1;
		while (above >= 0 && !isCode(above)) {
			if (EXEMPT.test(text[above])) return false;
			above -= 1;
		}
		return !(above >= 0 && LOG_CALL.test(text[above]));
	});
	return { lines: lines.map((index) => index + 1), unguarded: unguarded.map((index) => index + 1) };
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
			'if (!member) { logReferenceRefused(userId, "rule"); throw error(404, "x"); }',
			'// authz-exempt: admin power is unscoped by design',
			'if (!target) return fail(404, {});',
			'if (!other) return fail(404, {}); // authz-exempt: same reason',
			'// authz-exempt:',
			'if (!bare) return fail(404, {});'
		].join('\n');
		// The last one carries the marker with no reason, so it is still reported.
		expect(scan404(planted)).toEqual({ lines: [5, 7, 9, 10, 12], unguarded: [12] });
	});

	// Separates « a 404 whose status is on the next line is read » from a line matcher that never
	// sees it (the gate before design point 9): the guarded wrapped answer passes, the bare one is
	// reported, each once, at the line its call starts on.
	it('reads a 404 wrapped across lines, and reports the unguarded one (planted)', () => {
		const planted = [
			'if (!row) {',
			'\tlogReferenceRefused(userId, "rule");',
			'\treturn fail(',
			'\t\t404,',
			'\t\t{}',
			'\t);',
			'}',
			'if (!other)',
			'\terror(',
			'\t\t404, "x"',
			'\t);'
		].join('\n');
		expect(scan404(planted)).toEqual({ lines: [3, 9], unguarded: [9] });
	});

	// Separates « a `status: 404` answer is a 404 » from a matcher that knows only fail and error,
	// and « the guard is looked for above the statement » from one looked for inside the object.
	it('reads status: 404, inline and wrapped, guarded and not (planted)', () => {
		const planted = [
			'logReferenceRefused(userId, "tag");',
			'return new Response(null, { status: 404 });',
			'if (!x) {',
			'\tlogReferenceRefused(userId, "tag");',
			'\treturn json({}, {',
			'\t\tstatus: 404',
			'\t});',
			'}',
			'return json({}, {',
			'\tstatus: 404',
			'});'
		].join('\n');
		expect(scan404(planted)).toEqual({ lines: [2, 6, 10], unguarded: [10] });
	});

	// Separates « only logReferenceRefused guards a 404 » from the gate the red tests shipped, which
	// accepted logRoleRefused too: a role refusal is a 403's, so above a 404 it is REPORTED.
	it('reports a logRoleRefused above a 404, on the previous line and on the same line (planted)', () => {
		const planted = [
			'if (!member) {',
			'\tlogRoleRefused(userId);',
			'\tthrow error(404, "x");',
			'}',
			'if (!m) { logRoleRefused(userId); throw error(404, "x"); }'
		].join('\n');
		expect(scan404(planted)).toEqual({ lines: [3, 5], unguarded: [3, 5] });
	});

	const scanned = files.map((path) => ({ path, ...scan404(read(path)) }));

	// The population the contract measured on main 356917d with its own grep command, and the same
	// figure through this multi-line matcher: the tree's two wrapped `error(` calls answer 400 and
	// fail a stream, and no `status: 404` exists. A changed figure means a 404 was added or removed:
	// read the diff before moving the number.
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
