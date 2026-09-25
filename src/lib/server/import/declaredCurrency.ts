import type { CsvRefusalFact } from './refusals';
import type { ImportedTransaction } from './types';
import { refusalCellValue } from './utils/safety';

export type DeclaredCurrencyMismatch = Extract<
	CsvRefusalFact,
	{ code: 'declared-currency-mismatch' }
>;

/**
 * THE ONE COMPARISON between the currency a file declares and the account it is filed into. #600.
 *
 * ## Why it refuses
 *
 * AGENTS.md's file-evidence rule, applied to one of its eight decisions: a file that declares a
 * currency PROVES an answer, and a destination held in another currency contradicts it. That is the
 * refuse branch, never an ask, because no answer the user could give makes a euro amount a dollar
 * one. A file that declares NOTHING exhibits nothing and takes the destination's currency by design
 * (#600's ruling of 2026-09-23), which is why an undeclared row is never compared.
 *
 * Before this, `persistImportedTransactions` denominated every row by the destination, so a file
 * saying EUR, filed into a bank-synced USD account, stored USD. Measured on all three doors that
 * reach a declared currency (`generic`, `mapped`, `revolut`): `declaredCurrency.db-smoke.ts`.
 *
 * ## Where it is called
 *
 * - **`/import`**: its answer is the `currency` rung of `offerPrecedence.ts`, ranked before every
 *   question, so a file this refuses is never asked whether a column names accounts, nor its date
 *   reading, first. It needs the destination, so while the account is the open question it is not
 *   computed and the account is asked first. The route computes it as soon as `decideAutoAccount`
 *   knows the destination, whether or not the parse produced rows, from the file-level declaration
 *   `csv.ts` carries even out of the empty parse that withheld the rows to ask a question.
 * - **`/import/columns`**: after the chosen account resolves, before the collision question and
 *   every write. Not ranked against the date question there, and it cannot be on the server: the
 *   designation screen asks the reading in the browser before this door is posted. Putting the
 *   refusal first on that screen is a screen design question, not a server one.
 *
 * `persistImportedTransactions` calls it a THIRD time, as a backstop, and throws. The two route
 * calls are the control: they run before anything is written and compare the file-level
 * declaration. The backstop sees only the rows it is handed, so it protects transaction rows, and
 * only for a writer whose rows carry `declaredCurrency`. It runs after the batch (and possibly a
 * by-source bucket, a saved mapping or a counted mapping use) has been written, and nothing catches
 * it, so reaching it means a 500 and an empty batch. No caller reaches it today; the persist
 * comment says the rest, and #662 (D3) owns an uncaught throw there.
 *
 * ASVS v5.0.0-2.2.1: the declared currency is input validated against an expected structure, the
 * destination's own denomination, at the server boundary.
 */
export function declaredCurrencyRefusal(
	/**
	 * What the file declares. The routes pass `CsvImportSummary.declaredCurrencies`, the file-level
	 * fact read off every row; the persist backstop passes its rows' `declaredCurrency`, which is
	 * all a writer holding only transactions can see (`declaredCurrencies`' own docstring says why
	 * that is the weaker input).
	 */
	declared: ReadonlyArray<string | undefined>,
	destination: { currency: string }
): DeclaredCurrencyMismatch | null {
	// ANY declaration decides, not the first: a file may leave the column blank on some rows, and a
	// blank is not a declaration (`currencyDeclaration.ts`).
	const contradicted = declared.find((code) => Boolean(code) && code !== destination.currency);
	if (!contradicted) return null;
	return {
		code: 'declared-currency-mismatch',
		// Lifted from the file, on its way to a page: bounded like every cell a refusal names.
		declared: refusalCellValue(contradicted),
		destination: destination.currency
	};
}

/** The per-row declarations a writer holding only transactions can pass to the comparison. */
export function rowDeclarations(
	transactions: ReadonlyArray<Pick<ImportedTransaction, 'declaredCurrency'>>
): Array<string | undefined> {
	return transactions.map((transaction) => transaction.declaredCurrency);
}

/**
 * Thrown by `persistImportedTransactions`, before the first transaction row, when a writer reached
 * it without comparing. Not caught anywhere yet (#662). A class rather than a message to match on,
 * for the reason `ImportBucketAccountError` gives.
 */
export class DeclaredCurrencyMismatchError extends Error {
	readonly fact: DeclaredCurrencyMismatch;

	constructor(fact: DeclaredCurrencyMismatch) {
		super('Declared currency contradicts the destination account');
		this.fact = fact;
		this.name = 'DeclaredCurrencyMismatchError';
	}
}
