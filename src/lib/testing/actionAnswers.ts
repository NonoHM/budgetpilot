/**
 * What a form action's submission resolves to when it never gets a SvelteKit answer, for component
 * specs (#1336).
 *
 * In the app, a rejected `fetch` (no network) or a body that is not an action result goes through
 * SvelteKit 3's client `handle_error`, and with no `handleError` hook in `src/hooks.client.ts` the
 * page receives `{ type: 'error', error: { status: 500, message: 'Internal Error' } }`. That handler
 * reads the started router, which a component spec does not have, so the spec's submission threw
 * instead of answering. This is that result sent as the answer, so the page meets what it meets in
 * production. SvelteKit 2 built the same `type: 'error'` result without the router.
 */
export const unreachableAnswer = (): Response =>
	new Response(
		JSON.stringify({ type: 'error', error: { status: 500, message: 'Internal Error' } }),
		{ status: 500, headers: { 'content-type': 'application/json' } }
	);
