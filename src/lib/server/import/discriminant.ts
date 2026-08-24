import type { ParsedCsvRow } from './types';

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

export type DiscriminantResult =
	| { kind: 'found'; index: number; fragment: string }
	| { kind: 'multi-account'; index: number }
	| { kind: 'none' };

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
 * ## Why `found` wins over `multi-account`, measured rather than assumed
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
 * account, the answer is `multi-account` carrying the column index, never `none`. `none` means the
 * file offered no evidence at all; `multi-account` means it offered evidence AGAINST a single
 * account. Collapsing the two would let a statement spanning two accounts fall silently into
 * whatever a lower rank guesses.
 *
 * @param rows As `parseRows` returns them: `rows[0]` is the HEADER row and the data starts at 1.
 */
export function findDiscriminantColumn(rows: ParsedCsvRow[]): DiscriminantResult {
	const dataRows = rows.slice(1);
	if (dataRows.length === 0) return { kind: 'none' };

	const columnCount = dataRows.reduce((widest, row) => Math.max(widest, row.cells.length), 0);
	let varying: number | null = null;

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
			return { kind: 'found', index, fragment: values[0].slice(-DISCRIMINANT_LENGTH) };
		}
		varying ??= index;
	}

	return varying === null ? { kind: 'none' } : { kind: 'multi-account', index: varying };
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
	if (DIGIT_RUN.test(value)) return true;
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
