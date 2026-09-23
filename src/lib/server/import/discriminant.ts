import type { ParsedCsvRow } from './types';
import type { FileVerdict } from '$lib/domain/fileVerdict';
export { ACCOUNT_COLUMN_ANSWERS, readAccountColumnAnswer } from '$lib/domain/accountColumnAnswer';
export type { AccountColumnAnswer } from '$lib/domain/accountColumnAnswer';

/**
 * How many characters of an account identifier are kept. Four, from the END.
 *
 * THIS IS A SENSITIVE DATA CLASS OF ITS OWN, narrower than the identifier it comes from. Four
 * trailing characters are enough to tell one holder's own accounts apart and not enough to
 * reconstruct the identifier, the BBAN or a check digit. It must never reach a log line, an error
 * message, a telemetry event or a crash breadcrumb; `assertDiscriminantFree` below is written
 * against that rule and `discriminant.spec.ts` asserts it rather than trusting it.
 */
export const DISCRIMINANT_LENGTH = 4;

/**
 * `FileVerdict`, #485. `contradictory` is what `basis: 'iban'` used to spell inside one
 * `multi-account` kind: a verified IBAN pair that differs PROVES two accounts. `ambiguous` is what
 * `basis: 'digit-run'` used to spell: a bare digit run that varies EXHIBITS the question without
 * proving it. Splitting them into the shared taxonomy's own two kinds retires the `basis` field
 * rather than keeping it beside a now-redundant distinction: a caller reads `.kind`, never `.kind`
 * and then `.basis`.
 */
export type DiscriminantResult = FileVerdict<
	{ index: number; fragment: string },
	{ index: number },
	{ index: number }
>;

/**
 * **The grammar narrows the candidates. The constancy is the evidence.**
 *
 * A column of well-formed account identifiers that differ per row is a multi-account export, not a
 * discriminant. Constancy is a verifiable property of the FILE; a grammar match is a property of a
 * string. That is why rank 1 can be called certain and why the refusal below is a sentence rather
 * than a fallthrough.
 *
 * ## What the grammar is, and why it matches a WHOLE cell
 *
 * An ISO 13616 IBAN whose mod-97 checksum verifies, or a run of at least eight digits. Both are
 * matched against the whole trimmed cell with its inner whitespace removed, never against a
 * substring. A date is a run of digits broken by separators and an amount is a run of digits broken
 * by a comma, so a substring match would find an identifier column in every dated file that exists.
 *
 * ## Why `resolved` wins over `contradictory`/`ambiguous`, measured rather than assumed
 *
 * A file can carry two qualifying columns, one constant and one varying, and the order they are
 * read in is then a decision rather than a detail. It is decided by a real header row already in
 * this tree: `profiles/realHeaders.fixture.ts` records N26 exporting `Partner Iban`, the
 * COUNTERPARTY's IBAN, one per row, well formed and different on every transfer. A rule that let
 * variation win would refuse an ordinary single-account N26 statement as a multi-account export.
 * So a constant qualifying column pins the file and a varying one elsewhere cannot unpin it.
 *
 * THE COST OF THAT ORDER, NAMED RATHER THAN LEFT TO BE FOUND: a genuine two-account export that
 * also carries a constant eight-digit column which is not an account number (a customer number, an
 * agency code) is read as one account. Rank 1 is wrong there, and nothing in the file says so. The
 * mitigation is `assertDiscriminantFree`, which stops the two accounts from ever sharing the
 * fragment, not this function.
 *
 * ## The refusal is a sentence
 *
 * When some column carries well-formed identifiers that DIFFER per row and no column pins one
 * account, the answer is `contradictory` or `ambiguous` carrying the column index, never
 * `nothing-to-decide`. `nothing-to-decide` means the file offered no evidence at all; the other two
 * mean it offered evidence AGAINST a single account, PROVEN or merely EXHIBITED. Collapsing either
 * pair would let a statement spanning two accounts fall silently into whatever a lower rank guesses.
 *
 * ## `contradictory` is PROOF, `ambiguous` is EVIDENCE, and #485's fix is built on the difference
 *
 * The grammar has two branches and they do not carry the same weight. A mod-97 checksum verifying
 * across two account numbers that also DIFFER is not a realistic accident: `contradictory` is close
 * enough to proof that #485's fix refuses on it outright. A bare run of 8+ digits is exactly as
 * consistent with a reference number, an invoice number or a running balance as with a second
 * account: `ambiguous` is evidence the column EXHIBITS the question, never proof it resolves one
 * way, so the fix asks instead of refusing. The kind is decided over every value the column
 * qualified on, never the first: one row failing the IBAN check downgrades the whole column to
 * `ambiguous`, because a column proven only on most of its rows is not proven.
 *
 * @param rows As `parseRows` returns them: `rows[0]` is the HEADER row and the data starts at 1.
 */
