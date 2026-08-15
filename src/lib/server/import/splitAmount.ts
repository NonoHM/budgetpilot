import type { ParsedCsvRow } from './types';
import { parseAmountCents } from './utils/money';

/**
 * Which column, if any, carries the amounts the designated one is missing.
 *
 * ## The defect this exists for, measured
 *
 * A Banque Populaire export splits money across `Debit` and `Credit`. The designation screen
 * offers ONE amount role, so a user designates `Debit`, and every credit row is then rejected
 * one at a time as « montant invalide »: a partial import, on the run that also MEMORISES the
 * mapping, so it repeats unattended on every later statement from that bank. A blind usability
 * session lost a whole month of income this way and the application reported nothing wrong:
 * `Total revenus 0,00 €` is a true statement about what was imported and a false picture of the
 * user's money. See #343.
 *
 * ## Why #320's detector cannot see it
 *
 * `detectSignIndicatorColumn` requires that every parsable amount in the file be `>= 0`, on the
 * reasoning that a signed column means the file signs its own amounts and a direction column
 * beside it is redundant rather than load-bearing. That reasoning is correct and this shape slips
 * underneath it: a `Debit` column is ALREADY signed negative, so the file passes and is read.
 *
 * ## Refused BEFORE the designation screen, not after it
 *
 * The design plate is categorical on where this belongs. §1q table B, « Montants sans signe »:
 * « La détection doit refuser le fichier AVANT cet écran et le nommer sur /imports. » Table E:
 * « Aucun état d'erreur propre à l'écran — les échecs vivent sur /imports », « Aucun toast —
 * AlertBanner uniquement, et pas sur cet écran », « Aucune surface teintée — zéro sur cet écran ».
 *
 * The structural argument is the better one anyway: the pair is visible in the bytes before anyone
 * designates anything, so a screen that opens and then refuses makes the user do the work first
 * and tells them it was pointless afterwards.
 *
 * Hence two entry points. `detectSplitAmountPair` runs at UPLOAD, before the designation offer, and
 * is what stops the screen opening. `detectComplementAmountColumn` runs in the mapped parser and
 * catches the path the upload gate cannot see: a file arriving through a MEMORISED mapping produces
 * transactions, so it never reaches the offer branch at all, and would simply lose its credit rows
 * again, quietly, which is the original defect.
 *
 * Neither lets the user import their statement. That needs the Montant role to be able to carry two
 * columns, which the plate has already drawn (§4: a second line under the Montant row, row 68 → 116,
 * card 355 → 403, « the only figure in this handoff that would move, already computed »). This is
 * the refusal that holds the line WHILE that is built, not a refusal standing in for its
 * impossibility.
 *
 * ## The conjunction, and why every clause is load-bearing
 *
 * The sibling `S` is a complement of the designated amount column `A` only when, across the body:
 *
 * 1. `A` is empty on at least one row, because otherwise nothing is being lost and there is nothing to
 *    refuse. This alone excludes the overwhelmingly common single-amount-column file.
 * 2. Every row has EXACTLY ONE of `A` and `S` carrying a parsable amount: never both, never
 *    neither. Mutual exclusivity is the debit/credit signature, and it is what separates a
 *    complement from a balance column, a running total, or a second numeric field.
 * 3. `S` carries at least one parsable amount, so the refusal names a column that would actually
 *    have contributed rows.
 *
 * A file where `A` has gaps that NO sibling covers is not caught, deliberately: those rows are
 * genuinely unreadable, the existing per-row refusal already says so, and refusing the whole file
 * would throw away the rows that are fine.
 *
 * Returns the offending header so the refusal can name it, matching `detectSignIndicatorColumn`.
 */
export function detectComplementAmountColumn(
	headers: string[],
	rows: ParsedCsvRow[],
	amountColumn: string
): string | null {
	const amountIndex = headers.indexOf(amountColumn);
	if (amountIndex === -1) return null;

	const body = rows.slice(1);
	if (body.length === 0) return null;

	const amountPresence = body.map((row) => parseAmountCents(row.cells[amountIndex] ?? '') !== null);
	// Clause 1. A column that is never empty is losing nothing, whatever sits beside it.
	if (amountPresence.every(Boolean)) return null;

	for (const [index, header] of headers.entries()) {
		if (index === amountIndex) continue;

		let siblingAmounts = 0;
		let exclusive = true;
		for (const [position, row] of body.entries()) {
			const hasSibling = parseAmountCents(row.cells[index] ?? '') !== null;
			if (hasSibling) siblingAmounts += 1;
			// Clause 2, as an XOR: the moment one row carries both or neither, this is some other
			// shape and guessing at it is how a guard starts refusing files that would have imported.
			if (hasSibling === amountPresence[position]) {
				exclusive = false;
				break;
			}
		}

		// Clause 3.
		if (exclusive && siblingAmounts > 0) return header;
	}

	return null;
}

/**
 * The two columns a file splits its money across, before any of them is designated.
 *
 * This is what stops the designation screen from opening on a shape it cannot express. The pair is
 * a property of the bytes, so it is knowable at upload, and the plate says that is where it must be
 * decided: opening the screen and refusing afterwards makes the user do the work first and tells
 * them it was pointless second.
 *
 * The conjunction mirrors `detectComplementAmountColumn`, with one clause added because there is no
 * designated column to anchor on: **exactly one pair must qualify.** Two candidate pairings mean
 * nothing here can tell which is the money, and guessing is how a guard starts refusing files that
 * would have imported. When it cannot tell, it says nothing and the user gets the designation
 * screen, which is the status quo and not a wrong answer for a shape nobody can name.
 *
 * Returned in FILE ORDER, so the refusal reads left to right the way the columns sit in the file.
 */
export function detectSplitAmountPair(
	headers: string[],
	rows: ParsedCsvRow[]
): [string, string] | null {
	const body = rows.slice(1);
	if (body.length === 0) return null;

	const presence = headers.map((_, column) =>
		body.map((row) => parseAmountCents(row.cells[column] ?? '') !== null)
	);

	let found: [string, string] | null = null;
	for (let left = 0; left < headers.length; left++) {
		if (!presence[left].some(Boolean)) continue;
		for (let right = left + 1; right < headers.length; right++) {
			if (!presence[right].some(Boolean)) continue;
			// Exactly one of the two on every row: never both, never neither.
			const exclusive = presence[left].every((has, index) => has !== presence[right][index]);
			if (!exclusive) continue;
			// A second qualifying pair means the file cannot be read this way with any confidence.
			if (found) return null;
			found = [headers[left], headers[right]];
		}
	}

	return found;
}
