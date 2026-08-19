import { isHttpError } from '@sveltejs/kit';

/**
 * The one rule for what a caught error is allowed to say to a user: **only errors the application
 * AUTHORED are user-facing** (#277).
 *
 * `isHttpError` identifies exactly those. `error(400, m.dashboard_error_invalid_amount())` is a
 * sentence somebody chose for a reader, in their language, naming something they can act on.
 * Everything else — a Prisma message, a Zod internal, a null dereference, a `RangeError` — is an
 * implementation detail that happens to have a `.message`, and rendering it puts an English string
 * a user cannot act on into a French form.
 *
 * The branch this replaces was `caught instanceof Error ? caught.message : fallback`, which reads
 * as a graceful degradation and is the opposite: `instanceof Error` is true for every internal
 * failure in the runtime, so the fallback was reached only by a thrown non-Error, which is the
 * rarest case.
 *
 * It lives here and takes `fallback` as an argument because each screen owns its own sentence, and
 * because a private copy per route is what produced the divergence in the first place: three of the
 * four copies leaked, one did not, and nothing could see that they disagreed.
 *
 * NOT a place to log the detail. This module has no logger and the repository has none — adding
 * one is a decision with retention and content questions attached (see CLAUDE.md on sensitive
 * logs), not a side effect of a copy fix. The detail is currently dropped.
 */
export function userFacingErrorMessage(caught: unknown, fallback: string): string {
	return isHttpError(caught) ? caught.body.message : fallback;
}
