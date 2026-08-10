import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The effective category (manualCategory ?? category.name) is ONE decision, and it was written out
 * by hand EIGHT times across five files, beside a documented helper nobody was obliged to call.
 * Splits would have made it nine. That is precisely the duplicated-decision shape CLAUDE.md
 * records — the same shape as the detection-window clamps and the three copies of "which
 * transactions match the current filter", both of which had diverged silently before anyone looked.
 *
 * This asserts the expression exists in exactly one place. It is a source scan rather than a
 * behavioural test on purpose: no behavioural test can fail on a SECOND correct copy, and a second
 * correct copy is exactly what this protects against — every one of the eight was correct the day
 * it was written.
 *
 * Watched red before it was kept: it named all five files, by path. Two of the eight lived in
 * volume.spec.ts's naive oracles, which is the sharper case — an oracle that RETYPES the rule it
 * checks drifts by exactly the clause it forgets, and those two had already forgotten the sentinel
 * fallback. They stay independent of the code under test, since the SQL path they audit compares
 * manualCategoryKey/categoryId and never calls this helper.
 */

const ROOT = 'src';
const HELPER = join('src', 'lib', 'server', 'transactions', 'nature.ts');
const SELF = join(
	'src',
	'lib',
	'server',
	'transactions',
	'effective-category-single-source.spec.ts'
);

// `x.manualCategory ?? x.category` in any spelling. Deliberately not anchored on `.name`, so a
// copy that reached for `.name ?? SENTINEL` or destructured differently is still caught.
const HAND_ROLLED = /manualCategory\s*\?\?\s*\w+\.category/;

/**
 * FILES, not entries, and the distinction is not pedantry — it is what stopped this scan crashing
 * for a reason that has nothing to do with its subject.
 *
 * `vitest-browser` writes a failing browser test's screenshot to
 * `<spec dir>/__screenshots__/<spec file name>/…`, and that middle segment is the spec's FILE NAME,
 * `.ts` included. So the moment any component spec under `src/` goes red, a DIRECTORY called
 * `page.svelte.spec.ts` appears, this scan matches it on the extension, and `readFileSync` throws
 * `EISDIR: illegal operation on a directory, read`.
 *
 * Measured: one font-dependent pixel assertion failed in CI, and this file — five directories away,
 * about a completely different rule — went red beside it with an error naming no path at all. A
 * guard that manufactures a second, unrelated-looking failure out of the first is worse than no
 * guard, because the second one is what the next reader spends their time on.
 *
 * `withFileTypes` removes the whole class rather than excluding `__screenshots__` by name, which
 * would only wait for the next tool to write a directory here.
 */
function typeScriptFilesUnder(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((path) => path.endsWith('.ts'))
		.filter((path) => !path.includes(`${join('database', 'generated')}`));
}

describe('the effective category', () => {
	it('is resolved through getEffectiveCategory and nowhere else', () => {
		expect.assertions(1);

		const offenders = typeScriptFilesUnder(ROOT)
			.filter((path) => path !== HELPER && path !== SELF)
			.filter((path) => HAND_ROLLED.test(readFileSync(path, 'utf8')));

		expect(offenders).toEqual([]);
	});

	it('has a helper to resolve it through, so the rule above is satisfiable', () => {
		expect.assertions(1);
		expect(readFileSync(HELPER, 'utf8')).toContain('export function getEffectiveCategory');
	});
});
