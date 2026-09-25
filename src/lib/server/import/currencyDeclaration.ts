import { sanitizeImportedText } from './utils/safety';

/**
 * The FOLDED header names a `generic` or designated file may declare its currency under.
 *
 * ONE definition. `generic.ts` and `mapped.ts` each carried a copy until #600, and `generic.ts`'s
 * docstring still carries the reason the column exists at all.
 */
export const CURRENCY_COLUMNS = ['currency', 'devise'] as const;

/** The one currency a declaring column may name and still import. Anything else is refused on its
 *  row (`unsupported-currency`). */
export const ACCEPTED_CURRENCY = 'EUR';

/**
 * The ISO 4217 codes this runtime knows, which is what separates `(EUR)` from `(TTC)`.
 *
 * NOT `isValidCurrencyCode` (`domain/money.ts`), which checks ISO 4217's GRAMMAR only and says so:
 * `TTC` has three uppercase letters and would pass, and an amount column « Montant (TTC) », a French
 * statement's tax-inclusive amount, would then be read as declaring a currency called TTC and every
 * row refused. Whether a code EXISTS needs a list, and the runtime's is the one list available
 * without writing a second copy of the standard into this repository.
 *
 * A runtime table, so its answer can move with the ICU data a Node release ships. That is
 * acceptable HERE because nothing it answers is stored: it decides whether a header declares a
 * currency, which only refuses or admits a file, and `declaredCurrency.spec.ts` pins the codes the
 * import depends on so a change is noticed rather than absorbed.
 */
const KNOWN_CURRENCY_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

/** Whether a code is one ISO 4217 names, as this runtime knows it. */
export function isKnownCurrencyCode(code: string): boolean {
	return KNOWN_CURRENCY_CODES.has(code);
}

/**
 * THE ONE RULE for a currency named in the amount header (#600, contradiction passes F1 and F1).
 *
 * An amount header whose text ENDS with a parenthesised ISO 4217 code declares that currency for
 * every row under it: N26's `Amount (EUR)`, and its legacy `Montant (EUR)` and `Betrag (EUR)`. A
 * rule and not a list of spellings, because on the designated path ANY header can be the amount: the
 * first fix listed `amount (eur)` alone, and the second contradiction pass measured the French and
 * German headers storing USD. A parenthesis that is not a code (`(TTC)`) declares nothing.
 *
 * Returns the code whether or not the import accepts it: a header declaring USD is that file's
 * declaration, and the row loop refuses it as `unsupported-currency`, as a `currency` column
 * reading USD always has been.
 */
export function amountHeaderCurrency(amountHeader: string): string | undefined {
	const match = /\(\s*([A-Za-z]{3})\s*\)\s*$/.exec(amountHeader);
	if (!match) return undefined;
	const code = match[1].toUpperCase();
	return isKnownCurrencyCode(code) ? code : undefined;
}

/**
 * EVERY declaring column this file carries, in `CURRENCY_COLUMNS` order.
 *
 * All of them rather than the first one found, which is what both profiles did before the
 * contradiction pass on #600 (F3): a file carrying `currency` blank and `devise` reading EUR had
 * only the blank column read, and filed into a USD account stored USD.
 */
export function currencyColumnsIn(foldedHeaders: readonly string[]): string[] {
	return CURRENCY_COLUMNS.filter((name) => foldedHeaders.includes(name));
}

/**
 * WHICH CURRENCY A FILE DECLARES, read off every row (#600).
 *
 * A file-level decision in AGENTS.md's sense: the currency a statement is in is a property of the
 * FILE, so it is decided by looking at every value it ranges over, never only at the rows that
 * went on to become transactions. The contradiction pass on #600 measured the difference (F2): a
 * file whose one declaring row was refused for its date filed its other row under a USD account's
 * currency, while the same file with a valid date was refused.
 *
 * What counts as a declaration is a cell the profile ACCEPTS as a currency. A cell naming another
 * currency is refused on its own row (`unsupported-currency`), with its own sentence, and is left
 * out here: counting it would refuse a file's euro rows for the sake of a row already refused.
 * A blank cell declares nothing, which is the file-evidence rule's « exhibits nothing ».
 *
 * Returns the distinct codes, in the order first met. A list rather than a single code because
 * nothing here can promise a file declares only one: today the accepted set is EUR alone, so the
 * list is `[]` or `['EUR']`.
 */
export function acceptedDeclarations(
	cells: Iterable<string>,
	accepted: string,
	/** The profile's own acceptance test, so a cell counts here exactly when its row accepts it.
	 *  Case-insensitive by default, which is `resolvedRows.ts`'s rule; Revolut's is exact. */
	accepts: (declared: string) => boolean = (declared) => declared.toUpperCase() === accepted
): string[] {
	const found = new Set<string>();
	for (const cell of cells) {
		const declared = sanitizeImportedText(cell);
		if (declared && accepts(declared)) found.add(accepted);
	}
	return [...found];
}
