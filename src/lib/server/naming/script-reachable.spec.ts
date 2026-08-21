import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The modules `scripts/normalize-names.mjs` reaches must not import through `$lib`.
 *
 * That script is run by Node directly, under type stripping, with no Vite and therefore no alias
 * resolution: a `$lib/...` specifier anywhere in its import closure fails at startup with
 * `ERR_MODULE_NOT_FOUND`. The whole `naming/` subtree already writes relative imports WITH the
 * `.ts` extension for this reason, and that convention is the only thing enforcing it.
 *
 * **It was not enough.** A `$lib` import added to `report.ts` passed `npm run check`, the unit
 * suite, `lint:tracked` and a full Playwright run, and was caught by the docker smoke test, which
 * is the first gate in the chain that actually executes the script. This file moves that catch to
 * the cheapest place instead of leaving it to a container build.
 *
 * The closure is walked rather than the directory listed, because the defect was one level down:
 * `report.ts` is in the subtree and `domain/money.ts` is not, and it is the IMPORTED file's own
 * imports that decide whether the script starts.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ENTRY = 'src/lib/server/naming/report.ts';

/** Every `from '...'` specifier in a file, type-only imports included: they are erased, but a
 * value import of the same module is one edit away and the walk should see the edge. */
const SPECIFIER = /from\s+'([^']+)'/g;

function relativeImportClosure(entry: string): { files: string[]; aliased: string[] } {
	const seen = new Set<string>();
	const aliased: string[] = [];
	const queue = [entry];

	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);

		const source = readFileSync(join(REPO_ROOT, file), 'utf8');
		for (const match of source.matchAll(SPECIFIER)) {
			const specifier = match[1];
			if (specifier.startsWith('$')) {
				aliased.push(`${file} -> ${specifier}`);
				continue;
			}
			if (!specifier.startsWith('.')) continue; // a real package, resolved by Node
			queue.push(relative(REPO_ROOT, join(REPO_ROOT, dirname(file), specifier)));
		}
	}

	return { files: [...seen], aliased };
}

describe('the modules a Node script reaches', () => {
	it('walks a closure big enough to be worth asserting over', () => {
		expect.assertions(1);

		// Without this, an entry point that failed to read would report a clean sweep over one file.
		// The closure was 12 files when this was written; the bound is loose on purpose.
		expect(relativeImportClosure(ENTRY).files.length).toBeGreaterThan(5);
	});

	it('imports nothing through an alias Node cannot resolve', () => {
		expect.assertions(1);

		const { aliased } = relativeImportClosure(ENTRY);
		expect(aliased, `alias imports reachable from ${ENTRY}: ${aliased.join(', ')}`).toEqual([]);
	});
});
