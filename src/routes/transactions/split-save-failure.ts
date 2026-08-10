import type { ActionResult } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';

/**
 * What a `?/saveSplits` submission answered, when the answer is NOT a répartition that was written
 * and NOT a refusal the server explained.
 *
 * MEASURED, 2026-08-09, production build against a real database, chromium at 1280x800. Delete the
 * session row, fill the editor, press « Enregistrer ». The POST answers **HTTP 200** carrying
 * `{"type":"redirect","status":303,"location":"/login?redirectTo=…%26%2FsaveSplits"}` — SvelteKit's
 * `is_action_json_request` branch turns the redirect the auth hook threw into an action result, so
 * the 303 is a field in a JSON body rather than a status on the wire. `use:enhance`'s `update()`
 * hands that to `applyAction`, which calls `goto('/login?…')`, and this page's own `beforeNavigate`
 * guard cancels it because the editor is dirty — `canSave` REQUIRES `isDirty`, so it is dirty
 * whenever this button can be pressed at all. What the user is shown is « Abandonner les
 * modifications ? », the unsaved-work prompt: it never says the save failed, never says why, and
 * its « Abandonner » discards the parts and leaves for /login. « Rester » returns a screen identical
 * to a successful save minus the success banner.
 *
 * So the redirect is swallowed here instead, and the failure is stated where it happened (1i). Two
 * causes, two sentences, because the action the user must take differs:
 *
 * - `redirect` — the ONLY redirects `?/saveSplits` can produce come from `handleAuth` in
 *   `hooks.server.ts`: no session, or a forced password change. Both mean the same thing to this
 *   form — nothing was written and nothing will be until the user is authenticated again. The
 *   sentence says to sign in **in another tab**, which is not a workaround but the one instruction
 *   that keeps the draft: the session cookie is set for the whole origin, so the next « Réessayer »
 *   in THIS tab carries it, while navigating this tab to /login is exactly what destroys the parts.
 * - `error` — `enhance` deserialises the response body as JSON and turns any throw into this,
 *   which is what a dropped connection, a proxy error page or an unparseable answer arrive as.
 *
 * `success` and `failure` are not this function's business: the first is the write, the second is
 * a refusal the server already explained through `splitsError`.
 *
 * Returns `null` for those two, so a caller can write `?? update()` and have the ordinary path
 * unchanged.
 */
export function splitSaveFailureMessage(result: ActionResult): string | null {
	if (result.type === 'redirect') return m.splits_error_session_expired();
	if (result.type === 'error') return m.splits_error_unreachable();
	return null;
}
