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
 * Specs are excluded by `productionSourceFiles`, since they set the parameter to drive the routes.
 * Comment lines are excluded because they cannot read anything, and one of them quotes a measured
 * response that carries the name (`src/routes/transactions/split-save-failure.ts`).
 */

const PARAMETER = /\bredirectTo\b/;
const CORPUS_IMPORT = /redirectBypasses/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** Whether `path` names the parameter on a line that is code rather than comment. */
function namesParameterInCode(path: string): boolean {
	return readFileSync(path, 'utf8')
		.split('\n')
		.some((line) => PARAMETER.test(line) && !COMMENT_LINE.test(line));
}

const files = productionSourceFiles();

describe('the sign-in redirect parameter', () => {
	it('reads a population large enough to mean something', () => {
		console.log(`[redirect-param] production files read: ${files.length}`);
		expect(files.length).toBeGreaterThan(300);
	});

	it('is named in auth.ts and in no other production file', () => {
		const naming = files.filter(namesParameterInCode).sort();
		expect(naming).toEqual(['src/lib/server/auth.ts']);
	});

	it('takes its test corpus from a file no production code imports', () => {
		const importing = files.filter(
			(path) =>
				!path.endsWith('redirectBypasses.ts') && CORPUS_IMPORT.test(readFileSync(path, 'utf8'))
		);
		expect(importing).toEqual([]);
	});
});
