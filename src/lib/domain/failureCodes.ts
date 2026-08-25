/**
 * Failure codes: the CONTRACT between a server that knows why something failed and an interface
 * that owns the sentence for it (#524).
 *
 * They live in `domain/` rather than beside the subsystems that produce them, and the reason is
 * mechanical rather than tidy. A code is read on both sides: the server assigns one, the component
 * maps it to a Paraglide string. `$lib/server` may not be imported by client code at all, so a
 * union and a fallback constant kept there would typecheck, pass the unit suite, pass lint, and
 * fail at `npm run build` with an illegal-import error. That exact sequence is recorded in
 * CLAUDE.md as the gate that catches what the other three cannot, and `domain/` is the directory
 * both sides are allowed to read.
 *
 * `domain/` imports nothing from `$lib/server` or `$app/*` by the rule in AGENTS.md, and this
 * module imports nothing at all, which is the strongest version of that.
 *
 * Each union is exhaustive on purpose: the interface maps it with `Record<Code, string>`, so adding
 * a member without adding its sentence stops `npm run check` instead of rendering a blank card.
 */

/**
 * WHY the local model produced nothing.
 *
 * `unavailable: true` had five distinct producers and one message, « Assistant IA indisponible »,
 * which tells a reader to wait for something that in four of the five cases will never change on
 * its own. Exactly one of these is transient, and it is the one #524 was reported for: a cold
 * Ollama loading a model into VRAM, aborted by a budget too small to let the load finish.
 *
 * Each code names the route that produces it, per the seam rule in AGENTS.md:
 *
 * - `cold_start`: the generation budget expired AFTER the connect probe answered, so something is
 *   listening and slow. `local-llm.ts` catch, `isTimeoutError` branch.
 * - `unreachable`: the connect probe did not answer inside its own budget, or the connection was
 *   refused or dropped. `probeLocalLlmReachable` returning false, and the catch's fallback.
 * - `not_configured`: `LLM_BASE_URL` was refused by the host allowlist. `local-llm.ts`, the
 *   `getLocalBaseUrl` null branch, reached before any socket is opened.
 * - `model_unavailable`: Ollama answered and does not have the model. `local-llm.ts` catch, on a
 *   `ResponseError` carrying 404.
 * - `response_unusable`: a generation completed and could not be read. `local-llm.ts` on empty
 *   content, and `parseLocalLlmContent` on invalid JSON or a schema mismatch.
 * - `response_truncated`: the generation hit the token ceiling and stopped mid-object.
 *   `local-llm.ts`, on `done_reason === 'length'` from that same response.
 *
 * THE LAST TWO LOOK LIKE ONE STATE AND NEED OPPOSITE ADVICE, which is why they are two codes.
 * Truncation is OUR fault: the ceiling was too small, and the answer is to raise a budget. An
 * unparseable answer is the model's: the answer is to try a different model. One sentence for both
 * sends half of the readers to do the wrong thing.
 *
 * The split cost one line, because `done_reason` was already on the response the app receives while
 * `local-llm.ts` read only `message.content`. That is this issue one level deeper: the app could
 * always tell truncation from garbage, and never looked.
 */
export type LocalLlmFailureCode =
	| 'cold_start'
	| 'unreachable'
	| 'not_configured'
	| 'model_unavailable'
	| 'response_unusable'
	| 'response_truncated';

/**
 * Used when nothing recognised the error, and when a payload carries no code at all.
 *
 * `unreachable` rather than a dedicated "unknown" code, and the test it has to pass is that its
 * sentence stays TRUE for everything that lands on it. Reaching the fallback means the probe had
 * answered and the request then failed for a reason we did not classify, so "nothing answered at
 * the local model's address, so it is probably not running" is the honest reading. An "unknown"
 * code would have to say nothing useful in order to stay true.
 */
export const LOCAL_LLM_FALLBACK_CODE: LocalLlmFailureCode = 'unreachable';

/**
 * WHY the bank connect form has no bank list.
 *
 * `banks === null` had nine distinct producers and one message, « La liste des banques est
 * indisponible pour le moment. Réessayez plus tard. », which is false twice over: it is not the
 * list that is unavailable, and later does not help for any producer an operator can fix. The
 * Enable Banking private key was the sharpest case, because it is not a bank-list problem at all
 * and the screen said it was.
 *
 * Three codes, and no fourth, because a code needs a route that produces it (AGENTS.md, "Every
 * piece correct, the assembly not"). `BankSyncError('disabled')` looks like a fourth and is not
 * reachable: the route calls `listBankAspsps` only inside `if (enabled)`, which is the same
 * `isBankSyncEnabled(env)` the throw tests, so a `sync_disabled` code would ship a state no route
 * can produce and a spec proving only that the draft is internally consistent.
 *
 * - `not_configured`: the operator enabled bank sync without usable provider credentials.
 *   `http.ts` on absent credentials, `jwt.ts` on both key variables set at once, and `jwt.ts` on a
 *   `ENABLE_BANKING_PRIVATE_KEY_PATH` naming no readable file.
 * - `provider_error`: the provider answered and refused. `http.ts` on a non-2xx, carrying the
 *   status and the provider's own code. `docs/bank-sync.md` documents the commonest instance, an
 *   application still awaiting activation in the provider's Control Panel.
 * - `unreachable`: the fallback. Everything left is the request not completing: a network failure,
 *   a refused redirect (`SsrfRedirectError`), or a body that is not JSON. "Could not be reached"
 *   stays true for all three, which is the test a fallback has to pass.
 */
export type BankListFailureCode = 'not_configured' | 'provider_error' | 'unreachable';

/** Used when nothing recognised the error, and when a payload carries no code at all. */
export const BANK_LIST_FALLBACK_CODE: BankListFailureCode = 'unreachable';
