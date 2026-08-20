import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadDefaultRuleCatalog } from './catalog';

/**
 * Three pages state how many rules ship and how many of them use a regular expression. All three
 * were wrong: **156** and **eleven** against a catalogue of **157** and **16**. The app's own
 * message says the true figure out loud — « 157 règle(s) suggérée(s) restaurée(s) » — so a user
 * who restores the defaults is told one number by the product and another by every page about it.
 *
 * The drift is nobody's lapse. A 2026-08-19 migration moved five rules to regex and there was
 * nothing anywhere that could notice; CLAUDE.md records the same conclusion about its own figures
 * — **a figure with no gate and no consumer has no reason to be right**. Correcting the three
 * pages without adding this test would leave exactly the condition that produced the drift.
 *
 * This is deliberately NOT an assertion that the catalogue has 157 rules. That figure is free to
 * change, and a test pinning it would redden on every added rule and be bumped mechanically —
 * the rubber stamp CLAUDE.md describes. What is asserted is that the DOCUMENTS AGREE WITH THE
 * CATALOGUE, which is a claim about consistency and stays true across every legitimate change.
 *
 * The numbers are read out of the prose rather than out of a data file on purpose: the prose is
 * what a reader believes, and a machine-readable sidecar would be a fourth place to drift.
 */

const CATALOGUE = loadDefaultRuleCatalog();
const TOTAL = CATALOGUE.length;
const REGEX = CATALOGUE.filter((entry) => entry.isRegex).length;

/** Digits, and the spelled-out forms these pages actually use. Extended when a page needs it. */
const WORD_NUMBERS: Record<string, number> = {
	eleven: 11,
	sixteen: 16,
	fifteen: 15,
	twelve: 12,
	seventeen: 17
};

function numbersIn(text: string): number[] {
	const digits = [...text.matchAll(/\b(\d{1,4})\b/g)].map((match) => Number(match[1]));
	const words = [...text.matchAll(/\b([A-Za-z]+)\b/g)]
		.map((match) => WORD_NUMBERS[match[1].toLowerCase()])
		.filter((value): value is number => value !== undefined);
	return [...digits, ...words];
}

/** The sentences that make a numeric claim about the catalogue, one entry per claim. */
const CLAIMS: { file: string; match: RegExp; expected: () => number; about: string }[] = [
	{
		file: 'README.md',
		match: /^.*ship with the app.*$/m,
		expected: () => TOTAL,
		about: 'how many rules ship'
	},
	{
		file: 'README.md',
		match: /^.*ship switched on.*$/m,
		expected: () => TOTAL,
		about: 'how many rules ship, in the known limitations list'
	},
	{
		file: 'docs/using/rules.md',
		match: /^.*BudgetPilot ships.*$/m,
		expected: () => TOTAL,
		about: 'how many rules ship'
	},
	{
		file: 'docs/using/rules.md',
		match: /^.*of the predefined rules use one.*$/m,
		expected: () => REGEX,
		about: 'how many use a regular expression'
	},
	{
		file: 'docs/reference/rules.md',
		match: /^.*predefined rules.*regular expression.*$/m,
		expected: () => TOTAL,
		about: 'how many rules ship'
	}
];

describe('the catalogue figures printed in the docs', () => {
	it.each(CLAIMS)('$file states $about correctly', ({ file, match, expected }) => {
		expect.assertions(2);

		const text = readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf8');
		const sentence = text.match(match)?.[0];

		// Without this the regex silently matching nothing would report a page as correct — the
		// failure mode CLAUDE.md records as an absence of output read as an absence of failures.
		expect(sentence, `no sentence in ${file} matched ${match}`).toBeDefined();
		expect(numbersIn(sentence as string)).toContain(expected());
	});

	it('states the regex count in the reference page, which pairs both figures in one sentence', () => {
		expect.assertions(2);

		const text = readFileSync(
			new URL('../../../../../docs/reference/rules.md', import.meta.url),
			'utf8'
		);
		const sentence = text.match(/^.*predefined rules.*regular expression.*$/m)?.[0];

		expect(sentence).toBeDefined();
		expect(numbersIn(sentence as string)).toContain(REGEX);
	});
});
