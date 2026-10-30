import { afterEach, describe, expect, it, vi } from 'vitest';
import { RE2JS } from 're2js';
import { isSafeRegexPattern } from './regex';
import { filterTransactionsByQuery, isValidRegexQuery } from '../transactions/search';
import {
	findMatchingCategoryRule,
	isSafeRegexPattern as isSafeRulePattern
} from '../categorization/rules';

// F4. The cost of an RE2 match grows with the compiled program, and counted repetition is the
// only construct that grows the program past what the pattern's own length can spell out
// (`a{1000}` is 7 characters and 1002 instructions). Measured in
// docs/superpowers/2026-10-30-f4/: no brace-free 120-character shape exceeded 1.69 times its
// length (`()*`, five instructions for three characters), so a ceiling of twice the length
// limit refuses only the inflation.

const programSize = (pattern: string) =>
	RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE).programSize();

const fill = (unit: string, length: number) => unit.repeat(Math.floor(length / unit.length));

// Brace-free shapes, including the ones that emit more than one instruction per character
// (captures add two each, and `()*` repeated is the largest measured).
const BRACE_FREE_UNITS = [
	'a',
	'()',
	'()*',
	'(|a)',
	'(a|)',
	'(a*)*',
	'.',
	'\\pL',
	'a|',
	'(?:a)?',
	'[ab]'
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe('program-size ceiling at validation', () => {
	it('places its boundary at twice the length limit, for search (120) and rules (80)', () => {
		expect.assertions(8);

		// Fixture check: `a{n}` compiles to n + 2 instructions, so these sit on the boundary.
		expect(programSize('a{238}')).toBe(240);
		expect(programSize('a{158}')).toBe(160);

		expect(isValidRegexQuery('a{238}')).toBe(true);
		expect(isValidRegexQuery('a{239}')).toBe(false);
		expect(isSafeRulePattern('a{158}')).toBe(true);
		expect(isSafeRulePattern('a{159}')).toBe(false);
		// The shape measured at 7.6 s per 2000 rows before this change.
		expect(isValidRegexQuery('(?:a|aa){1,500}b')).toBe(false);
		expect(isSafeRulePattern('(?:a|b|ab|ba){1,250}c')).toBe(false);
	});

	it('never refuses a pattern that spells out its length without counted repetition', () => {
		const cases = [80, 120].flatMap((limit) =>
			BRACE_FREE_UNITS.map((unit) => ({ limit, pattern: fill(unit, limit) }))
		);
		expect.assertions(cases.length + 1);

		// The detector can detect: the largest brace-free shape is above length + 2, so a
		// ceiling at the length itself would refuse it.
		expect(programSize(fill('()*', 120))).toBeGreaterThan(122);
		for (const { limit, pattern } of cases) {
			expect({ pattern, accepted: isSafeRegexPattern(pattern, limit) }).toEqual({
				pattern,
				accepted: true
			});
		}
	});
});

describe('compiled once per pass, not once per row', () => {
	const labels = Array.from({ length: 500 }, (_, i) => ({ label: `CB AUCHAN ${i}` }));

	it('compiles a regex search once for a whole batch of rows', () => {
		expect.assertions(2);
		const compile = vi.spyOn(RE2JS, 'compile');

		const matched = filterTransactionsByQuery(labels, 'auchan \\d+', 'regex');

		expect(matched).toHaveLength(500);
		expect(compile).toHaveBeenCalledTimes(1);
	});

	it('compiles each regex rule once when the same rule list classifies many rows', () => {
		expect.assertions(2);
		const rules = [
			{
				name: 'r1',
				matchText: 'carrefour|lidl',
				targetCategory: 'A',
				enabled: true,
				isRegex: true
			},
			{ name: 'r2', matchText: 'monoprix', targetCategory: 'B', enabled: true, isRegex: false },
			{ name: 'r3', matchText: 'auchan \\d+', targetCategory: 'C', enabled: true, isRegex: true }
		];
		const compile = vi.spyOn(RE2JS, 'compile');

		const hits = labels.map((t) => findMatchingCategoryRule(t, rules)?.name);

		expect(hits.every((name) => name === 'r3')).toBe(true);
		expect(compile).toHaveBeenCalledTimes(2);
	});

	it('compiles per rule OBJECT, never shared by pattern text across rule lists', () => {
		expect.assertions(1);
		// Separates a per-pass cache from a process-wide one keyed by the pattern: the second
		// would let one user time whether another user's pattern had been compiled.
		const mine = {
			name: 'a',
			matchText: 'auchan',
			targetCategory: 'A',
			enabled: true,
			isRegex: true
		};
		const theirs = { ...mine };
		const compile = vi.spyOn(RE2JS, 'compile');

		findMatchingCategoryRule({ label: 'AUCHAN' }, [mine]);
		findMatchingCategoryRule({ label: 'AUCHAN' }, [theirs]);

		expect(compile).toHaveBeenCalledTimes(2);
	});
});

describe('the tested label is cut at 300 characters on every path', () => {
	const longLabel = `${'a'.repeat(400)}MATCH`;

	it('on the search batch path', () => {
		expect.assertions(2);

		expect(filterTransactionsByQuery([{ label: longLabel }], 'MATCH$', 'regex')).toEqual([]);
		// Calibration: the same pattern finds the same tail inside the bound.
		expect(filterTransactionsByQuery([{ label: 'aaaMATCH' }], 'MATCH$', 'regex')).toHaveLength(1);
	});

	it('on the rule path', () => {
		expect.assertions(2);
		const rule = {
			name: 'r',
			matchText: 'MATCH$',
			targetCategory: 'A',
			enabled: true,
			isRegex: true
		};

		expect(findMatchingCategoryRule({ label: longLabel }, [rule])).toBeNull();
		expect(findMatchingCategoryRule({ label: 'aaaMATCH' }, [rule])).toBe(rule);
	});
});

describe('a rule stored before the ceiling', () => {
	it('keeps matching, so an upgrade does not silently change how imports are classified', () => {
		expect.assertions(2);
		const stored = {
			name: 'old',
			matchText: 'x{200}',
			targetCategory: 'A',
			enabled: true,
			isRegex: true
		};

		expect(isSafeRulePattern(stored.matchText)).toBe(false);
		expect(findMatchingCategoryRule({ label: 'x'.repeat(250) }, [stored])).toBe(stored);
	});
});
