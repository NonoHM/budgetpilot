import { isStatementAccount } from '$lib/domain/account';
import { displayAccountName, type NameableAccount } from '$lib/server/accounts/projection';

/**
 * How a transaction's bucket is NAMED on screen.
 *
 * ## Why this is not in `+page.server.ts`, and not in `domain/account.ts` either
 *
 * It lived in `src/routes/transactions/+page.server.ts` for one commit and **broke `npm run build`
 * while every other gate stayed green**: SvelteKit allows a page server module to export only
 * `load`, `prerender`, `csr`, `ssr`, `trailingSlash`, `config`, `actions`, `entries`, or a name
 * prefixed with `_`. `npm run check` over 3 792 files reported 0 errors, 295 unit files and 4 122
 * tests passed, `lint:tracked` was clean, and the failure appeared only at
 * `Error: Invalid export 'projectAccountForDetail'`. That is the "every gate is a lower bound"
 * rule with the bundle as the bound: `check` misses what breaks at BUILD.
 *
 * It does not belong in `domain/account.ts` either, for the opposite reason. That module imports
 * NOTHING on purpose, and this one calls a Paraglide message. Anything importing
 * `$lib/paraglide/messages` outside a request has no negotiated locale, which is how `domain/money`
 * once failed at container startup after four thousand unit tests had passed. Here the only caller
 * is a `load`, so a request and its locale are always in scope.
 *
 * ## What it decides
 *
 * RENDERING ONLY, never storage. `ensureManualAccount` still resolves the manual bucket on its
 * stored string `Compte manuel`, and this substitutes a message for it at the last moment. The
 * detail panel used to render « Compte manuel · manual »: a stored bucket name doing duty as a
 * lookup key, with the raw enum printed beside it. Both halves are the defect `importProfileLabel`
 * already closed for the neighbouring column.
 */
export function projectAccountForDetail(account: NameableAccount): {
	displayName: string;
	showSource: boolean;
} {
	return {
		/**
		 * `displayAccountName` rather than the ternary this used to be, and the change is what stops
		 * two screens naming ONE row two ways.
		 *
		 * The ternary was right about the manual bucket and silent about the generic one: it read
		 * `account.name` for every statement account, so this panel said « Compte import CSV » about
		 * the same row the Comptes screen calls « Import CSV » the moment that second rule shipped.
		 * Neither name is false, and a user reading both would still have to work out that they are
		 * one account. One rule, asked here and there.
		 */
		displayName: displayAccountName(account),
		showSource: isStatementAccount(account)
	};
}
