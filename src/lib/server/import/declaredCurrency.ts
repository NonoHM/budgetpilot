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
 * ## Where it is called, and why not in `resolveZeroTransactionOffer`
 *
 * It needs the DESTINATION, and on both doors the destination is resolved after the parse has
 * produced rows: `/import` decides it in `decideAutoAccount`, which runs after the zero-transaction
 * branch, and `/import/columns` resolves the posted `accountId` after its own. So it runs on the
 * path that HAS transactions, right after the destination and before the collision question and
 * every write. `offerPrecedence.ts` ranks why a parse produced NOTHING, and this file produced rows.
 *
 * The cost of that position, stated rather than discovered: a file that also leaves its date
 * reading open is asked the reading first (on `/import`, before the destination is known; on
 * `/import/columns`, on the designation screen before the POST), and is refused afterwards.
 *
 * `persistImportedTransactions` calls it a THIRD time, on the rows it is about to write and the
 * account it read them against, and throws. Unreachable from both routes, which refuse first; it
 * exists so a future writer cannot skip the comparison by forgetting to call it.
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
 * Thrown by `persistImportedTransactions` when a caller reached it without comparing. A class
 * rather than a message to match on, for the reason `ImportBucketAccountError` gives.
 */
export class DeclaredCurrencyMismatchError extends Error {
	readonly fact: DeclaredCurrencyMismatch;

	constructor(fact: DeclaredCurrencyMismatch) {
		super('Declared currency contradicts the destination account');
		this.fact = fact;
		this.name = 'DeclaredCurrencyMismatchError';
	}
}
