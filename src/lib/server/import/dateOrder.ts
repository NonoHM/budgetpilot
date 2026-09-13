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
 * ## CALLED FROM EXACTLY ONE PLACE: `parseImportRows`, the door every parse path passes
 *
 * It ran with tests and no caller until #613, and the docstring that stood here said so, because
 * a tested function with no caller reads in six months as a function that works. What wired it is
 * `CsvProfileParser.dateColumns`: the door does not know which column holds the date, so each
 * profile declares its own as indices and the decision is taken once, over the right cells,
 * before any row is read. `mapped` declares through `mappedDateColumns`, which is the seventh
 * declaration and the only one the compiler does not force.
 *
 * The verdict does not reach `normalizeDate` directly. `decideDateOrder` turns it into a reading
 * or a refusal, and that reading is threaded to the profile as `dateOrder`.
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

/**
 * What a parse does about the order, once the column has been read.
 *
 * Two outcomes rather than four, because two of the verdicts arrive at the same place: a file
 * with nothing to decide and a file nobody has answered about are both READ, they simply differ
 * in whether anything could have said otherwise. Collapsing them here and not in
 * `DateOrderVerdict` is the point of having both types: the verdict is what the FILE says, the
 * decision is what the PARSER does, and only the second one has a default in it.
 */
export type DateOrderDecision =
	| { kind: 'read'; order: DateOrder }
	/** The column proved both readings. Carries both cells, because neither is wrong alone. */
	| { kind: 'refuse'; dayFirst: string; monthFirst: string };

/**
 * The file's verdict and the caller's override, resolved into one answer. THE ONE DEFINITION.
 *
 * ## The order is EVIDENCE FIRST, and that deviates from the ladder #613 wrote down
 *
 * #613 lists the explicit option first, « because it is the user's own answer ». Implemented as
 * written, that is wrong in two places, and both are the standing bar rather than a preference:
 *
 * **Over `resolved`.** A column containing `24/06/2026` PROVES day-first: 24 is not a month, so
 * this is not an inference that an answer can outrank, it is a fact about the bytes. An override
 * saying month-first there refuses that row loudly (month 24 is not a date) and silently moves
 * every ambiguous row beside it by up to eleven months. The stated rule is « where the file
 * proves an answer, use it », with no clause admitting an answer that contradicts the proof.
 *
 * **Over `mixed`.** A file proving BOTH readings has no true answer to give, so honouring an
 * override there imports half its rows wrong with the user's own answer as the alibi. No screen
 * can ask a question whose answers are both false.
 *
 * So the override applies where the rule says ASK, and nowhere else. That is what makes it an
 * override rather than configuration: it settles what the file leaves genuinely open, and it
 * cannot overrule what the file settles for itself. `types.ts` already said as much before this
 * function existed, in the sentence « the only thing that can settle a column the file leaves
 * genuinely ambiguous ».
 *
 * ## `nothing-to-decide` ignores the override, and that is not the same as day-first winning
 *
 * An ISO file has no cell either reading could disagree about, so there is nothing for an
 * override to apply TO. Reading it day-first and reading it month-first produce the identical
 * import. Returning the default rather than the override keeps the two indistinguishable, which
 * is what they are.
 *
 * Pure: no clock, no locale, no ambient state, so a decision is recomputable from the column it
 * was taken over. See `AGENTS.md` under « Code style ».
 */
export function decideDateOrder(
	verdict: DateOrderVerdict,
	override: DateOrder | undefined
): DateOrderDecision {
	// First, and deliberately before the override is even read: a contradiction is not a question.
	if (verdict.kind === 'mixed')
		return {
			kind: 'refuse',
			dayFirst: verdict.dayFirstEvidence,
			monthFirst: verdict.monthFirstEvidence
		};

	if (verdict.kind === 'resolved') return { kind: 'read', order: verdict.order };

	// The one branch an override can reach. `nothing-to-decide` falls past it to the default,
	// because there is no ambiguous cell for an answer to be about.
	if (verdict.kind === 'ambiguous' && override) return { kind: 'read', order: override };

	return { kind: 'read', order: DEFAULT_DATE_ORDER };
}
