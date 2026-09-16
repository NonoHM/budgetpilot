import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { columnDateState } from './columnDateState';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * The three values `ambiguous-generic.csv` puts in its date column, in file order.
 *
 * Taken from the fixture rather than invented, per the ruling that replaced the plate's
 * unlocatable displacement figure. Both readings differ on every one of them: day-first gives
 * 1, 3 and 5 February, month-first gives 2 January, 2 March and 2 May.
 */
const AMBIGUOUS_CELLS = ['01/02/2026', '03/02/2026', '05/02/2026'];

describe('the per-column date state the designation screen reads', () => {
	/**
	 * Separates « a value above 12 in the FIRST position names its own place » from « the column
	 * is merely shaped like a date ». 24 cannot be a month, so the column proves day-first and no
	 * question exists.
	 */
	it('reports proven-day when a cell places a component above 12 first', () => {
		expect.assertions(1);
		expect(columnDateState(['24/06/2026', '13/05/2026', '06/01/2026'])).toBe('proven-day');
	});

	/** Separates the same proof in the SECOND position from the one above. */
	it('reports proven-month when a cell places a component above 12 second', () => {
		expect.assertions(1);
		expect(columnDateState(['06/24/2026', '05/13/2026'])).toBe('proven-month');
	});

	/**
	 * Separates « the bytes cannot answer, so a human must » from every state that needs no
	 * question. This is the only one of the seven that opens step 2.
	 */
	it('reports ambiguous when every cell reads both ways', () => {
		expect.assertions(1);
		expect(columnDateState(AMBIGUOUS_CELLS)).toBe('ambiguous');
	});

	/**
	 * Separates « one column proves BOTH orders, so no answer is right » from « the column is
	 * ambiguous, where one answer is ». A two-option question here would collect a false answer.
	 */
	it('reports inconsistent when one column proves both orders', () => {
		expect.assertions(1);
		expect(columnDateState(['24/06/2026', '06/24/2026'])).toBe('inconsistent');
	});

	/**
	 * THE VALUE THE FOUR VERDICTS CANNOT PRODUCE, and the reason this function exists rather than
	 * a switch over `DateOrderVerdict`.
	 *
	 * Separates « the format settles the order, so there is nothing to ask » from « the column has
	 * no dates in it ». `detectDateOrder` returns `nothing-to-decide` for BOTH, because neither
	 * carries a cell of the ambiguous grammar. An ISO column read as `no-dates` would put « Aucune
	 * date dans cette colonne » on a row whose column is nothing but dates.
	 */
	it('reports proven-shape for an ISO column, which asks nothing', () => {
		expect.assertions(1);
		expect(columnDateState(['2026-06-24', '2026-05-13', '2026-02-01'])).toBe('proven-shape');
	});

	/**
	 * Separates « content that is not dates » from « a column in the wrong position ». Two
	 * different repairs, which is why plate 7m gives them two sentences and two keys.
	 *
	 * Reading-independent by construction: no cell parses under EITHER reading, so stating it
	 * prejudges nothing about a question that has not been asked.
	 */
	it('reports no-dates when nothing in the column parses under either reading', () => {
		expect.assertions(1);
		expect(columnDateState(['CARD_PAYMENT', 'CARD_PAYMENT', 'TRANSFER'])).toBe('no-dates');
	});

	/** Separates a column empty on every row from one carrying content that is not dates. */
	it('reports empty when every cell is blank', () => {
		expect.assertions(1);
		expect(columnDateState(['', '   ', ''])).toBe('empty');
	});

	/**
	 * THE DIRECTION WE ARE NOT GOING, and it is 7a's whole reason for reading the column rather
	 * than the preview.
	 *
	 * Separates « the verdict was taken over the whole column » from « it was taken over the three
	 * values the picker shows ». The first three cells are ambiguous; row 40 settles it. A
	 * preview-sized read reports `ambiguous` and asks a question the file has already answered.
	 */
	it('does not report ambiguous when a cell beyond the preview settles the order', () => {
		expect.assertions(2);

		const column = [...AMBIGUOUS_CELLS, ...Array(36).fill('02/03/2026'), '24/06/2026'];
		expect(column).toHaveLength(40);
		expect(columnDateState(column)).toBe('proven-day');
	});

	/**
	 * A mixed column still reports `no-dates` only when NOTHING parses. One real date among the
	 * noise makes it a date column with bad rows, which the row loop reports per row.
	 *
	 * Separates « the column is not dates » from « the column is dates with refusals in it », and
	 * the two send the user to different repairs: step 1 for the first, the invalid-rows screen
	 * for the second.
	 */
	it('does not report no-dates when a single cell parses among values that do not', () => {
		expect.assertions(1);
		expect(columnDateState(['Mercerie Lafayette', 'CARD_PAYMENT', '2026-06-24'])).toBe(
			'proven-shape'
		);
	});

	/**
	 * THE STATE CARRIES NOTHING FROM THE FILE, asserted rather than documented.
	 *
	 * This value ships to the browser once per column with the designation offer, so it sits on the
	 * trust boundary: untrusted file bytes decide it. It is safe because it is a CLOSED SET OF
	 * CONSTANTS, and that is a property worth a test rather than a docstring, because the cheap
	 * future change is to make it carry its own evidence cell « so the row does not have to look it
	 * up » — which would put a second, unbounded copy of a user's cell into the payload beside the
	 * bounded one, and would do it silently.
	 *
	 * Separates « the returned value is one of seven constants » from « the returned value contains
	 * something the file put there ». The hostile cells are the ones this repository already knows
	 * about: a formula prefix, a NUL byte, a delimiter, and a cell far longer than any bound.
	 */
	it('returns one of seven constants and never any content from the cells', () => {
		expect.assertions(4);

		const states = [
			'proven-day',
			'proven-month',
			'proven-shape',
			'ambiguous',
			'inconsistent',
			'no-dates',
			'empty'
		];
		const hostile = [
			'=cmd|/c calc',
			`${String.fromCharCode(0)}=cmd`,
			'a|b|c',
			'X'.repeat(5010),
			'\t=SUM(A1)',
			'<script>alert(1)</script>'
		];

		// One column per reachable state, each with the hostile cells mixed in, so the claim is
		// about every branch of the mapping rather than about whichever one the cells happened to
		// reach. `inconsistent` and `empty` complete the set.
		const columns = [
			hostile,
			['24/06/2026', ...hostile],
			['06/24/2026', ...hostile],
			['03/04/2026', ...hostile],
			['2026-06-24', ...hostile],
			['24/06/2026', '06/24/2026', ...hostile],
			hostile.map(() => '')
		];
		const produced = columns.map((column) => columnDateState(column));

		expect(produced.every((state) => states.includes(state))).toBe(true);
		// No returned value contains any cell, nor any cell any returned value: the two vocabularies
		// are disjoint, which is what "carries nothing from the file" means operationally.
		expect(
			produced.some((state) => hostile.some((cell) => cell.includes(state) || state.includes(cell)))
		).toBe(false);
		// The planted positives, so neither zero above can be a silence: the probe really did
		// exercise distinct states over cells that really are hostile.
		expect(new Set(produced).size).toBe(states.length);
		expect(hostile.some((cell) => cell.length > 5000)).toBe(true);
	});

	/**
	 * THE ONE DEFINITION, asserted structurally rather than by hoping.
	 *
	 * The screen's « is this a date » and the row loop's must be the same predicate, or they
	 * disagree about the same column and the screen states what the import will not do. So no
	 * production module may compose `normalizeDate` with `isValidIsoDate` itself: the only place
	 * that pairing exists is `readDateCell`, and every caller goes through it.
	 *
	 * Paired with a planted positive, because an absence proves nothing on its own: the scan also
	 * counts the files that mention `isValidIsoDate` at all. Break the scan and that count
	 * collapses first.
	 */
	it('keeps one definition of "is this cell a date", composed in exactly one module', () => {
		expect.assertions(3);

		/**
		 * TRACKED **AND** UNTRACKED-BUT-NOT-IGNORED, and the second half is the whole guard.
		 *
		 * `git ls-files` alone is what a fresh clone has, which is the right set for a gate asking
		 * « what ships ». It is the WRONG set for this one, because the module most likely to
		 * introduce a second composition is a module that does not exist yet, and a new file is
		 * invisible to `ls-files` until it is committed. Measured 2026-09-16: breaking this guard by
		 * inlining `isValidIsoDate(normalizeDate(value))` into `columnDateState.ts`, which was new
		 * and uncommitted, left it GREEN at 10 passed. The break-check caught the guard, not the code.
		 *
		 * `--others --exclude-standard` adds exactly the files a contributor has written and not yet
		 * committed, and nothing that `.gitignore` covers, so a generated or local file cannot
		 * redden it.
		 */
		const listed = (args: string[]) =>
			execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

		const sources = [
			...listed(['ls-files', 'src/**/*.ts', 'src/**/*.svelte']),
			...listed(['ls-files', '--others', '--exclude-standard', 'src/**/*.ts', 'src/**/*.svelte'])
		].filter((path) => !path.includes('.spec.') && !path.includes('.db-smoke.'));

		/**
		 * Comment lines are stripped before the test, and that is not a convenience: a comment
		 * SAYING « not a local composition of normalizeDate and isValidIsoDate » is the opposite of
		 * a composition, and counting it would make the correct code fail its own gate.
		 */
		function code(path: string): string {
			return readFileSync(`${REPO_ROOT}${path}`, 'utf8')
				.split('\n')
				.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
				.join('\n');
		}

		const mentions = sources.filter((path) => code(path).includes('isValidIsoDate'));
		const composes = sources.filter(
			(path) => code(path).includes('isValidIsoDate') && code(path).includes('normalizeDate')
		);

		// The planted positive: the scan reads files and finds the symbol where it lives.
		expect(mentions.length).toBeGreaterThanOrEqual(2);
		expect(composes).toEqual(['src/lib/server/import/utils/csv.ts']);
		expect(sources.length).toBeGreaterThan(100);
	});
});
