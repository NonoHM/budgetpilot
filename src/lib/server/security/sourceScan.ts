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
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((path) => path.endsWith('.ts') || path.endsWith('.svelte'))
		.filter((path) => !path.includes(join('database', 'generated')))
		.filter((path) => !path.includes(join('lib', 'paraglide')))
		.filter(
			(path) =>
				!path.endsWith('.spec.ts') && !path.endsWith('.db-smoke.ts') && !path.endsWith('.test.ts')
		);
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
