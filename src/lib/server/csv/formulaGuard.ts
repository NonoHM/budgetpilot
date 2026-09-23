/**
 * The one definition of "would a spreadsheet read this cell as a formula", and the guard for it.
 *
 * **THE RULE, in the sentence a reader can apply: test the first character a consumer will SEE,
 * not the first code unit present.**
 *
 * ## Why the anchored test alone is not that rule
 *
 * The test this replaces was `/^[=+\-@\t\r]/` against the raw value, in two byte-identical
 * copies. It reads the first code unit. A spreadsheet does not: it discards characters it
 * considers noise and reads what is left. Measured against files `buildTransactionsCsv` itself
 * produced, converted to XLSX and read as `<f>` elements out of `xl/worksheets/sheet1.xml`:
 *
 * ```
 * cal.xlsx     (planted positive, a bare =1+1)   FORMULA CELLS = 1
 * before.xlsx  (this writer with clause two off) FORMULA CELLS = 2   <f>1+1  <f>cmd;'/c calc' A1
 * after.xlsx   (this writer as it now stands)    FORMULA CELLS = 0
 * ```
 *
 * `before.xlsx` came from the REAL pre-fix writer, with clause two broken and restored in a
 * `finally`, rather than from a hand-reconstructed file. The planted positive is what makes the
 * zero a finding: a conversion that silently failed would report `after` as clean too.
 *
 * The same thing in ODS, which is where it was first seen: a label of U+0000 followed by `=1+1`
 * imports as `office:value-type="float" office:value="2"` carrying `table:formula="of:=1+1"`. So
 * the NUL is DISCARDED, the `=` is promoted to first position, and the cell is live. The anchored
 * test saw the NUL and never the `=` beside it.
 *
 * Measured in the same pass and worth recording because it cuts AGAINST the NFKC clause below:
 * neither the fullwidth `=` nor a zero-width space produced a formula in either format.
 *
 * **Enumerating the characters that do this is hopeless, which is why the rule is shaped as it
 * is.** Swept over the whole of Unicode: of 1 112 064 code points, **2 301 survive JavaScript's
 * `.trim()` sitting in front of an `=`**, and only **25** are removed, those 25 being exactly the
 * JS whitespace set. A fix shaped as "add U+0000 to the class" would be one of 2 301.
 *
 * ## The two clauses, and why the first is preserved verbatim
 *
 * `DANGEROUS_LEAD` is unchanged from the pattern this module replaces, deliberately, so that
 * nothing currently guarded can stop being guarded: the second clause only ever ADDS. That
 * matters most for the least interesting case. `-39,90` is not a formula and never was, and
 * **154 cells of the 1 727 in `scr/synthetic/out` open with `-`** (27 files, delimiter taken per
 * file from its own header row, measured 2026-09-19), so a repair that stopped quoting them would
 * be a visible regression on every French statement. The method is stated because a cell count
 * depends on it: an independent measurement the same day read 1 754 cells by splitting
 * differently and agreed on the 154.
 *
 * `\t` and `\r` stay in the class, and the reason is the half that is easy to get backwards.
 * They are unreachable in `sanitizeImportedText`, which trims before testing, so they look like
 * dead entries there. They are REACHABLE here, because `escapeCsvField` does not trim and a
 * restore writes stored labels with no sanitiser at all. Deleting them to tidy the dead copy
 * would have removed a live guard. They are also not decoration: OWASP added Tab (0x09) and
 * Carriage return (0x0D) to the dangerous list after Symfony's own tab PREFIX became the
 * vulnerability (CVE-2021-41270), which is why the prefix below is an apostrophe and not a tab.
 *
 * **The two clauses are not interchangeable and a break-check is what established it.** Clause
 * two strips `\t` as a control character and then sees whatever is behind it, so it subsumes
 * clause one for every value whose tab is followed by something dangerous. Clause one decides
 * alone in exactly one shape, a tab or CR followed by something SAFE, and until
 * `'\tCourses'` was added to the corpus, removing clause one entirely reddened NOTHING.
 *
 * The same two-clause shape was arrived at independently by Ruby's `csv-safe`, which tests the
 * raw first character and then the `lstrip`ped one, with a comment giving this exact reason. It
 * is the only implementation found that catches a leading NUL, and it catches it by accident,
 * because Ruby's `lstrip` counts `\x00` as whitespace and JavaScript's `trim` does not.
 *
 * **This class of bypass has a shipped CVE.** CVE-2026-9673 (json-2-csv, 2026-05-28) is a
 * leading-whitespace bypass of a `^`-anchored formula filter; the fix moved that library from
 * `/^[=+\-@\t\r]+/` to `/^[ \t\r]*[=+\-@\t\r]+/`, which would still not catch a NUL. The
 * pattern this module replaces is byte-identical to papaparse's, and equivalent to PHP League
 * CSV's and csv-stringify's, none of which preprocess at all.
 *
 * **Prefix, never strip.** USENIX WOOT '25 §7.1 argues the point directly: stripping changes the
 * value of a field whose content legitimately begins that way. `guardFormulaLead` therefore
 * leaves the value untouched and only prepends.
 *
 * ## What the standard asks for
 *
 * ASVS v5.0.0-1.2.10 (L3), quoted because `scripts/security/` is gitignored (#601): « Verify that
 * the application is protected against CSV and Formula Injection. The application must follow the
 * escaping rules defined in RFC 4180 sections 2.6 and 2.7 when exporting CSV content.
 * Additionally, when exporting to CSV or other spreadsheet formats (such as XLS, XLSX, or ODF),
 * special characters (including '=', '+', '-', '@', '\t' (tab), and '\0' (null character)) must
 * be escaped with a single quote if they appear as the first character in a field value. »
 *
 * The requirement names `'\0'` by hand, so #594 is this requirement's own example. Its other
 * half, RFC 4180 2.6 and 2.7, is the QUOTING, which is `escapeCsvField`'s job and not this
 * module's: a guard on the leading character does not stop a value closing its own cell. Both
 * halves are asserted in `exportCsv.spec.ts`.
 *
 * ## Where this is the control point and where it is defence in depth
 *
 * The requirement says « when exporting », and that is where the control belongs: three writers
 * reach a stored label (import, restore, bank connector) and exactly one path reaches a
 * spreadsheet. `exportCsv.ts` is that path. `sanitizeImportedText` calls this too, which is
 * worth having and is NOT the control: a label written by `backup/import.ts` never passes
 * through it.
 */