export function findDiscriminantColumn(rows: ParsedCsvRow[]): DiscriminantResult {
	const dataRows = rows.slice(1);
	if (dataRows.length === 0) return { kind: 'nothing-to-decide' };

	const columnCount = dataRows.reduce((widest, row) => Math.max(widest, row.cells.length), 0);
	let varying: { index: number; proven: boolean } | null = null;

	for (let index = 0; index < columnCount; index += 1) {
		const values: string[] = [];
		let qualifies = true;

		for (const row of dataRows) {
			const value = canonicalize(row.cells[index] ?? '');
			if (value === '' || !matchesIdentifierGrammar(value)) {
				qualifies = false;
				break;
			}
			values.push(value);
		}
		if (!qualifies) continue;

		if (values.every((value) => value === values[0])) {
			return { kind: 'resolved', index, fragment: values[0].slice(-DISCRIMINANT_LENGTH) };
		}
		if (varying === null) {
			varying = { index, proven: values.every(isVerifiedIban) };
		}
	}

	if (varying === null) return { kind: 'nothing-to-decide' };
	return varying.proven
		? { kind: 'contradictory', index: varying.index }
		: { kind: 'ambiguous', index: varying.index };
}

/**
 * Two accounts may not hold the same discriminant.
 *
 * THIS IS A PRECONDITION OF RANK 1 RATHER THAN A NICETY OF THE CREATE FORM, which is why it lives
 * beside rank 1 instead of in an accounts service. Rank 1 reads a fragment out of a statement and
 * answers with THE account that holds it. If two accounts hold one fragment the read returns two
 * rows and the whole claim to certainty collapses into a guess, silently, on a path whose entire
 * value is that it does not guess.
 *
 * THE THROWN MESSAGE CARRIES NO FRAGMENT, deliberately and under test. A thrown message is the
 * shortest path there is to a log line, an error reporter, a telemetry event and a crash
 * breadcrumb at once, and four characters from the end of an IBAN identify one of a holder's own
 * accounts. The caller knows which fragment it passed; nothing downstream of the throw needs to.
 *
 * @throws when any account in `existing` already holds `fragment`.
 */
export function assertDiscriminantFree(
	fragment: string,
	existing: Array<{ discriminant: string | null }>
): void {
	const wanted = fragment.trim().toUpperCase();
	const held = existing.some(
		(account) => (account.discriminant ?? '').trim().toUpperCase() === wanted
	);
	if (held) {
		throw new Error('Another account already holds this account identifier fragment');
	}
}

/** Whitespace removed and upper cased, so a grouped IBAN and a run-together one are one value. */
function canonicalize(cell: string): string {
	return cell.replace(/\s+/g, '').toUpperCase();
}

const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const DIGIT_RUN = /^\d{8,}$/;

function matchesIdentifierGrammar(value: string): boolean {
	return DIGIT_RUN.test(value) || isVerifiedIban(value);
}

/**
 * The stronger of the grammar's two branches, factored out and exported so both `basis` above and
 * a caller checking a `basis` claim (a property test asking which branch a drawn value took) call
 * one definition rather than retyping the checksum.
 */
export function isVerifiedIban(value: string): boolean {
	return IBAN_SHAPE.test(value) && ibanChecksumVerifies(value);
}

/**
 * ISO 13616: move the first four characters to the end, expand each letter to its position in the
 * alphabet plus nine, and the remainder mod 97 of the whole number is 1.
 *
 * The remainder is taken digit by digit because the expanded value runs to about 36 digits, well
 * past what a double can hold exactly.
 */
function ibanChecksumVerifies(value: string): boolean {
	const rearranged = value.slice(4) + value.slice(0, 4);
	let remainder = 0;
	for (const character of rearranged) {
		const expanded =
			character >= 'A' && character <= 'Z' ? String(character.charCodeAt(0) - 55) : character;
		for (const digit of expanded) {
			remainder = (remainder * 10 + Number(digit)) % 97;
		}
	}
	return remainder === 1;
}
