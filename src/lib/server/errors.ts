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

/**
 * THE THIRD CATEGORY, and the reason it had to exist.
 *
 * The rule above is a BINARY classifier: authored, or one fallback sentence. That is correct about
 * what an error may SAY and silent about what the application already KNOWS, and the second half is
 * where four generic messages came from (#524). A caught error at the edge of a subsystem has
 * usually been classified twice already — `EnableBankingApiError` carries a status and a provider
 * code, `jwt.ts` throws naming the paths it tried, `BankSyncError('disabled')` separates "off" from
 * "broken" — and then a bare `catch` one frame from the interface discards all of it, because the
 * binary rule has no branch to put it in. The screen then tells a user to wait for something that
 * will never change on its own.
 *
 * So: authored (show it) / RECOGNISED (a code this subsystem owns) / unknown (the fallback).
 *
 * A recogniser returns a CODE and never a sentence, and that is a constraint rather than a style
 * choice. This module runs on the server, where `$lib/paraglide/messages` has no negotiated locale
 * outside a request (CLAUDE.md records what that cost in `domain/money.ts`), so a sentence built
 * here would be built in the wrong language. A code crosses the boundary; the interface owns the
 * sentence, in the reader's locale, and a `Record<Code, ...>` map there is what makes adding a code
 * without adding its sentence a compile error rather than a blank card.
 */
export type FailureRecogniser<Code extends string> = (caught: unknown) => Code | null;

/**
 * Runs a recogniser, falling back to the code meaning "this subsystem does not know what this is".
 *
 * `fallbackCode` is required rather than defaulted: the unknown case is a state the interface has
 * to have a sentence for, and defaulting it here is how it ends up with none.
 */
export function failureCode<Code extends string>(
	caught: unknown,
	recognise: FailureRecogniser<Code>,
	fallbackCode: Code
): Code {
	return recognise(caught) ?? fallbackCode;
}

/**
 * True for the abort an `AbortSignal.timeout` produces, which is how a budget that expired is told
 * apart from a connection that failed.
 *
 * Checked by NAME rather than by `instanceof DOMException`: undici, Node's own `AbortSignal` and a
 * test double do not agree on the constructor, and the name is the part the spec pins. Both spellings
 * are accepted because `AbortSignal.timeout` produces `TimeoutError` while an explicit
 * `controller.abort()` produces `AbortError`, and a caller that swaps one for the other should not
 * silently change which branch a user lands on.
 */
export function isTimeoutError(caught: unknown): boolean {
	if (typeof caught !== 'object' || caught === null || !('name' in caught)) return false;
	const { name } = caught as { name?: unknown };
	return name === 'TimeoutError' || name === 'AbortError';
}