/**
 * The leading characters a spreadsheet may read as the start of a formula.
 *
 * Unchanged from the two copies this module replaces. Extending it is a decision about what a
 * consumer executes; `LEADING_IGNORABLE` below is a decision about what a consumer discards, and
 * the two are not the same question.
 */
const DANGEROUS_LEAD = /^[=+\-@\t\r]/;

/**
 * What a consumer may discard before it decides whether a cell is a formula.
 *
 * Control characters (Cc), format characters (Cf, which is every zero-width and bidi control),
 * and the three separator categories (Zs, Zl, Zp).
 *
 * **THIS SET IS A GENERALISATION FROM ONE MEASURED POSITIVE, and says so for the same reason the
 * NFKC clause below does.** Exactly one member has been observed reaching a live formula: U+0000,
 * in LibreOffice 26.8. Five others were put through the same oracle and came back inert text
 * (U+00A0, U+00AD, U+200B, U+FEFF, U+E0020). So most of this class is guarding against a
 * consumer nobody here has watched discard anything, on the reasoning that a consumer which
 * discards one control character is likely to discard its neighbours. Excel is untested: we have
 * no copy, and WOOT '25 measured per-application initiator sets that already differ (Excel
 * `= + @ -`, LibreOffice `=` alone), so per-application behaviour is the norm rather than the
 * exception.
 *
 * Combining marks (Mn, Mc, Me) are deliberately NOT here. An adversarial sweep put 2 262 cells
 * through LibreOffice, each a character this function returns false for followed by `=1+1`, and
 * the only live cells were the two planted positives. Marks render attached to the following
 * glyph rather than being discarded, so they do not promote anything.
 *
 * **The set is resolved against the RUNTIME's Unicode tables, not against anything in this
 * repository**, and `sanitizeImportedText` STORES the answer, which then enters the deduplication
 * key. A Node upgrade that adds a code point to Cf therefore changes what a later import stores
 * for the same input. `formulaGuard.spec.ts` pins the population size so that change is a red
 * test rather than a silent one; it is not otherwise defended, and it is the one place this
 * module is not a pure function of its input alone.
 */
