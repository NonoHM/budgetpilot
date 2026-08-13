/**
 * Shared machinery for the Phase 5 structural security scans.
 *
 * TEST-ONLY. Nothing in the running application imports this, and
 * `crypto-allowlist.spec.ts` asserts that, so the rule is enforced rather than requested. It
 * lives under `src/lib/server/` rather than in a new top-level directory purely so that the
 * gates already pointed at `src/` read it: `npm run check`, eslint and prettier all cover this
 * path today, and a new top-level directory would have to answer "which gate reads it" first.
 *
 * It exists because the second scan needed the same three primitives as the first, and two
 * copies of a matcher is where the two quietly stop agreeing. `credential-exposure.spec.ts`
 * carried them inline until this file existed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Production source under `src/`: no specs, no generated clients, no compiled messages.
 *
 * Specs are excluded because they mock the very APIs these scans look for, so including them
 * turns a guard into a list of exemptions. Measured on the credential scan: including specs took
 * the population from 15 to 97 and the apparent offenders from 0 to 76.
 *
 * `withFileTypes` for the reason recorded in
 * `src/lib/server/transactions/effective-category-single-source.spec.ts`: a failed browser test
 * writes a DIRECTORY named `<spec>.ts`, and a scan matching on extension alone then dies with
 * EISDIR in a file that has nothing to do with the real failure.
 */
export function productionSourceFiles(root = 'src'): string[] {
	return (
		readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => join(entry.parentPath, entry.name))
			.filter((path) => path.endsWith('.ts') || path.endsWith('.svelte'))
			.filter((path) => !path.includes(join('database', 'generated')))
			.filter((path) => !path.includes(join('lib', 'paraglide')))
			.filter(
				(path) =>
					!path.endsWith('.spec.ts') && !path.endsWith('.db-smoke.ts') && !path.endsWith('.test.ts')
			)
			// A test file is one that imports vitest, not one whose name matches a convention. Measured:
			// `banking/enablebanking/enablebanking.sandbox-validation.ts` opens with
			// `import { describe, expect, it } from 'vitest'` and matches none of the suffixes above, so
			// every scan built on this helper was reading a test file as production source. It changed no
			// verdict, and that is luck rather than design.
			.filter((path) => !/^import\s*\{[^}]*\}\s*from\s*'vitest'/m.test(readFileSync(path, 'utf8')))
	);
}

/**
 * Character ranges covered by a string or template literal, comments excluded, template
 * interpolations excluded.
 *
 * Needed because an identifier scan cannot tell a symbol from an English word inside a message,
 * and this codebase writes both. Measured on the outbound-containment scan: `\bfetch\b` matched
 * `[bank-sync] balance fetch failed for connection ...` and `Session has no accounts to fetch
 * transactions from`, two log strings, and both would have been reported as an unguarded outbound
 * client. Same family as the French article `des` matching 7 times in the crypto scan, one layer
 * over: there the word was in markup, here it is in a string.
 *
 * `${...}` inside a template is NOT treated as string, because it is code and an identifier
 * there is a real reference.
 *
 * Deliberately a PREDICATE rather than a blanking pass: `crypto-allowlist.spec.ts` reads string
 * literals on purpose, since the algorithm it checks IS a string argument. A helper that erased
 * them would break the scan that needs them most.
 */
export function stringLiteralRanges(source: string): [number, number][] {
	const ranges: [number, number][] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (ch === '/' && source[i + 1] === '/') {
			const end = source.indexOf('\n', i);
			i = end === -1 ? source.length : end;
			continue;
		}
		if (ch === '/' && source[i + 1] === '*') {
			const end = source.indexOf('*/', i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const start = i;
			i += 1;
			while (i < source.length && source[i] !== ch) {
				if (source[i] === '\\') i += 1;
				if (source[i] === '\n') break;
				i += 1;
			}
			ranges.push([start, i + 1]);
			i += 1;
			continue;
		}
		if (ch === '`') {
			let start = i;
			i += 1;
			while (i < source.length && source[i] !== '`') {
				if (source[i] === '\\') {
					i += 2;
					continue;
				}
				// An interpolation is code: close the run before it and reopen after.
				if (source[i] === '$' && source[i + 1] === '{') {
					ranges.push([start, i]);
					let depth = 1;
					i += 2;
					while (i < source.length && depth > 0) {
						if (source[i] === '{') depth += 1;
						else if (source[i] === '}') depth -= 1;
						i += 1;
					}
					start = i;
					continue;
				}
				i += 1;
			}
			ranges.push([start, i + 1]);
			i += 1;
			continue;
		}
		i += 1;
	}
	return ranges;
}

/** Whether an offset sits inside a string or template literal. */
export function isInStringLiteral(
	source: string,
	offset: number,
	ranges: [number, number][] = stringLiteralRanges(source)
): boolean {
	return ranges.some(([start, end]) => offset >= start && offset < end);
}

/** Character ranges covered by a block comment. */
export function blockCommentRanges(source: string): [number, number][] {
	return [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((match) => [
		match.index,
		match.index + match[0].length
	]);
}

/**
 * Whether an offset sits inside a comment.
 *
 * NOT defensive tidiness. Without it the credential scan reported `src/lib/server/auth.ts` as a
 * query fetching user rows wholesale, which would have been a finding against the published
 * assessment: the match was inside a JSDoc paragraph about a NUL-byte fix, prose describing a
 * `prisma.user.findUnique` that is not there. A scan that reads comments as code manufactures
 * findings, and a manufactured finding costs more than a missing one because somebody acts on it.
 */
export function isInComment(
	source: string,
	offset: number,
	blocks: [number, number][] = blockCommentRanges(source)
): boolean {
	if (blocks.some(([start, end]) => offset >= start && offset < end)) return true;
	const lineStart = source.lastIndexOf('\n', offset) + 1;
	return source.slice(lineStart, offset).includes('//');
}

/** The text of the call whose opening parenthesis follows `from`, brackets balanced. */
export function callTextAt(source: string, from: number): string {
	return balancedFrom(source, source.indexOf('(', from), '(', ')');
}

/** The balanced region starting at `open`, or '' when there is none. */
export function balancedFrom(source: string, open: number, first: string, last: string): string {
	if (open === -1) return '';
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === first) depth += 1;
		else if (source[i] === last) {
			depth -= 1;
			if (depth === 0) return source.slice(open, i + 1);
		}
	}
	return source.slice(open);
}

/** Reads a file as text. Kept here so a scan never reaches for `fs` directly. */
export function readSource(path: string): string {
	return readFileSync(path, 'utf8');
}
