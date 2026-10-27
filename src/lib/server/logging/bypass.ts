import { log } from '$lib/server/logging';
import { ATTRIBUTE as A, EVENT as E } from './names.ts';
import type { RedirectRefusal, RedirectUpstream } from './events.ts';

/**
 * The outbound redirect guard refused to follow a redirect (L4b, #250). Closed values only: the host
 * and the URL are what the remote chose, so neither is a field, and there is no client or user (R1;
 * the party a refused redirect implicates is the upstream).
 */
export function logRedirectRefused(reason: RedirectRefusal, upstream: RedirectUpstream): void {
	log({
		event: E.redirectRefused,
		attributes: { [A.redirectReason]: reason, [A.redirectUpstream]: upstream }
	});
}
