import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { productionSourceFiles } from './sourceScan';

/**
 * The structural half of "every sign-in exit goes through one definition": the query parameter
 * that carries the post-sign-in target is named in exactly one production file, `auth.ts`, which
 * reads it (`redirectAfterSignIn`) and writes it (`signInUrl`, `secondFactorUrl`). A route that
 * read the parameter itself could redirect to it without the check, and that is the defect this
 * catches.
 *
 * What it does NOT catch: a reader that never spells the name, such as one iterating every query
 * parameter. The behavioural half, `src/routes/login/sign-in-exits.spec.ts`, drives each exit with
 * the bypass corpus and is the check that does not depend on spelling.
 *
 * The population is `.ts` and `.svelte` under `src/` (`productionSourceFiles`); a `.js` file there
 * is not read. Specs are excluded, since they set the parameter to drive the routes.
 *
 * NO comment exemption. Two versions classified comment lines with a regex, and each was evaded by
 * a reader written on a line that also carries a comment (after `/* x *\/`, then after ` * x *\/`).
 * Every line naming the parameter outside `auth.ts` fails, except ONE, matched by the hash of its
 * whole text, so code added to it is not exempt and a change to it fails the second test below.
 */

const PARAMETER = /\bredirectTo\b/;
const CORPUS_IMPORT = /redirectBypasses/;

/** The single exempt line: a comment quoting a measured response that carries the parameter. */
const EXEMPT = {
	path: 'src/routes/transactions/split-save-failure.ts',
	sha256: '440fa61ecad6ca98d29652164745bd66a5368ae5637a52491dff3a19a4542b40'
};

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/** Every `path:line` naming the parameter, outside `auth.ts`, other than the exempt line. */
function namingOutsideAuth(paths: readonly string[]): string[] {
	return paths
		.filter((path) => path !== 'src/lib/server/auth.ts')
		.flatMap((path) =>
			readFileSync(path, 'utf8')
				.split('\n')
				.flatMap((line, index) =>
					PARAMETER.test(line) && !(path === EXEMPT.path && sha256(line) === EXEMPT.sha256)
						? [`${path}:${index + 1}`]
						: []
				)
		)
		.sort();
}

const files = productionSourceFiles();

describe('the sign-in redirect parameter', () => {
	it('reads a population large enough to mean something', () => {
		console.log(`[redirect-param] production files read: ${files.length}`);
		expect(files.length).toBeGreaterThan(300);
	});

	it('is named in auth.ts and on no other production line but the exempt one', () => {
		expect(files).toContain('src/lib/server/auth.ts');
		expect(PARAMETER.test(readFileSync('src/lib/server/auth.ts', 'utf8'))).toBe(true);
		expect(namingOutsideAuth(files)).toEqual([]);
	});

	it('still finds the exempt line unchanged, so the exemption cannot outlive its reason', () => {
		const lines = readFileSync(EXEMPT.path, 'utf8').split('\n');
		expect(lines.filter((line) => sha256(line) === EXEMPT.sha256)).toHaveLength(1);
	});

	it('takes its test corpus from a file no production code imports', () => {
		const importing = files.filter(
			(path) =>
				!path.endsWith('redirectBypasses.ts') && CORPUS_IMPORT.test(readFileSync(path, 'utf8'))
		);
		expect(importing).toEqual([]);
	});
});
