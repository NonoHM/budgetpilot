import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvTransactions } from './csv';
import type { DateOrder } from './dateOrder';
import type { UntrustedColumnMapping } from './mapping/model';

/**
 * # What the tracked fixture corpus is required to EXHIBIT, asserted against the real parser.
 *
 * ## Why this file exists at all
 *
 * `scripts/synthetic/` is the substitute that makes the no-real-data rule keepable, and its output
 * is the denominator every date-order figure in this directory is quoted against. Nothing checked
 * that the corpus still contains the states those figures count. It cannot: the generator is a
 * script, the corpus is gitignored output, and the only thing standing between a well-meaning edit
 * and a silently degenerate corpus was a docstring.
 *
 * That is not hypothetical. The corpus could not produce an `ambiguous` column AT ALL until this
 * change, by construction rather than by observation, because `LEDGER` walks days 17 and 24 and a
 * component above 12 proves its own position. #624. Third instance in this repository of a search
 * over a space built in-house returning a well-formed zero that was unreachable by construction.
 *
 * ## THE PROPERTY, and why it is movement rather than the rule that reaches it
 *
 * An ambiguous fixture must do more than be shaped like a question. `detectDateOrder` takes
 * `ambiguousSample ??= match[0]`, so the FIRST ambiguous cell in file order becomes the evidence
 * a question screen puts in front of a user. `02/02/2026` is perfectly ambiguous and reads
 * identically under both answers, so a ledger opening on it would illustrate the question with
 * the one cell where the question does not matter.
 *
 * So the property asserted here is that **the two readings disagree on every row**. The generator
 * reaches it by keeping no day equal to its month, and that rule is deliberately NOT what is
 * asserted: it is one way to satisfy the property, and pinning it would pass a fixture that
 * satisfied the letter and lost the point.
 *
 * ## How the two readings are compared, and why nothing here re-states the detector
 *
 * `decideDateOrder` honours an explicit order ONLY over an `ambiguous` verdict: `resolved` and
 * `mixed` outrank it, and `nothing-to-decide` has nothing for it to apply to. So parsing one file
 * twice, once under each order, and asking whether any date moved is a SOUND test of ambiguity
 * taken entirely through the public entry point. `detectDateOrder` is never called here and
 * `dateColumnCells` is never re-stated, which is the copied-predicate shape this repository
 * records, in test infrastructure where nothing would notice it drifting.
 *
 * ## The zeros below are paired with positives taken by the same comparison
 *
 * `every other fixture holds still` is an absence assertion over 18 files, and an absence is what
 * this repository gets wrong most often: a comparison that cannot see movement and a corpus with
 * no movement in it emit the identical zero. The positive is the preceding test, which runs the
 * SAME comparison over the ambiguous fixtures and requires 18 moved rows. Break the comparison and
 * the positive collapses first.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Every file the tracked generators produce.
 *
 * An EXACT figure rather than a floor, deliberately, and it is the one place in this directory
 * where that is right: this is not a growing quantity, it is a fixed map in a script, and it is
 * the denominator #621 exists to settle. Adding a fixture should oblige the next person to state
 * the new denominator here rather than let it drift under a `toBeGreaterThan`.
 */
const CORPUS_FILE_COUNT = 30;

/** The fixtures whose every date must read both ways. See `AMBIGUOUS_LEDGER`. */
const AMBIGUOUS_FIXTURES = [
	'ambiguous-banque-populaire.csv',
	'ambiguous-revolut-fr.csv',
	'ambiguous-generic.csv'
];

/** Movements in `AMBIGUOUS_LEDGER`, so a row count below is a figure rather than a tautology. */
const AMBIGUOUS_LEDGER_ROWS = 6;

/** Movements in `LEDGER`. */
const LEDGER_ROWS = 8;

/**
 * The three fixtures that exist to exercise a REFUSAL, and are not statements.
 *
 * Named separately from the ambiguous ones because they are a different kind of object, and the
 * generator says so beside them: a search for a real-world producer of a file whose dates
 * contradict each other found none. The one mechanism the literature does name for a reordered
 * date column is a spreadsheet round trip, and that is not it either, because Excel writes a
 * converted date unpadded (`1/6/2026`) and `AMBIGUOUS_DATE_PATTERN` requires two digits. Measured.
 *
 * So these three are built to put `mixed` in front of the code that has to react to it. Nobody
 * should look for the bank that writes them.
 */
const REFUSAL_FIXTURES = [
	'mixed-across-columns-banque-populaire.csv',
	'mixed-within-column-generic.csv',
	'misdesignated-reference-column.csv'
];

/** Positional, because these files are designated by index rather than by name. */
function designate(
	columnCount: number,
	dateIndex: number,
	labelIndex: number,
	amountIndex: number
): UntrustedColumnMapping {
	return {
		matchBy: 'position',
		dateColumn: null,
		labelColumn: null,
		amountColumn: null,
		categoryColumn: null,
		dateIndex,
		labelIndex,
		amountIndex,
		categoryIndex: null,
		columnCount
	};
}

