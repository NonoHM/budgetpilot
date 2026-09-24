import type { AccountOffer } from './accountOffer';
import type { CsvRefusalFact } from './refusals';
import type { DeclaredCurrencyMismatch } from './declaredCurrency';

/**
 * THE ONE ORDER in which a door refuses a file or asks about it.
 *
 * `/import`'s auto path and `/import/columns`'s designation path each compute independent facts
 * about why a file cannot import yet, and until this module each wrote its own ternary naming which
 * one wins when more than one is true. `/import` carries `split`, `account` and `dateOrder` and
 * never `header` (that scope is not surfaced on the auto path); `/import/columns` carries `header`
 * and never `split`, `account` or `dateOrder` (the designation screen answers the date reading and
 * the account before this door is reached, and a header-scoped refusal is the one thing this door
 * DOES surface: see #343 and #639). Passing `undefined` for a fact a door never computes is what
 * lets one function serve both without either door pretending to have evidence it does not.
 *
 * ## QUESTIONS HAVE A STATE, and that is what ends the loop measured on 1.1.1
 *
 * A file whose dates read both ways, imported by a user holding two accounts of its bank, could
 * never be imported: the date question lived in this function and the account question (#476) in
 * the route's control flow, so neither knew the other had been answered, and the page posted only
 * the answer to the question on screen. Six presses at each width alternated between the two.
 *
 * A question is `open` or `answered`, and only an OPEN question is asked. Nothing here decides
 * whether an answer counts: the route binds each answer to the file it was given for
 * (`answerBinding.ts`).
 *
 * ## What this function decides, and what is decided before it is called
 *
 * It decides the ORDER between whatever pending facts it is handed. It does NOT enforce « an
 * answered question is never asked again » on its own, and `answered` ranks exactly like an absent
 * question: MEASURED by the contradiction pass on this branch, swapping `{ state: 'answered' }` for
 * `null` changes no output over 576 input combinations (calibration: `open` for `null` changed 42).
 * That guarantee lives where the answer is CONSUMED, because the answer changes what is computed:
 * - the date reading: `csv.ts` refuses an ambiguous column only when no answer was passed
 *   (`!options.dateOrder`), and otherwise parses with it, so an answered file never yields the fact;
 * - the account column: `csv.ts`'s `accountColumnAnswer` branches turn `is-account` into the
 *   `multi-account-file` refusal and let `not-account` parse on;
 * - the account: `decideAutoAccount` resolves a posted answer before it looks for a question;
 * - and the page, which posts every kept answer back (`keptAnswers`).
 * Moving it here would need `csv.ts` to report a question it has already answered, which this
 * PR does not do.
 *
 * Nor are all pairs below reachable on `/import`. `csv.ts` returns exactly ONE fact per empty
 * parse, so `multiAccount`, `accountColumn` and `dateOrder` never arrive together: which of those
 * three a file raises first is decided inside `csv.ts`, by the order of its own checks, and this
 * ladder only ranks them against the facts computed OUTSIDE the parse (`split`, `header`, `generic`
 * and `account`). Centralising `csv.ts`'s own facts is D1's work.
 *
 * ## The order, and why each rung sits where it does
 *
 * 1. **`split`**: a structural fact about the file's own COLUMNS (money divided across two of
 *    them). Naming an account or a date reading on a file whose money cannot be summed is asking
 *    the user to do work that cannot help.
 * 2. **`header`**: the file matched no recognised shape. Same reasoning one rung down.
 * 3. **`multiAccount`** (PROVEN, `discriminant.ts`'s `contradictory`): refused outright; the file
 *    cannot be imported as fewer than two accounts, whatever else is true of it.
 * 4. **`accountColumn`** (UNPROVEN, `contradictory`'s sibling `ambiguous`): asks whether a column
 *    names accounts. Ahead of every other question because its answer can turn the file into
 *    rung 3's refusal, and asking anything else first would spend an answer on a refused file.
 *    MEASURED in `multiAccountRefusal.spec.ts`'s "order against #433" cases.
 * 5. **`generic`**: the parse produced nothing and no question BELOW explains why. Above the
 *    account question for the reason rung 4 is above it: an account chosen for a file that cannot
 *    import is an answer spent on nothing. Its definition names the one question that CAN explain
 *    an empty parse, the date reading: `csv.ts` refuses an ambiguous column only on a file that
 *    would otherwise have imported, so an open date question means the rows are there.
 * 6. **`account`** (#476): two or more accounts of the file's source and nothing in the file
 *    decides. Ahead of the date question so that a refusal about the destination can sit between
 *    the two, which rung 7 is. A posted account that does not resolve (`refused`) holds this
 *    rung's place: it is not an answer, and nothing below it is asked on its strength.
 * 7. **`currency`** (#600): the file DECLARES a currency and the destination holds another
 *    (`declaredCurrencyRefusal`). A refusal the file proves, so it comes before any question that
 *    is still open: asking the reading of a file about to be refused would spend the user's answer
 *    on nothing. Below `account` because it needs the destination: while the account is the open
 *    question there is no destination to compare with, and the route passes no fact. It arises on a
 *    parse that produced rows and on one whose only fact is the open date question, because
 *    `csv.ts` carries the file's declaration out of that empty parse (`declaredCurrencies`).
 * 8. **`dateOrder`**: the last question, asked once nothing above it is pending.
 *
 * The duplicate-statement confirmation (#343) is not a rung. It needs the destination AND the
 * parsed rows, so it can only be raised once this function answers `none`, and the route raises it
 * there. Tested in `page.server.spec.ts`'s "asks which account before ever raising the
 * duplicate-statement confirmation".
 */
