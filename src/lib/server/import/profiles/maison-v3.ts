import { computeNameKey } from '$lib/server/naming/nameKey';
import type { CsvImportResult, CsvProfileParseInput, ParsedCsvRow } from '../types';
import { foldExactHeader } from '../utils/encoding';
import { sanitizeImportedText } from '../utils/safety';
import { normalizeParsedRows } from '../utils/csv';
import { MAISON_V2_HEADER, parseMaisonV2Rows } from './maison-v2';

/**
 * Version 3 of the export format: version 2 plus the account the rows came from.
 *
 * `;compte`, lowercase and unaccented, because that is what `MAISON_V2_HEADER` already is. The
 * design plate wrote `,Compte`, and `foldExactHeader` lowercases before comparing, so the
 * capitalised form would have PASSED ITS OWN TEST while reading as an inconsistency in the file
 * the user opens. **A correction that passes its own test and looks wrong to a human is exactly
 * the kind that survives**, which is why it is written down here rather than only made.
 *
 * ## THE COMPARATOR IS NEVER LOOSENED
 *
 * `MAISON_V3_HEADER` is matched by EXACT ORDERED EQUALITY, exactly as version 2 is. No
 * starts-with. No subset. No "contains these columns". **Only the SET OF ACCEPTED CONSTANTS
 * grows.** A relaxed comparator silently accepts files nobody designed, and the day a third party
 * appends their own column we read it as ours. A frozen header can receive a VERSION; it can never
 * receive a TOLERANCE. Same reasoning as rank 1 in `sourceSignature.ts`: a proof, not a
 * resemblance.
 *
 * ## Version 2 is not touched, for the reason version 1 was not
 *
 * A file a user exported last month is already on their disk, and an export format is a CONTRACT
 * rather than an output. So this is a THIRD profile beside `maison.ts` and `maison-v2.ts`, and the
 * registry tries the constants newest first. Any column added later inherits the same rule.
 */
export const MAISON_V3_HEADER = `${MAISON_V2_HEADER};compte`;

const MAISON_V3_HEADERS = MAISON_V3_HEADER.split(';');

/** The account column is the LAST one, and its index is derived from the constant rather than
 *  typed, so a further version cannot leave this pointing one column short. */
const ACCOUNT_COLUMN_INDEX = MAISON_V3_HEADERS.length - 1;

export function matchesMaisonV3Header(headers: string[]): boolean {
	const normalizedHeaders = headers.map(foldExactHeader);
	return (
		normalizedHeaders.length === MAISON_V3_HEADERS.length &&
		normalizedHeaders.every((header, index) => header === MAISON_V3_HEADERS[index])
	);
}

/**
 * The version 2 parser, fed a projection of the file with its last column removed.
 *
 * **Delegated rather than copied.** Every rule about a répartition (the grouping key, the `i/n`
 * completeness check, the sign and sum checks, the parent category, the two zero refusals) is
 * version 2's, unchanged, and a second expression of any of them here is the copied-predicate
 * shape CLAUDE.md records. The account column takes part in NONE of those rules: it names the
 * batch's destination, which is resolved before `persistImportedTransactions` is called, not a
 * property of any transaction. So there is nothing for a v3-specific line parser to do.
 *
 * **The projection drops exactly one trailing cell from EVERY row, including a malformed one**,
 * and the alternative was measured rather than assumed. Trimming only rows of the full width would
 * leave a row of ten cells, a v3 file hand-edited to drop its account cell, matching the v2
 * width exactly and importing silently. Refusing it is the point. The cost, named here rather than
 * left to be found: the `bad-column-count` refusal such a row receives reports the PROJECTED
 * widths (expected 10, actual 9), each one less than the eleven this file's header declares. The
 * line number and the fact are right, which is what sends a user to the row; the two figures are
 * off by a constant one. Correcting them needs the refusal to be emitted with a width version 2
 * does not have, which means a second copy of its column check in this file.
 */
export function parseMaisonV3Rows(input: CsvProfileParseInput): CsvImportResult {
	return parseMaisonV2Rows({ ...input, rows: input.rows.map(withoutAccountColumn) });
}

function withoutAccountColumn(row: ParsedCsvRow): ParsedCsvRow {
	return { line: row.line, cells: row.cells.slice(0, -1) };
}

/**
 * The single account this file names, or `null` when it names none.
 *
 * `null` covers three different files and the caller treats them alike on purpose, because the
 * answer it needs is the same for all three: ask, rather than guess.
 *
 *  - not a version 3 file at all (a version 2 export, a bank's statement);
 *  - a version 3 file whose `compte` column is blank, which is what an export written by a caller
 *    that does not know its account produces;
 *  - a version 3 file naming MORE THAN ONE account, which is evidence AGAINST a single
 *    destination. Taking the first would misfile the rest, and a misfiled statement is discovered
 *    months later as a balance that does not reconcile. Same rule `findDiscriminantColumn` applies
 *    to an identifier column, one rank up.
 *
 * The header is checked here rather than assumed, and that check is the whole reason this reads a
 * NAMED column instead of « the last one ». For a version 2 file the last column is
 * `categorie_parent`, so a looser reader would file a statement under a CATEGORY name, silently.
 *
 * Constancy is compared through `computeNameKey`, the only folding in this repository and the one
 * `resolveImportBucketAccount` resolves a bucket name by, so two spellings of one account are one
 * answer here and one bucket there. The value RETURNED is the raw sanitised cell, because the
 * caller resolves a name and a fold is not one.
 *
 * A name whose first character is one a spreadsheet would evaluate comes back carrying the
 * exporter's leading apostrophe, exactly as `libelle` and `categorie` already do in version 2:
 * that name will not resolve, and it fails towards asking rather than towards misfiling.
 *
 * @param rows As `parseRows` returns them: `rows[0]` is the HEADER row.
 */
export function readMaisonV3Account(rows: ParsedCsvRow[]): string | null {
	const normalized = normalizeParsedRows(rows);
	if (normalized.length < 2) return null;
	if (!matchesMaisonV3Header(normalized[0].cells)) return null;

	const names = normalized
		.slice(1)
		.map((row) => sanitizeImportedText(row.cells[ACCOUNT_COLUMN_INDEX] ?? ''));
	if (names.length === 0 || names.some((name) => name === '')) return null;

	const key = computeNameKey(names[0]);
	return names.every((name) => computeNameKey(name) === key) ? names[0] : null;
}
