import { isStatementAccount } from '$lib/domain/account';
import * as m from '$lib/paraglide/messages';

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
export function projectAccountForDetail(account: { name: string; source: string }): {
	displayName: string;
	showSource: boolean;
} {
	const statement = isStatementAccount(account);
	return {
		displayName: statement ? account.name : m.accounts_manual_entry(),
		showSource: statement
	};
}
