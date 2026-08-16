import type { PageServerLoad } from './$types';

/**
 * DIAGNOSTIC, NOT A SECURITY CONTROL. Nothing here refuses anything, and nothing may ever be built
 * on top of it as though it did.
 *
 * SvelteKit's own CSRF check remains the sole authority on cross-origin form submissions and is
 * untouched by this route. It lives at the top of `internal_respond`, ABOVE every hook, so no
 * `handle` can decorate the plain-text 403 it returns; taking the check over to improve that
 * message was considered and rejected, as was wrapping adapter-node's server to post-filter it.
 * All this page does is reach an operator BEFORE that refusal, carrying the two values it compares.
 *
 * `expected` is the origin the server computed, which is exactly what Kit's check compares the
 * browser's `Origin` header against: it is `ORIGIN` when that is set, and `https://` plus the Host
 * header when it is not. The page pairs it with the browser's own `location.origin`, which is what
 * that header will contain. The server cannot make the comparison itself, which is the whole reason
 * this page exists rather than a boot-time refusal, so the guard against reaching it at a HEALTHY
 * instance is client-side too, in +page.svelte.
 */
export const load: PageServerLoad = ({ url }) => {
	return { expected: url.origin };
};
