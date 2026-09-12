/**
 * Which component a file writes first in an ambiguous `dd/mm/yyyy`-shaped date column.
 *
 * ## Why this is a type of its own rather than a boolean
 *
 * A `monthFirst: boolean` has three states in practice (true, false, and absent), and the
 * absent one is the interesting one: it means nobody has decided yet. Spelling the two readings
 * out makes the undecided state `undefined` at the option level and keeps it distinguishable
 * from `day-first`, which is a DECISION that happens to agree with the default. #433 is a defect
 * about a guess presented as an answer, so the distinction is the point rather than a nicety.
 *
 * ## Why it lives here and not in `types.ts`
 *
 * `src/lib/server/import/` already holds one module per property of the file that has to be
 * decided by looking at the file: `discriminant.ts`, `signIndicator.ts`, `splitAmount.ts`,
 * `columnBounds.ts`. The date order is the same kind of thing, so it joins them rather than
 * becoming another member of the parser's shared option bag. The detection that fills it in
 * belongs in this file too.
 */
export type DateOrder = 'day-first' | 'month-first';

/**
 * What a file is read as when nobody has said.
 *
 * Day-first, and it must stay day-first. Every statement this parser has read correctly since it
 * existed is day-first, and a default that moved would silently shift the dates of every file
 * that imports correctly today, which is #433 itself, arriving a second time through its own
 * fix, in the direction nobody is watching.
 */
export const DEFAULT_DATE_ORDER: DateOrder = 'day-first';

/**
 * The grammar of a date cell whose two leading components could each be a day or a month.
 *
 * **ONE definition, used by the detector below and by `normalizeDate`.** The two must agree on
 * what an ambiguous date is or they disagree about files: a cell the detector does not recognise
 * and the parser reads as a date is a cell whose order was never considered, which is #433 with
 * an extra step. Restating the pattern in either place is the copied-predicate shape this
 * repository already records, and it would drift the first time either gained a separator.
 *
 * `.` joins `/` and `-` for the reason `normalizeDate` gives at its own call: the dotted form is
 * the German, Swiss and Austrian convention, which is day-first without exception. It is in the
 * grammar because the parser accepts it, not because it is expected to be ambiguous in practice.
 *
 * No `g` flag, deliberately: a shared regex carrying `lastIndex` between callers would answer
 * differently depending on who tested it last.
 */
export const AMBIGUOUS_DATE_PATTERN = /^(\d{2})[/.-](\d{2})[/.-](\d{4})([\s\S]*)$/;

/**
 * What a column of date cells says about its own order.
 *
 * Four states, and the last two are separate on purpose. « Nothing to decide » is a file with no
 * ambiguous cell in it at all, an ISO export, and has no question to put to anyone.
 * « Ambiguous » is a file whose every cell reads both ways, which is a real question with no
 * answer in the bytes. Collapsing them would either interrogate a user about a file that cannot
 * carry the question, or guess at one that can.
 */
export type DateOrderVerdict =
	/** Some cell placed a component above 12, which names its own position. */
	| { kind: 'resolved'; order: DateOrder; evidence: string }
	/** Cells proved BOTH readings. The file cannot be read as a whole and is refused. */
	| { kind: 'mixed'; dayFirstEvidence: string; monthFirstEvidence: string }
	/** Ambiguous cells, no proof either way. The user is asked; nothing is guessed. */
	| { kind: 'ambiguous'; sample: string }
	/** No cell carries the ambiguous grammar. */
	| { kind: 'nothing-to-decide' };

/**
 * Which order a column of date cells is written in, or why that cannot be answered.
 *
 * ## NOTHING IN THE PARSER CALLS THIS YET. #613 wires it.
 *
 * Stated at the top because a tested function with no caller reads, in six months, as a function
 * that works: the tests are real, they pass, and nothing in them says whether anything downstream
 * asks the question. That is the falsified-comment class arriving in new code rather than in old,
 * and the only defence is to say so where a reader lands first.
 *
 * What that means concretely today: the order is whatever `CsvImportOptions.dateOrder` carries,
 * nothing sets that option, so every file is read day-first, and the `mixed` verdict below has no
 * producer even though `mixed-date-order` is a refusal code with a sentence in both catalogues.
 *
 * The reason it was not wired with the rest is in #613. In one line: the single door every parse
 * path passes is `parseImportRows`, and it does not know which column holds the date until a
 * profile resolves it, so wiring means the seven profiles declaring their date columns.
 *
 * **The rule is that a component above 12 cannot be a month, so it names its own position**, and
 * everything else follows from reading the WHOLE column rather than any one cell. That is the
 * difference between this and what the parser could do before: `normalizeDate` sees one value,
 * and one value carrying `06/01/2026` is two valid dates with nothing to separate them.
 *
 * ## A cell neither reading can place is not evidence
 *
 * `31/13/2026` puts a value above 12 in both positions, so it proves nothing about the order: it
 * is simply not a date. Counting it as evidence for both readings would turn an ordinary column
 * into a `mixed` refusal on the strength of one malformed cell. It falls through to the row
 * loop's ordinary `invalid-date`, which is where an unreadable cell belongs.
 *
 * ## Evidence is carried, not just the verdict
 *
 * Every branch that a user will eventually meet names a cell from their own file. A refusal or a
 * question that asserts a conclusion without showing the value it came from cannot be checked by
 * the person being asked, and this repository has measured the cost of showing someone a screen
 * whose evidence they cannot verify.
 *
 * @param values The cells of the file's date column, in file order. Pure: it reads no clock, no
 *   locale and no ambient state, so a stored verdict can always be recomputed from the same
 *   column. See `AGENTS.md` under « Code style ».
 */
export function detectDateOrder(values: readonly string[]): DateOrderVerdict {
	let dayFirstEvidence: string | undefined;
	let monthFirstEvidence: string | undefined;
	let ambiguousSample: string | undefined;

	for (const value of values) {
		const match = AMBIGUOUS_DATE_PATTERN.exec(value.trim());
		if (!match) continue;

		const first = Number(match[1]);
		const second = Number(match[2]);
		const firstCannotBeMonth = first > 12;
		const secondCannotBeMonth = second > 12;

		// Both above 12 places neither as a month: not a date, and not evidence.
		if (firstCannotBeMonth && secondCannotBeMonth) continue;

		if (firstCannotBeMonth) dayFirstEvidence ??= match[0];
		else if (secondCannotBeMonth) monthFirstEvidence ??= match[0];
		else ambiguousSample ??= match[0];
	}

	// Checked before either single answer: a file that proves both readings is refused rather
	// than read against whichever proof came first.
	if (dayFirstEvidence && monthFirstEvidence)
		return { kind: 'mixed', dayFirstEvidence, monthFirstEvidence };
	if (dayFirstEvidence) return { kind: 'resolved', order: 'day-first', evidence: dayFirstEvidence };
	if (monthFirstEvidence)
		return { kind: 'resolved', order: 'month-first', evidence: monthFirstEvidence };
	if (ambiguousSample) return { kind: 'ambiguous', sample: ambiguousSample };
	return { kind: 'nothing-to-decide' };
}
