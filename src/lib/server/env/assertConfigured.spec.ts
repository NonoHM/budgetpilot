import { describe, expect, it } from 'vitest';
import { buildEnvironmentReport, collectEnvironmentProblems } from './assertConfigured';

// A fake check is the right unit here: what this module contributes is the COLLECTION, and using
// the nine real checks would make these cases a test of nine other modules instead.
const failing = (message: string) => () => {
	throw new Error(message);
};
const passing = () => {};

describe('collectEnvironmentProblems', () => {
	it('reports every failure, not the first', async () => {
		const problems = await collectEnvironmentProblems([
			['A', failing('A is wrong')],
			['B', passing],
			['C', failing('C is wrong')]
		]);
		expect(problems).toEqual(['A is wrong', 'C is wrong']);
	});

	// This is the whole point: four consecutive boots, each revealing one more variable. The
	// assertion is that the second boot never happens.
	it('does not stop at the first failure', async () => {
		const problems = await collectEnvironmentProblems([
			['A', failing('first')],
			['B', failing('second')],
			['C', failing('third')]
		]);
		expect(problems).toEqual(['first', 'second', 'third']);
	});

	it('awaits async checks', async () => {
		const problems = await collectEnvironmentProblems([
			['A', async () => Promise.reject(new Error('async failure'))],
			['B', failing('sync failure')]
		]);
		expect(problems).toEqual(['async failure', 'sync failure']);
	});

	it('names the check when something that is not an Error is thrown', async () => {
		const problems = await collectEnvironmentProblems([['WEIRD', () => Promise.reject('nope')]]);
		expect(problems).toEqual(['WEIRD: nope']);
	});

	it('returns nothing when every check passes', async () => {
		expect(
			await collectEnvironmentProblems([
				['A', passing],
				['B', passing]
			])
		).toEqual([]);
	});
});

describe('buildEnvironmentReport', () => {
	it('numbers every problem and keeps each message intact', () => {
		const report = buildEnvironmentReport(['first thing', 'second thing']);
		expect(report).toContain('1. first thing');
		expect(report).toContain('2. second thing');
	});

	it('states the count when there is more than one', () => {
		expect(buildEnvironmentReport(['a', 'b', 'c'])).toContain('3 configuration problems');
	});

	it('does not say "3 problems" when there is one', () => {
		expect(buildEnvironmentReport(['only'])).toContain('one configuration problem');
	});

	// Every individual message names a variable and none of them says which file it goes in.
	it('names where the values go', () => {
		expect(buildEnvironmentReport(['a'])).toMatch(/\.env/);
	});
});
