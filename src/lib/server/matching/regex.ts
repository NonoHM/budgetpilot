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
// (isSafeRegexPattern -> false at creation/edit time) or fail to match (regexMatches ->
// false at evaluation time on already-stored data) instead of running.
//
// Linear is not cheap: a match costs about program size x label length, and counted
// repetition is the one construct that grows the program past the pattern's own length
// (`a{1000}` is 7 characters and 1002 instructions). Brace-free patterns measured at most
// 1.69 times their length, so twice the length limit refuses only the inflation (F4,
// measurements in the PR). Applied at validation only: a stored rule keeps matching.
export function isSafeRegexPattern(pattern: string, maxLength: number): boolean {
	if (pattern.length === 0 || pattern.length > maxLength) return false;
	const compiled = compileRegex(pattern);
	return compiled !== null && compiled.programSize() <= 2 * maxLength;
}

// No longer needed for ReDoS safety (RE2 is linear-time regardless of input length), kept
// as a light bound on the work done per match for very long labels.
export const MAX_REGEX_TEST_INPUT_LENGTH = 300;

/** Case-insensitive, as every caller matches; null when the pattern does not compile. */
export function compileRegex(pattern: string): RE2JS | null {
	try {
		return RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
	} catch {
		return null;
	}
}

// `matcher().find()`, not the lazy-DFA `test()`: under the ceiling above, find's worst case
// measured 0.93 ms per row against 1.83 ms for test, whose DFA rebuilds states for every
// distinct label (`a.{236}c` over random `ab` labels). test only wins on programs the ceiling
// now refuses.
export function regexMatches(compiled: RE2JS | null, value: string): boolean {
	return compiled !== null && compiled.matcher(value.slice(0, MAX_REGEX_TEST_INPUT_LENGTH)).find();
}
