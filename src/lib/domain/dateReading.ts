// TYPE ONLY, and it must stay type only, for the reason `columnDesignation.ts` states at its own
// head: this module is imported by the browser and `$lib/server` is not. A type import is erased
// before the bundler sees it; a VALUE import of anything from that module would pull server code
// into the client bundle, and this repository has one expensive instance of a domain module
// reaching across that line and failing at container startup after every gate had passed.
import type { ColumnDateState } from '$lib/server/import/columnDateState';

/**
 * THE TWO READINGS, as a value, because the set is read at run time as well as at compile time.
 *
 * `readDateOrderAnswer` validates an untrusted form field against this tuple, and a second spelling
 * of the pair is how the type a reader reasons about and the set a validator compares quietly stop
 * agreeing: a third reading added to a hand-written union would typecheck everywhere and be
 * silently unacceptable at the door. Derived in this direction, adding a member extends both at
 * once, and `refusalLabel.ts` has no default arm so the message catalogue fails to compile until
 * the new value is named there too.
 */
export const DATE_ORDERS = ['day-first', 'month-first'] as const;

/**
 * Which component a file writes first in an ambiguous `dd/mm/yyyy`-shaped date column.
 *
 * ## Why this is a type of its own rather than a boolean
 *
 * A `monthFirst: boolean` has three states in practice (true, false, and absent), and the absent
 * one is the interesting one: it means nobody has decided yet. Spelling the two readings out makes
 * the undecided state `null` at the answer level and keeps it distinguishable from `day-first`,
 * which is a DECISION that happens to agree with the default. #433 is a defect about a guess
 * presented as an answer, so the distinction is the point rather than a nicety.
 *
 * ## WHY THIS LIVES IN `domain/` WHILE THE DETECTION LIVES ON THE SERVER
 *
 * It moved here from `server/import/dateOrder.ts` when the designation screen gained a reading to
 * state: the screen has to know what the two readings ARE and which one applies when nobody has
 * answered, and it cannot value-import a server module to find out. Left there, the component held
 * its own copy of both facts, which is two definitions of one rule with a browser boundary between
 * them and nothing able to compare them.
 *
 * What stayed on the server is the part that needs a whole column: `detectDateOrder` reads every
 * cell of the declared date columns, and `decideDateOrder` turns a verdict plus an answer into a
 * reading or a refusal. Those are parse-time decisions over data the browser does not hold.
 */
export type DateOrder = (typeof DATE_ORDERS)[number];

/**
 * What a file is read as when nobody has said.
 *
 * Day-first, and it must stay day-first. Every statement this parser has read correctly since it
 * existed is day-first, and a default that moved would silently shift the dates of every file that
 * imports correctly today, which is #433 itself, arriving a second time through its own fix, in the
 * direction nobody is watching.
 */
export const DEFAULT_DATE_ORDER: DateOrder = 'day-first';

/**
 * A POSTED reading, validated into one, or `undefined` when the request carried no usable answer.
 *
 * ## The first client input in the import path that decides how a stored date is READ
 *
 * `row.date` is the second field of `contentFieldsOf`, joined into the hash stored under
 * `@@unique([userId, dedupeKeyHash])`, so this string decides the identity of every row the file
 * writes rather than the value of one column. That is why it is validated positively against the
 * closed set above and never cast, normalised or trimmed: a value this function does not recognise
 * is not repaired into one, because a repair is a guess about how to read somebody's money.
 *
 * ## `undefined` RATHER THAN A REFUSAL, and that is the load-bearing choice
 *
 * An absent, empty or hostile value falls back to the DERIVATION, which is what happens today for
 * every file: `decideDateOrder` reads the column's own evidence and only consults an answer where
 * the file leaves the question genuinely open. So a hand-made request naming this field cannot
 * change what a file that proves its order imports, and cannot turn an ordinary import into an
 * error either.
 *
 * ASVS 5.0 **v5.0.0-2.2.1** (L1, Validation and Business Logic > Input Validation), quoted inline
 * because `scripts/security/` is gitignored and a citation by path is unreadable to anyone who
 * clones this repository (#601): « Verify that input is validated to enforce business or functional expectations for that input. This should either use positive validation against an allow list of values, patterns, and ranges, or be based on comparing the input to an expected structure and logical limits according to predefined rules. »
 *
 * The identifier here was `v5.0.0-5.1.4` when this function was written, and NO SUCH REQUIREMENT
 * EXISTS: V5.1 holds V5.1.1 alone, which is about documenting permitted file types. The quoted
 * text was invented to match the invented number. Caught by reading the local source rather than
 * by any gate, which is what a gitignored reference costs.
 *
 * Exactly the shape of `hasHeaderRow`, which is the per-file parse decision this one follows: read
 * off a form field, honoured before the parse, and meaningless to the parser when absent.
 *
 * @param raw Whatever the request carried. `FormData.get` returns `string | File | null`, and the
 *   `File` branch is reachable from a hand-made multipart request, so the type here is `unknown`
 *   rather than `string | null`: narrowing at the call site would put the decision outside the one
 *   function that owns it.
 */
export function readDateOrderAnswer(raw: unknown): DateOrder | undefined {
	return DATE_ORDERS.find((order) => order === raw);
}

/**
 * The reading in force for a column in a given state, with the user's answer if they gave one.
 *
 * ## THIS IS THE SCREEN'S HALF OF A PRECEDENCE THAT `decideDateOrder` OWNS
 *
 * The parser decides the import; this decides what the designation row STATES. They must produce
 * the same reading for the same column or the screen displays a date the import will not write,
 * which is two of the standing bar's four triggers at once. `dateReadingAgreement.spec.ts` compares
 * the two over every state and every answer, driving both from the same cells, which is why this is
 * a function here rather than a `$derived` inside the component: a ladder inside a component can be
 * described and cannot be compared.
 *
 * ## The order is EVIDENCE FIRST, and the reason is on `decideDateOrder`
 *
 * A column containing `24/06/2026` PROVES day-first, and an answer cannot outrank a fact about the
 * bytes. `proven-shape` ignores the answer too, and that is not the same as day-first winning: an
 * ISO column has no cell either reading could disagree about, so there is nothing for an answer to
 * apply TO and the two readings produce the identical import.
 *
 * `inconsistent` has no reading at all on the parser's side, which refuses the file. It falls
 * through to the default here so this function is total, and the row never prints it: the screen
 * draws « Deux ordres de date dans cette colonne » for that state and no date beside it. The
 * agreement spec names `inconsistent` as the one state it cannot compare, and asserts that the
 * refusal set is exactly that.
 *
 * Pure: no clock, no locale, no ambient state. See `AGENTS.md` under « Code style ».
 */
export function readingForState(
	state: ColumnDateState | null,
	answer: DateOrder | null
): DateOrder {
	if (state === 'proven-month') return 'month-first';
	if (state === 'proven-day') return 'day-first';
	// The one state an answer can reach. Everything else falls past it to the default, because
	// everything else is either proved or has nothing for an answer to be about.
	if (state === 'ambiguous' && answer) return answer;
	return DEFAULT_DATE_ORDER;
}
