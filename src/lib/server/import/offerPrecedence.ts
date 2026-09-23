import type { CsvRefusalFact } from './refusals';

/**
 * THE ONE ORDER, for a file that produced zero transactions.
 *
 * `/import`'s auto path and `/import/columns`'s designation path each compute up to five
 * independent facts about WHY a parse produced nothing, and until now each wrote its own ternary
 * naming which one wins when more than one is true — the exact shape a third door would have
 * copied by hand rather than called. `/import` carries `split`/`dateOrder` and never `header`
 * (that scope is not surfaced on the auto path); `/import/columns` carries `header` and never
 * `split`/`dateOrder` (the designation screen answers the date reading before this door is
 * reached, and a header-scoped refusal is the one thing this door DOES surface — see #343 and
 * #639). Passing `undefined` for a fact a door never computes is what lets one function serve
 * both without either door pretending to have evidence it does not.
 *
 * ## The order, and why each rung sits where it does
 *
 * 1. **`split`** — a structural fact about the file's own COLUMNS (money divided across two of
 *    them). It answers a question the other four cannot be asked about at all: naming an account
 *    or a date reading on a file whose money cannot be summed is asking the user to do work that
 *    cannot help.
 * 2. **`header`** — the file matched no recognised shape. Same reasoning one rung down: nothing
 *    below this can be evaluated meaningfully over columns that were never identified.
 * 3. **`multiAccount`** (PROVEN, `discriminant.ts`'s `contradictory`) — refused outright, and nothing
 *    below this offers anything a user could act on: the file cannot be imported as fewer than two
 *    accounts, whatever the date column says.
 * 4. **`accountColumn`** (UNPROVEN, `contradictory`'s sibling `ambiguous`) — the one rung that asks
 *    rather than refuses. Ahead of `dateOrder` for the same reason `multiAccount` is: MEASURED in
 *    `multiAccountRefusal.spec.ts`'s "order against #433" cases, so a file carrying both questions
 *    asks about accounts first and pays a second round trip for the date question it has not
 *    asked yet, named there as the cost this order accepts rather than hidden.
 * 5. **`dateOrder`** — the last question, asked only once nothing above it needed answering.
 *
 * A door passing more than one truthy fact is not a state this function was designed to see: each
 * `emptyResult` in `csv.ts` returns exactly one fact per parse, and `splitPair`/`headerRefusal`
 * are each computed by a single call site guarded by `refusedForBounds`. The order below is what a
 * FUTURE door failing that discipline would fall back on, not a case this repository's two doors
 * can currently reach.
 */
export interface ZeroTransactionOffers {
	split?: Extract<CsvRefusalFact, { code: 'amount-split-across-columns' }> | null;
	header?: CsvRefusalFact | null;
	multiAccount?: Extract<CsvRefusalFact, { code: 'multi-account-file' }> | null;
	accountColumn?: Extract<CsvRefusalFact, { code: 'ambiguous-account-column' }> | null;
	dateOrder?: Extract<CsvRefusalFact, { code: 'ambiguous-date-order' }> | null;
}

export type ZeroTransactionOffer =
	| { rung: 'split'; fact: Extract<CsvRefusalFact, { code: 'amount-split-across-columns' }> }
	| { rung: 'header'; fact: CsvRefusalFact }
	| { rung: 'multiAccount'; fact: Extract<CsvRefusalFact, { code: 'multi-account-file' }> }
	| { rung: 'accountColumn'; fact: Extract<CsvRefusalFact, { code: 'ambiguous-account-column' }> }
	| { rung: 'dateOrder'; fact: Extract<CsvRefusalFact, { code: 'ambiguous-date-order' }> }
	| { rung: 'generic' };

/**
 * Which of a door's computed offers actually applies, per the order this file's own docstring
 * names. Pure: the caller has already computed every fact; this only orders them.
 */
export function resolveZeroTransactionOffer(offers: ZeroTransactionOffers): ZeroTransactionOffer {
	if (offers.split) return { rung: 'split', fact: offers.split };
	if (offers.header) return { rung: 'header', fact: offers.header };
	if (offers.multiAccount) return { rung: 'multiAccount', fact: offers.multiAccount };
	if (offers.accountColumn) return { rung: 'accountColumn', fact: offers.accountColumn };
	if (offers.dateOrder) return { rung: 'dateOrder', fact: offers.dateOrder };
	return { rung: 'generic' };
}

/**
 * THE OTHER PAIR, named beside this one so a reader who came here for "which offer wins" finds
 * both answers rather than half of one.
 *
 * #476's account question (`decideAutoAccount`'s `kind: 'ask'`) and #343's duplicate-statement
 * confirmation (`findCollidingBatch`) are NOT ranked by a function like `resolveZeroTransactionOffer`
 * above, because they are not five facts computed together and then ordered: each is an early
 * `return` inside `/import`'s own action, gating what runs after it, and only one door (`/import`)
 * can ever raise either. `decision.kind === 'ask'` is checked and returned on BEFORE
 * `formData.get('confirmCollision')` is ever read — a file that is both ambiguous by source and a
 * re-upload of an already-imported statement asks which account first, and pays a second round
 * trip for the collision question it has not raised yet, same shape as `multiAccount`/
 * `accountColumn` paying a second round trip for the date question. Tested directly against the
 * real collision detector in `page.server.spec.ts`'s "asks which account before ever raising the
 * duplicate-statement confirmation", because control flow is verified by running it, not by
 * calling a ranking function that was never in the loop.
 */
