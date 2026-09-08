import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every screen that prints a share of a whole goes through `apportionPercentages`, and this file
 * is the half of that which is enforced rather than remembered.
 *
 * The defect it guards against shipped at FIVE sites across two files, printing the same five
 * shares three times on one screen. A rule applied by hand at five sites is a rule that drifts,
 * and the drift is invisible: 51 % beside 50 % looks exactly like 51 % beside 49 %.
 *
 * Scanned through `git ls-files`, which is what a fresh clone has, so a file that exists only on
 * one machine can neither pass nor fail this.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The one place independent rounding is correct, allowlisted by its exact expression so that
 * adding a second is a decision somebody writes down here rather than a number that quietly goes
 * up.
 *
 * `formatPercentOrNa` renders the savings rate, which is ONE figure and not a member of a set. It
 * has no siblings to fail to add up with, and its `Math.round` is load bearing rather than
 * redundant: the rate can be negative, and `Math.round(-50.5)` is -50 while `Intl`'s halfExpand
 * gives -51, so removing it would move a figure on screen.
 */
const ALLOWED = ['formatPercent(Math.round(value * 100))'];

function trackedSvelte(): string[] {
	return execFileSync('git', ['ls-files', '*.svelte'], { cwd: REPO_ROOT, encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
}

describe('who is allowed to round a share', () => {
	/**
	 * Separates "no file rounds a share on its own" from "the scan matched no files at all". An
	 * empty list and a clean tree produce the same verdict otherwise, which is the failure this
	 * repository records more often than any other.
	 */
	it('reads a non-empty set of components', () => {
		expect.assertions(1);
		expect(trackedSvelte().length).toBeGreaterThan(30);
	});

	/**
	 * Separates "a share is apportioned against the whole it is a share of" from "a share is
	 * rounded on its own and the printed set adds up to whatever that gives".
	 */
	it('finds no component rounding a percentage inside formatPercent', () => {
		expect.assertions(1);

		const offenders = trackedSvelte().flatMap((path) =>
			readFileSync(`${REPO_ROOT}${path}`, 'utf8')
				.split('\n')
				.map((text, index) => ({ path, line: index + 1, text }))
				.filter((entry) => entry.text.includes('formatPercent(Math.round('))
				.filter((entry) => !ALLOWED.some((allowed) => entry.text.includes(allowed)))
				.map((entry) => `${entry.path}:${entry.line}`)
		);

		expect(offenders).toEqual([]);
	});
});
