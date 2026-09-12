import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * # DELETE THIS FILE WHEN YOU WIRE #613. It exists to be deleted, and to be read first.
 *
 * `detectDateOrder` has tests and no caller, and `mixed-date-order` is a refusal code with a
 * sentence in both catalogues and nothing that emits it. Both are asleep on purpose: the single
 * door every parse path passes, `parseImportRows`, does not know which column holds the date
 * until a profile resolves it, so wiring means the seven profiles declaring their date columns.
 * That is #613.
 *
 * ## Why this is a spec and not the three docstrings that already say it
 *
 * A docstring does not fire. This repository has recorded six instances of a comment asserting
 * something a later change made false, with nothing able to notice, and #597 is on the tracker
 * for exactly that class. The docstrings stay, because they explain WHY; this file is what makes
 * the explanation impossible to walk past, because wiring the function turns it red.
 *
 * So the failure is the feature. Whoever does #613 lands here, reads the paragraph above, and
 * deletes the file as a step of that change. Deleting it is correct and expected. Allowlisting a
 * new caller to keep it green is not: there is no allowlist here, deliberately.
 *
 * ## The planted positives, which are the whole reason this is trustworthy
 *
 * The same family as #616, which asks the general form of this: when nothing calls a thing, what
 * is it that notices. Here the answer is this file; there it is still open.
 *
 * Every assertion below is an ABSENCE, and an absence is the one thing this repository gets wrong
 * most often: a scan that reads nothing and a tree that contains nothing produce the identical
 * zero. So each zero is paired with a count taken by the SAME scan over the SAME file set of
 * something that is genuinely there. If the scan breaks, the positives collapse to zero and this
 * file fails on those lines, BEFORE any zero is reported as a finding.
 *
 * ## Two lessons from #587 are applied rather than repeated
 *
 * That issue records `apportionCallers.spec.ts` recognising ONE SPELLING in ONE FILE TYPE. So
 * this scan reads `*.ts` AND `*.svelte`, and it matches a bare identifier followed by `(`, which
 * Prettier cannot wrap and which no reformatting changes. Matching the identifier alone was tried
 * and is wrong: it counts the docstring in `types.ts` that NAMES `detectDateOrder` in prose as a
 * call site. Comment lines are dropped for the same reason.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Tracked source, which is what a fresh clone has: a file on one machine can neither pass nor
 *  fail this. Specs are excluded, because this is a question about PRODUCTION callers. */
function productionSources(): string[] {
	return execFileSync('git', ['ls-files', 'src/**/*.ts', 'src/**/*.svelte', 'src/*.ts'], {
		cwd: REPO_ROOT,
		encoding: 'utf8'
	})
		.split('\n')
		.filter(Boolean)
		.filter((path) => !path.includes('.spec.'));
}

/** Lines carrying `needle`, excluding comment lines and any file in `exclude`. */
function sites(needle: string, exclude: string[]): string[] {
	return productionSources()
		.filter((path) => !exclude.some((suffix) => path.endsWith(suffix)))
		.flatMap((path) =>
			readFileSync(`${REPO_ROOT}${path}`, 'utf8')
				.split('\n')
				.map((text, index) => ({ path, line: index + 1, text }))
				// A docstring naming the function is not a call. `types.ts` names it in prose.
				.filter(({ text }) => !text.trim().startsWith('*') && !text.trim().startsWith('//'))
				.filter(({ text }) => text.includes(needle))
				.map(({ path: file, line }) => `${file}:${line}`)
		);
}

describe('the date-order machinery is still asleep', () => {
	/**
	 * Separates "the scan read the tree" from "the scan read nothing". Every zero below is
	 * meaningless without this line.
	 */
	it('reads a non-empty set of production sources', () => {
		expect.assertions(1);
		expect(productionSources().length).toBeGreaterThan(300);
	});

	/**
	 * THE PLANTED POSITIVE for the caller scan. Separates "nothing calls `detectDateOrder`" from
	 * "this scan cannot find a call at all".
	 *
	 * A floor rather than an exact count, and the distinction is deliberate: this is a LIVENESS
	 * check on the instrument, not a budget on the tree. Any non-zero proves the scan finds calls,
	 * so the blind band a floor leaves is a band nobody is reading. An exact figure here would
	 * redden on an unrelated refactor and teach the next person to edit the number.
	 */
	it('finds the calls that do exist, so a zero below means something', () => {
		expect.assertions(2);
		expect(sites('normalizeDate(', ['import/utils/csv.ts']).length).toBeGreaterThanOrEqual(2);
		expect(
			sites('detectSignIndicatorColumn(', ['import/signIndicator.ts']).length
		).toBeGreaterThanOrEqual(2);
	});

	/**
	 * Separates "nothing in production calls the detector" from "it was wired and these docstrings
	 * now lie". Red here is the signal to delete this file, not to add an allowlist.
	 */
	it('finds no production caller of detectDateOrder', () => {
		expect.assertions(1);
		expect(sites('detectDateOrder(', ['import/dateOrder.ts'])).toEqual([]);
	});

	/**
	 * THE PLANTED POSITIVE for the refusal scan, and it is a different scan from the one above:
	 * a string literal rather than a call, so it needs its own proof that it can find one.
	 */
	it('finds the refusal facts that are constructed, so a zero below means something', () => {
		expect.assertions(1);
		expect(
			sites("'invalid-date'", ['import/refusals.ts', 'i18n/refusalLabel.ts']).length
		).toBeGreaterThanOrEqual(2);
	});

	/**
	 * Separates "no parser emits mixed-date-order" from "one does and the catalogue entry is no
	 * longer unreachable". `refusals.ts` declares the code and `refusalLabel.ts` renders it;
	 * neither is a producer, so both are excluded and everything else must be silent.
	 */
	it('finds nothing that emits the mixed-date-order refusal', () => {
		expect.assertions(1);
		expect(sites("'mixed-date-order'", ['import/refusals.ts', 'i18n/refusalLabel.ts'])).toEqual([]);
	});
});