function refusalCodes(result: ReturnType<typeof parseCsvTransactions>): string[] {
	return result.invalidRows
		.filter((refusal) => refusal.scope.kind === 'file')
		.map((refusal) => refusal.fact.code);
}

let corpus: Map<string, string>;

function datesUnder(text: string, dateOrder: DateOrder): string[] {
	return parseCsvTransactions(text, { dateOrder }).transactions.map(
		(transaction) => transaction.date
	);
}

/** How many of this file's rows land on a different date under the other reading. */
function rowsThatMove(text: string): number {
	const dayFirst = datesUnder(text, 'day-first');
	const monthFirst = datesUnder(text, 'month-first');
	return dayFirst.filter((date, index) => date !== monthFirst[index]).length;
}

beforeAll(() => {
	const directory = mkdtempSync(join(tmpdir(), 'synthetic-corpus-'));
	execFileSync('node', [join(REPO_ROOT, 'scripts/synthetic/make-synthetic.mjs'), directory]);
	execFileSync('node', [join(REPO_ROOT, 'scripts/synthetic/make-opaque.mjs'), directory, '4']);

	corpus = new Map(
		readdirSync(directory)
			.filter((name) => name.endsWith('.csv'))
			.sort()
			.map((name) => [name, readFileSync(join(directory, name), 'utf8')])
	);
});

