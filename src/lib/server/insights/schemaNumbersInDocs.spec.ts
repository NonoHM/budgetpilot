import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { localLlmNumPredict, maxSerializedResponseChars } from './schema';

/**
 * `docs/reference/ai-model.md` prints two figures derived from the response schema: the worst-case
 * serialised length and the generation ceiling computed from it. Both were correct the day they
 * were written, and neither has a consumer, which is the condition CLAUDE.md records as producing
 * drift by doing nothing wrong.
 *
 * The drift is not hypothetical here and the evidence is three files away: `schema.ts`'s own
 * docstring still reads « the worst case is 2 142 characters » against a schema that now computes
 * 2 328, because that sentence recorded a measurement and nothing re-reads a justification. The
 * page added alongside this test would rot exactly that way, and worse, because its whole claim is
 * that the ceiling is DERIVED: a page saying « raising the schema's limits moves the ceiling
 * automatically » beside a stale number teaches the reader to trust a figure the code no longer
 * produces.
 *
 * This deliberately does NOT assert that the ceiling is 1060. That figure is free to move, and a
 * test pinning it would redden on every legitimate schema change and be bumped mechanically, which
 * is the rubber stamp the sibling `catalogNumbersInDocs.spec.ts` refuses for the same reason. What
 * is asserted is that THE PAGE AGREES WITH THE CODE, which stays true across every legitimate
 * change and fails only when they part company.
 *
 * Read out of the prose rather than out of a data file, for the sibling's reason: the prose is what
 * a reader believes, and a machine-readable sidecar would be one more place to drift.
 */

/** The sentences that make a numeric claim about the schema, one entry per claim. */
const CLAIMS: { file: string; match: RegExp; expected: () => number; about: string }[] = [
	{
		file: 'docs/reference/ai-model.md',
		match: /^.*Fits its answer in.*generated tokens.*$/m,
		expected: localLlmNumPredict,
		about: 'the generation ceiling, in the requirements table'
	},
	{
		file: 'docs/reference/ai-model.md',
		match: /^.*constant, computed at.*characters.*$/m,
		expected: maxSerializedResponseChars,
		about: 'the worst-case serialised length'
	},
	{
		file: 'docs/reference/ai-model.md',
		match: /^.*structure, giving.*$/m,
		expected: localLlmNumPredict,
		about: 'the generation ceiling, where it is derived'
	},
	{
		file: 'docs/reference/ai-model.md',
		match: /^.*truncates at.*tokens is not short of room.*$/m,
		expected: localLlmNumPredict,
		about: 'the generation ceiling, in the sentence about what truncation means'
	},
	{
		file: 'docs/reference/README.md',
		match: /^.*token ceiling comes from.*$/m,
		expected: localLlmNumPredict,
		about: 'the generation ceiling, in the reference index'
	}
];

/** Digits, with the spaces this prose uses as a thousands separator collapsed first. */
function numbersIn(text: string): number[] {
	const joined = text.replace(/(\d)[  ](\d)/g, '$1$2');
	return [...joined.matchAll(/\b(\d{1,6})\b/g)].map((match) => Number(match[1]));
}

describe('the schema figures printed in the docs', () => {
	it.each(CLAIMS)('$file states $about correctly', ({ file, match, expected }) => {
		expect.assertions(2);

		const text = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
		const sentence = text.match(match)?.[0];

		// Without this, a regex that silently matched nothing would report the page as correct,
		// which is an absence of output read as an absence of failures.
		expect(sentence, `no sentence in ${file} matched ${match}`).toBeDefined();
		expect(numbersIn(sentence as string)).toContain(expected());
	});
});