const LEADING_IGNORABLE = /^[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]+/u;

/**
 * Whether this value must be prefixed before it is written into a spreadsheet format.
 *
 * The NFKC fold applies to the ONE character being tested and never to the value, which is
 * returned unchanged: the fold is how U+FF1D FULLWIDTH EQUALS SIGN and the fourteen other
 * compatibility variants of `= + - @` are recognised without fifteen more entries in a class.
 *
 * **THIS CLAUSE IS THE WEAKEST THING IN THIS MODULE AND IS LABELLED RATHER THAN DRESSED UP.**
 * Folding the leading character before testing it is NOVEL: no standard, advisory or library
 * found does it, so nothing here is citing a practice that exists. The claim it defends against
 * is weak too. OWASP's page lists the full-width variants as formula-initiating « in some
 * locales », and that sentence traces to a community issue whose author states they had no Excel
 * and could not test it. Our own measurement contradicts it: LibreOffice 26.8 treats a cell opening on U+FF1D as
 * a plain string.
 *
 * It is kept because it is additive, costs an apostrophe on a label no French statement
 * produces, and the alternative is fifteen more entries in a class for a set that would grow
 * again. Delete it the day it produces one false positive; nothing is owed to it.
 */
export function needsFormulaGuard(value: string): boolean {
	if (DANGEROUS_LEAD.test(value)) return true;
	const visible = value.replace(LEADING_IGNORABLE, '');
	const first = [...visible][0];
	return first !== undefined && DANGEROUS_LEAD.test(first.normalize('NFKC'));
}

/**
 * The value as it must be written, prefixed with an apostrophe when it needs one.
 *
 * The apostrophe rather than a tab, per CVE-2021-41270 above. The value itself is never altered,
 * because stripping would change a field whose content legitimately begins that way (WOOT '25
 * §7.1).
 *
 * ## THE ROUND TRIP IS NOT NEUTRAL, AND THAT IS A COST THIS GUARD ALREADY HAD
 *
 * A guarded label does not come back the same. `maison-v3.ts:113` says so in its own words: a
 * name whose first character a spreadsheet would evaluate « comes back carrying the exporter's
 * leading apostrophe ». Only the AMOUNT column strips one, in `maison.ts:114` and
 * `maison-v2.ts:436`; `libelle` and `categorie` keep it. So exporting and re-importing a label
 * of `-CARREFOUR` has always stored `'-CARREFOUR` the second time, and since
 * `foldLabelForSource` does not strip an apostrophe either, that row gets a different
 * `dedupeKeyHash` and is written again rather than recognised as a duplicate.
 *
 * **That is pre-existing and this change widens it.** Measured adversarially over 3 336 189
 * stored labels, old pipeline against new: 501 values become newly unstable across 167 distinct
 * leading code points, and none becomes stable. Measured against the data that actually exists,
 * `scr/synthetic/out`, 27 files and 1 727 cells: the old pattern and the new one guard the SAME
 * cells, so the real-world delta is zero. The shift is also one-shot rather than accumulating,
 * because the second trip is stable.
 *
 * It is accepted rather than fixed here: making the round trip neutral means teaching the
 * importer to strip the guard from `libelle`, which changes what a file already on a user's disk
 * means, and that is a format decision rather than a security fix. Recorded so the next reader
 * meets it, and filed.
 */
export function guardFormulaLead(value: string): string {
	return needsFormulaGuard(value) ? `'${value}` : value;
}