describe('the tracked generators produce the corpus the date-order figures are counted over', () => {
	/**
	 * Separates "the generators ran and wrote the corpus" from "the harness read an empty
	 * directory". Every figure below is meaningless without this line, and a generator that
	 * crashes would otherwise surface as a set of serene zeros.
	 */
	it('writes every fixture, from the tracked generators and nothing else', () => {
		expect.assertions(2);
		expect(corpus.size).toBe(CORPUS_FILE_COUNT);
		expect([...AMBIGUOUS_FIXTURES, ...REFUSAL_FIXTURES].filter((name) => corpus.has(name))).toEqual(
			[...AMBIGUOUS_FIXTURES, ...REFUSAL_FIXTURES]
		);
	});

	/**
	 * THE PROPERTY, and the planted positive for the absence assertion below.
	 *
	 * Separates "this fixture asks a question whose two answers differ on every row" from "this
	 * fixture is merely shaped like a question". The second passes an ambiguity check and hands a
	 * question screen a cell where both answers agree, which is the defect this corpus exists to
	 * avoid putting in a screenshot.
	 */
	it('makes every row of every ambiguous fixture move between the two readings', () => {
		expect.assertions(AMBIGUOUS_FIXTURES.length + 1);

		let moved = 0;
		for (const name of AMBIGUOUS_FIXTURES) {
			const rows = rowsThatMove(corpus.get(name) ?? '');
			moved += rows;
			expect({ name, rows }).toEqual({ name, rows: AMBIGUOUS_LEDGER_ROWS });
		}

		// The absolute figure the zero below is read against.
		expect(moved).toBe(AMBIGUOUS_FIXTURES.length * AMBIGUOUS_LEDGER_ROWS);
	});

	/**
	 * THE REGRESSION THIS WHOLE CHANGE CAN CAUSE. Separates "the second ledger left the first
	 * alone" from "a shared row builder now renders an existing fixture ambiguous too".
	 *
	 * Six corpus files are `resolved` and the rest have nothing to decide; in neither state can an
	 * explicit order change a single date. So a fixture that starts moving is a fixture that has
	 * become ambiguous, whoever meant it to.
	 */
	it('leaves every other fixture holding still under both readings', () => {
		expect.assertions(2);

		const moving = [...corpus]
			.filter(([name]) => !AMBIGUOUS_FIXTURES.includes(name) && !REFUSAL_FIXTURES.includes(name))
			.map(([name, text]) => ({ name, rows: rowsThatMove(text) }))
			.filter(({ rows }) => rows > 0);

		expect(moving).toEqual([]);
		// The denominator, so the zero above is a measurement rather than a silence.
		expect(corpus.size - AMBIGUOUS_FIXTURES.length - REFUSAL_FIXTURES.length).toBe(
			CORPUS_FILE_COUNT - AMBIGUOUS_FIXTURES.length - REFUSAL_FIXTURES.length
		);
	});

	/**
	 * `headerless.csv` and `wide.csv` were hand made and lived on one machine until #624. Both are
	 * now renderings of `LEDGER` like every other fixture, and these separate "the generator emits
	 * them" from "somebody's scratch directory still has them".
	 *
	 * The headerless one has no title row, which is its whole purpose: its FIRST LINE IS DATA, and
	 * a parse that assumes otherwise silently drops a transaction.
	 */
	it('emits a headerless fixture whose first line is a movement, not a title', () => {
		expect.assertions(2);

		const lines = (corpus.get('headerless.csv') ?? '').trim().split('\n');

		expect(lines).toHaveLength(LEDGER_ROWS);
		expect(lines[0].split(',')[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	/**
	 * THE DEFECT THE HAND-MADE `wide.csv` CARRIED, pinned so a regenerated one cannot carry it.
	 *
	 * Separates "this file is a rendering of the ledger" from "this file is one row pasted twelve
	 * times". The hand-made version filed all eight movements, salary included, under
	 * `Alimentation / Courses` and typed every one of them `Carte`, which is what a paste produces
	 * and no export does. Nothing was wrong with its dates or amounts, so nothing looked wrong.
	 */
	it('emits a wide opaque fixture whose middle columns vary with the movement', () => {
		expect.assertions(3);

		const lines = (corpus.get('wide.csv') ?? '').trim().split('\n');
		const body = lines.slice(1).map((line) => line.split(','));

		expect(lines[0].split(',')).toHaveLength(13);
		expect(new Set(body.map((cells) => cells[5])).size).toBeGreaterThan(1);
		expect(body.find((cells) => cells[1] === 'Salaire')?.[4]).toBe('Virement');
	});

	/**
	 * CAUSE A of #622: three declared date columns, two of which prove OPPOSITE orders.
	 *
	 * Separates "the file is refused and designating one column repairs it" from "the file is
	 * refused and there is nothing to be done". Both produce a byte-identical `mixed-date-order`
	 * fact today, which is the whole of #622: the refusal names a contradiction without naming
	 * where it is, so the screen cannot tell a repairable refusal from a dead end.
	 *
	 * This pins the CURRENT behaviour, defect included. #622's fix changes what the fact carries
	 * and must come through here.
	 */
	it('refuses a file whose declared date columns disagree, and yields to a designation', () => {
		expect.assertions(3);

		const text = corpus.get('mixed-across-columns-banque-populaire.csv') ?? '';
		const auto = parseCsvTransactions(text);

		expect(refusalCodes(auto)).toEqual(['mixed-date-order']);
		expect(auto.summary.validRows).toBe(0);

		// `Date operation` is column 10 and proves day-first on its own. Designating it is the
		// repair, and that is what makes this refusal a different object from the one below.
		const repaired = parseCsvTransactions(text, {
			profile: 'mapped',
			columnMapping: designate(13, 10, 1, 8)
		});
		expect(refusalCodes(repaired)).toEqual([]);
	});

	/**
	 * CAUSE B of #622: one declared column contradicting itself, and nothing left to try.
	 *
	 * Separates "designating repairs it" from "designating the same column again is the only move
	 * available and it changes nothing". This is the row `DESIGNATION_CANNOT_REPAIR` exists to
	 * prevent offering, and the one it cannot recognise today.
	 */
	it('refuses a file whose only date column contradicts itself, designation or not', () => {
		expect.assertions(2);

		const text = corpus.get('mixed-within-column-generic.csv') ?? '';

		expect(refusalCodes(parseCsvTransactions(text))).toEqual(['mixed-date-order']);
		expect(
			refusalCodes(
				parseCsvTransactions(text, { profile: 'mapped', columnMapping: designate(4, 0, 1, 2) })
			)
		).toEqual(['mixed-date-order']);
	});

	/**
	 * c2 of #622: the misdiagnosis. A file with a perfectly good ISO date column, refused whole
	 * because the user designated a REFERENCE column that happens to carry the ambiguous grammar.
	 *
	 * Separates "this file writes its dates in two orders" from "the column you chose does". The
	 * rendered sentence says the first and the second is true, which is a false statement about a
	 * user's own file. Both halves are pinned: the refusal on the wrong column, and the clean
	 * import that proves the file was never the problem.
	 */
	it('refuses the whole file when a reference column is designated, though column 1 is clean', () => {
		expect.assertions(3);

		const text = corpus.get('misdesignated-reference-column.csv') ?? '';

		const wrong = parseCsvTransactions(text, {
			profile: 'mapped',
			columnMapping: designate(4, 1, 2, 3)
		});
		expect(refusalCodes(wrong)).toEqual(['mixed-date-order']);
		expect(wrong.summary.validRows).toBe(0);

		const right = parseCsvTransactions(text, {
			profile: 'mapped',
			columnMapping: designate(4, 0, 2, 3)
		});
		expect(right.summary.validRows).toBe(LEDGER_ROWS);
	});

	/**
	 * #433's remainder, pinned on a real fixture rather than on a string built in a test.
	 *
	 * Separates "an ambiguous file imports silently under the default" from "it has acquired
	 * somewhere to go". Today every row imports, nothing is refused, and the dates are wrong if the
	 * file was written month-first. When the question screen lands, this reddens, and it should:
	 * `dateOrderQuestionAsleep.spec.ts` is the gate that says so and this is its fixture.
	 */
	it('still imports an ambiguous fixture silently under the day-first default', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(corpus.get('ambiguous-generic.csv') ?? '');

		expect(result.summary.validRows).toBe(AMBIGUOUS_LEDGER_ROWS);
		expect(result.summary.fileLevelRefusals).toBe(0);
		expect(result.transactions.map((transaction) => transaction.date)).toEqual([
			'2026-02-01',
			'2026-02-03',
			'2026-02-05',
			'2026-02-06',
			'2026-02-09',
			'2026-02-11'
		]);
	});
});