export const OFFER_RUNGS = [
	'split',
	'header',
	'multiAccount',
	'accountColumn',
	'generic',
	'account',
	'currency',
	'dateOrder'
] as const;

export type OfferRung = (typeof OFFER_RUNGS)[number];

/** A question a file raises: `open` until an answer bound to that file arrives, then `answered`. */
export type Question<Fact> = { state: 'open'; fact: Fact } | { state: 'answered' };

/**
 * The account question has a third state: an answer was posted and it names no account this user
 * can import into. `decideAutoAccount`'s `refused`, carried with its reason so the route can say
 * which of its two sentences applies.
 */
export type AccountQuestion =
	Question<AccountOffer> | { state: 'refused'; reason: 'not-found' | 'archived' };

type SplitFact = Extract<CsvRefusalFact, { code: 'amount-split-across-columns' }>;
type MultiAccountFact = Extract<CsvRefusalFact, { code: 'multi-account-file' }>;
type AccountColumnFact = Extract<CsvRefusalFact, { code: 'ambiguous-account-column' }>;
type DateOrderFact = Extract<CsvRefusalFact, { code: 'ambiguous-date-order' }>;

export interface ImportOffers {
	/** Whether the parse produced at least one transaction. What `generic` is defined against. */
	produced: boolean;
	split?: SplitFact | null;
	header?: CsvRefusalFact | null;
	multiAccount?: MultiAccountFact | null;
	accountColumn?: Question<AccountColumnFact> | null;
	account?: AccountQuestion | null;
	/** The file's declared currency against a KNOWN destination; null when they agree, when the file
	 *  declares nothing, or when no destination is known yet. */
	currency?: DeclaredCurrencyMismatch | null;
	dateOrder?: Question<DateOrderFact> | null;
}

export type ImportOffer =
	| { rung: 'split'; fact: SplitFact }
	| { rung: 'header'; fact: CsvRefusalFact }
	| { rung: 'multiAccount'; fact: MultiAccountFact }
	| { rung: 'accountColumn'; fact: AccountColumnFact }
	| { rung: 'generic' }
	| { rung: 'account'; question: Exclude<AccountQuestion, { state: 'answered' }> }
	| { rung: 'currency'; fact: DeclaredCurrencyMismatch }
	| { rung: 'dateOrder'; fact: DateOrderFact }
	/** Nothing refuses and nothing is left to ask: the door goes on to write. */
	| { rung: 'none' };

/**
 * What one rung says about a door's state: its offer when it is pending, null when it is not.
 *
 * A `switch` with no default over `OfferRung`, so a rung added to `OFFER_RUNGS` without a case here
 * does not compile.
 */
function pendingAt(rung: OfferRung, offers: ImportOffers): ImportOffer | null {
	switch (rung) {
		case 'split':
			return offers.split ? { rung, fact: offers.split } : null;
		case 'header':
			return offers.header ? { rung, fact: offers.header } : null;
		case 'multiAccount':
			return offers.multiAccount ? { rung, fact: offers.multiAccount } : null;
		case 'accountColumn':
			return offers.accountColumn?.state === 'open'
				? { rung, fact: offers.accountColumn.fact }
				: null;
		case 'generic':
			return !offers.produced && offers.dateOrder?.state !== 'open' ? { rung } : null;
		case 'account': {
			const question = offers.account;
			return question && question.state !== 'answered' ? { rung, question } : null;
		}
		case 'currency':
			return offers.currency ? { rung, fact: offers.currency } : null;
		case 'dateOrder':
			return offers.dateOrder?.state === 'open' ? { rung, fact: offers.dateOrder.fact } : null;
	}
}

/**
 * The first pending rung in `OFFER_RUNGS`'s order, or `none`. Pure: the caller has already computed
 * every fact and bound every answer; this only orders them.
 */
export function resolveImportOffer(offers: ImportOffers): ImportOffer {
	for (const rung of OFFER_RUNGS) {
		const offer = pendingAt(rung, offers);
		if (offer) return offer;
	}
	return { rung: 'none' };
}
