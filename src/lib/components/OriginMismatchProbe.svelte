<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { readServerOrigin, ORIGIN_MISMATCH_ROUTE } from '$lib/originProbe';

	/**
	 * DIAGNOSTIC, NOT A SECURITY CONTROL. See routes/setup/origin-mismatch/+page.server.ts.
	 *
	 * It runs in the browser because that is the only place the answer exists. With ORIGIN unset,
	 * adapter-node builds the request URL FROM the Host header and defaults the protocol to https,
	 * so server-side the two always agree on host and port and disagree only on scheme, which the
	 * Host header does not carry. A server-side comparison there would have both sides derived from
	 * one source: it reads as a check and it is an identity.
	 *
	 * `location.origin` is exactly what the browser will put in the Origin header, and the server
	 * origin in the meta tag is exactly what SvelteKit compares that header against. So this is
	 * Kit's own CSRF predicate evaluated one GET early: it fires if and only if the next form
	 * submission would be refused. That is why it needs no exception for a reverse proxy that
	 * rewrites Host, and why it covers both an unset ORIGIN and one set to the wrong port.
	 *
	 * `page.url.origin` is NOT usable as the server side of this comparison: on the client
	 * SvelteKit builds `page.url` from `location.href`, so it would be the same source twice.
	 *
	 * The zero-JS alternative is Referer, which under this app's `Referrer-Policy: same-origin` does
	 * carry the browser's scheme. It is absent on the first navigation, which is why it was not used.
	 */
	$effect(() => {
		if (page.url.pathname === ORIGIN_MISMATCH_ROUTE) return;
		const expected = readServerOrigin(document);
		// Absent or unreplaced means the transport is broken, not that the origins agree. Say
		// nothing rather than send everyone to a diagnostic page over a missing meta tag.
		if (!expected) return;
		if (window.location.origin === expected) return;
		// The literal, not ORIGIN_MISMATCH_ROUTE: resolve() takes a route id and is typed against
		// the generated route union, so it will not accept a string variable. The constant still
		// governs the pathname comparison above, which is the half that has to agree with the route.
		void goto(resolve('/setup/origin-mismatch'));
	});
</script>
