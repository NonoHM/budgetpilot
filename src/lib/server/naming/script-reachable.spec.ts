import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What `scripts/normalize-names.mjs` reaches has to resolve, and has to be in the image.
 *
 * That script previews an irreversible change to financial data, and an operator is told to run it
 * before upgrading. It runs under Node's type stripping with no Vite, and the runtime stage ships
 * SOURCE, listed file by file, because `src/lib/server/database/` also holds spec files that have
 * no business in a production image. The Dockerfile says so in its own comment: adding an import to
 * any of those modules without adding the file there breaks the command silently, because nothing
 * else in the image loads them.
 *
 * **This has now cost three container builds, and the third is the one worth reading.** The first
 * two were a `$lib` specifier and a relative path at a file the image does not copy. The third was
 * this spec itself: it walked from `report.ts`, the module that had failed, so it reproduced that
 * failure's shape rather than the property. `report.ts` reaches four modules and the client is not
 * among them, so two new modules beside `client.ts` were reachable from the shipped command,
 * absent from the image, and green here. The entry point is now the SCRIPT.
 *
 * **The first two, in sequence, and each cost a container build to find.**
 * First a `$lib` specifier, which Vite resolves and Node does not: `ERR_MODULE_NOT_FOUND` on the
 * alias. Then the relative path that replaced it, pointing at a file the image does not copy:
 * `ERR_MODULE_NOT_FOUND` on the path. `npm run check`, 4000 unit tests, `lint:tracked` and a full
 * Playwright run were green for both.
 *
 * So this file asserts the two properties directly, from the entry point outward. `docker-smoke.sh`
 * remains the authority, since only it actually runs the thing; this is the cheap check that stops
 * a container build being the first thing to say no.
 *
 * The closure is walked rather than the directory listed, because both defects were one level down:
 * `report.ts` is in the naming subtree and `domain/money.ts` is not, and it is the imported file's
 * own imports and the imported file's own presence that decide whether the script starts.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * The SCRIPT, not a module it happens to import.
 *
 * This used to be `src/lib/server/naming/report.ts`, and that was the whole defect: the gate was
 * written the day `report.ts` broke and it reproduced THAT failure's shape rather than the general
 * property. `report.ts` reaches four modules and none of them is the client, so the walk missed
 * everything `createPrismaClient` pulls in, which is most of what the image copies. MEASURED: two
 * modules added beside `client.ts` were reachable from the shipped command, absent from the image,
 * green on `check`, green on 4013 unit tests, green on this very spec, and caught by
 * `docker-smoke.sh` alone.
 *
 * **A gate pointed at the module that failed last time tests the last failure.** The entry point is
 * whatever the operator actually runs, so that is what is named here.
 */
const ENTRY = 'scripts/normalize-names.mjs';

/**
 * Every `from '...'` specifier, type-only imports included. A type import is erased at run time and
 * cannot break the script by itself, but a value import of the same module is one edit away, and
 * the file still has to be in the image for the walk below to be honest about the edge.
 */
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
			// Anything else without a leading dot is a real package, which Node resolves itself.
			if (!specifier.startsWith('.')) continue;
			queue.push(relative(REPO_ROOT, join(REPO_ROOT, dirname(file), specifier)));
		}
	}

	return { files: [...seen], aliased };
}

/**
 * The `/app/...` paths the Dockerfile names as COPY sources, as whole tokens.
 *
 * Tokenised rather than substring-matched, and the calibration is why. The first version asked
 * whether the Dockerfile text CONTAINED `/app/src/lib/domain`, which is true of any file in that
 * directory: removing `money.ts` from the image left `normalize.ts` on the line above, its path
 * contains the directory as a prefix, and the check reported everything shipped. A detector that
 * cannot fail on the defect it was written for reports about itself.
 */
function copiedSources(dockerfile: string): Set<string> {
	return new Set(
		dockerfile
			.split(/\s+/)
			.filter((token) => token.startsWith('/app/'))
			.map((token) => token.replace(/\\$/, '').replace(/\/$/, '').slice('/app/'.length))
	);
}

/** Whether the runtime stage copies a path, as itself or inside a directory it copies whole. */
function shippedInImage(sources: Set<string>, file: string): boolean {
	let candidate = file;
	while (candidate !== '.' && candidate !== '') {
		if (sources.has(candidate)) return true;
		candidate = dirname(candidate);
	}
	return false;
}

describe('the modules the name-normalisation script reaches', () => {
	it('walks a closure big enough to be worth asserting over', () => {
		expect.assertions(1);

		// Without this, an entry point that failed to read would report a clean sweep over one file,
		// which is byte for byte what a correct closure reports.
		expect(relativeImportClosure(ENTRY).files.length).toBeGreaterThan(5);
	});

	it('imports nothing through an alias Node cannot resolve', () => {
		expect.assertions(1);

		const { aliased } = relativeImportClosure(ENTRY);
		expect(aliased, `alias imports reachable from ${ENTRY}: ${aliased.join(', ')}`).toEqual([]);
	});

	it('reaches nothing the runtime image leaves behind', () => {
		expect.assertions(1);

		const sources = copiedSources(readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8'));
		const missing = relativeImportClosure(ENTRY).files.filter(
			(file) => !shippedInImage(sources, file)
		);
		expect(
			missing,
			`reachable but not copied into the runtime stage: ${missing.join(', ')}`
		).toEqual([]);
	});
});
