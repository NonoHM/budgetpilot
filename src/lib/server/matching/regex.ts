import { RE2JS } from 're2js';

// RE2 (Google's regex engine, linear-time by construction: no backtracking, so no
// catastrophic-backtracking ReDoS is possible regardless of the pattern's shape).
// Replaces the previous JS RegExp + nested-quantifier heuristic, which only caught one
// shape of ReDoS (e.g. `(a+)+`) and stayed vulnerable to others (e.g. alternation overlap
// like `(a|a)+$`). re2js is a pure-JS port (no native binding, no WASM), consistent with
// the project's "no native binding" constraint for this migration.
//
// Trade-off accepted knowingly: RE2 does not support backreferences or lookahead. A
// hand-written regex rule relying on those (rare, advanced usage) will now fail to compile
// (isSafeRegexPattern -> false at creation/edit time) or fail to match (safeRegexTest ->
// false at evaluation time on already-stored data) instead of running.
export function isSafeRegexPattern(pattern: string, maxLength: number): boolean {
	if (pattern.length === 0 || pattern.length > maxLength) return false;
	try {
		RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
		return true;
	} catch {
		return false;
	}
}

// No longer needed for ReDoS safety (RE2 is linear-time regardless of input length), kept
// as a light bound on the work done per match for very long labels.
export const MAX_REGEX_TEST_INPUT_LENGTH = 300;

export function safeRegexTest(pattern: string, flags: string, value: string): boolean {
	try {
		const caseInsensitive = flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0;
		const compiled = RE2JS.compile(pattern, caseInsensitive);
		return compiled.matcher(value.slice(0, MAX_REGEX_TEST_INPUT_LENGTH)).find();
	} catch {
		return false;
	}
}
