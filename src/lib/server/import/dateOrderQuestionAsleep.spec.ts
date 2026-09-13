import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsvTransactions } from './csv';

/**
 * # DELETE THIS FILE WHEN THE DATE-ORDER QUESTION SCREEN EXISTS. It exists to be deleted.
 *
 * ## What is still asleep after #613, and what is not
 *
 * #613 wired `detectDateOrder` at the single door and gave three of the four verdicts a
 * producer: `resolved` decides the reading, `mixed` refuses with `mixed-date-order`, and
 * `nothing-to-decide` takes the day-first default because there is nothing to decide.
 *
 * The fourth does not have one. The stated rule is « where the file exhibits the ambiguity but
 * proves nothing, ASK », and nothing in this application can ask: there is no
 * `ambiguous-date-order` refusal fact and no question screen. So an ambiguous column takes the
 * day-first default today, which is exactly what it did before #613, and that is an INTERIM
 * STATE rather than the rule being satisfied.
 *
 * ## Why this is a spec rather than the sentence in `decideDateOrder`
 *
 * A docstring does not fire. #613's predecessor, #617, was the same wager and it paid: it caught
 * its own wiring, on the run that wired it, failing on both of its absence assertions the moment
 * `parseImportRows` called the detector. A comment saying « interim » would have been read past.
 *
 * So the failure is the feature. Whoever builds the question lands here, reads this, and deletes
 * the file as a step of that change. Allowlisting the new code to keep it green is not: there is
 * no allowlist here, deliberately.
 *
 * ## The denominator, because a zero without one is not a measurement
 *
 * Measured 2026-09-13 over the synthetic corpus, regenerated in that run from
 * `scripts/synthetic/`: **24 files, 25 declared date columns, 6 resolved, 10 nothing-to-decide,
 * 8 files with no date column resolvable, and ZERO ambiguous and ZERO mixed.** The opaque and
 * headerless fixtures, which are the ones that reach the designation screen, all carry ISO dates,
 * so they are `nothing-to-decide` on the mapped path too.
 *
 * That is the honest state of this branch: **no real fixture reaches it.** Both new branches are
 * exercised only by files built to exercise them, and nobody should measure zero change on the
 * corpus and conclude the work was pointless. It means the corpus is European.
 *
 * ## The planted positives, which are what make the zeros below readable
 *
 * Every scan assertion here is an ABSENCE, and an absence is the thing this repository gets wrong
 * most often: a scan that reads nothing and a tree that contains nothing emit the identical zero.
 * So each zero is paired with a count, taken by the SAME scan over the SAME file set, of
 * something genuinely present. Break the scan and the positives collapse first.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Tracked source, which is what a fresh clone has. Specs excluded: this asks about PRODUCTION. */
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
function sites(needle: string, exclude: string[] = []): string[] {
	return productionSources()
		.filter((path) => !exclude.some((suffix) => path.endsWith(suffix)))
		.flatMap((path) =>
			readFileSync(`${REPO_ROOT}${path}`, 'utf8')
				.split('\n')
				.map((text, index) => ({ path, line: index + 1, text }))
				// A docstring naming a thing is not a use of it, and several here name it in prose.
				.filter(({ text }) => !text.trim().startsWith('*') && !text.trim().startsWith('//'))
				.filter(({ text }) => text.includes(needle))
				.map(({ path: file, line }) => `${file}:${line}`)
		);
}

describe('nothing can ask about an ambiguous date order yet', () => {
	/**
	 * Separates "the scan read the tree" from "the scan read nothing". Every zero below is
	 * meaningless without this line.
	 */
	it('reads a non-empty set of production sources', () => {
		expect.assertions(1);
		expect(productionSources().length).toBeGreaterThan(300);
	});

	/**
	 * THE PLANTED POSITIVE for the refusal scan. Separates "no `ambiguous-date-order` code exists"
	 * from "this scan cannot find a refusal code at all". `mixed-date-order` is its sibling and IS
	 * emitted now, which is what makes it the right positive: it proves the scan can see exactly
	 * the shape the assertion below says is absent.
	 *
	 * A floor rather than an exact count: this is a liveness check on the instrument, not a budget
	 * on the tree, so an exact figure would redden on an unrelated refactor and teach the next
	 * person to edit the number.
	 */
	it('finds the date-order refusal that DOES exist, so the zero below means something', () => {
		expect.assertions(1);
		expect(sites("'mixed-date-order'").length).toBeGreaterThanOrEqual(2);
	});

	/**
	 * Separates "nothing can refuse or ask about an ambiguous order" from "something can, and the
	 * paragraph at the top of this file is now false". Red here is the signal to delete this file.
	 */
	it('finds no ambiguous-date-order refusal anywhere', () => {
		expect.assertions(1);
		expect(sites("'ambiguous-date-order'")).toEqual([]);
	});

	/**
	 * THE PLANTED POSITIVE for the message scan, and it is a different scan from the one above: a
	 * message-catalogue accessor rather than a quoted code, so it needs its own proof of liveness.
	 */
	it('finds the date-order messages that DO exist, so the zero below means something', () => {
		expect.assertions(1);
		expect(sites('m.import_refusal_mixed_date_order').length).toBeGreaterThanOrEqual(1);
	});

	/**
	 * Separates "no screen asks the question" from "one does and this gate is stale". Any message
	 * key of that family appearing in production is the question arriving.
	 */
	it('finds no message asking the user which order their file uses', () => {
		expect.assertions(1);
		expect(sites('m.import_question_date_order')).toEqual([]);
	});

	/**
	 * The BEHAVIOURAL half, and it is the one a scan cannot give. Separates "an ambiguous column
	 * takes the day-first default silently" from "it has acquired somewhere to go". Either change
	 * to that branch reddens here: a refusal drops `validRows` to zero, and a question does too.
	 *
	 * This is #433's remainder stated as a test rather than as prose: three rows in, three rows
	 * out, nothing refused, and the dates are wrong if the file was written month-first. Nothing
	 * in the bytes can say which, and that is exactly why the screen is owed.
	 */
	it('still reads an ambiguous column day-first, silently, which is the part #433 keeps', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '06/01/2026,A,-1.00', '07/02/2026,B,-2.00'].join('\n')
		);

		expect(result.summary.validRows).toBe(2);
		expect(result.summary.fileLevelRefusals).toBe(0);
		expect(result.transactions.map((transaction) => transaction.date)).toEqual([
			'2026-01-06',
			'2026-02-07'
		]);
	});
});
