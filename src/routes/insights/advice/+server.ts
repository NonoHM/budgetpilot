import { error, json } from '@sveltejs/kit';
import { adviceEpoch, generateAdvice, prepareAdvice } from '$lib/server/ai/gateway';
import { requireUser } from '$lib/server/auth';
import { readDashboardPeriodData } from '$lib/server/dashboard/periodData';
import { parseDateRange, serializePeriodParams, type DateRange } from '$lib/server/date-range';
import { prisma } from '$lib/server/db';
import { isLocalLlmEnabled } from '$lib/server/insights/local-llm';
import type { LocalAiAdvice } from '$lib/server/insights/types';
import type { RequestHandler } from './$types';

/**
 * The only route that starts a model generation (#535). The dashboard `load` used to start one per
 * load, hover prefetches included, with nothing bounding how many ran at once; it now returns a key,
 * and the card posts here when the key changes.
 *
 * ## Same-origin, checked here
 *
 * SvelteKit's own CSRF check covers the form content types only. A cross-site page can still send a
 * `no-cors` POST whose body carries no content type (a type-less Blob) with the member's cookie,
 * which is a simple request, needs no preflight and passes that check,
 * so this route checks Fetch Metadata itself (ASVS v5.0.0-3.5.3, spec F8): `Sec-Fetch-Site` must be
 * `same-origin`, or, from a browser that does not send it, `Origin` must be this origin. A request
 * carrying neither is not the card.
 *
 * ## The answer is a stream, so a closed tab can cancel it
 *
 * The Node adapter aborts `request.signal` only while the request body is still unread, and this
 * route reads it first, so that signal never fires afterwards (rev 1 F1 of the design note). The
 * answer is therefore a stream whose `cancel` aborts the generation: SvelteKit's `setResponse`
 * cancels the body's reader when the socket closes. The card's own abort on a period change closes
 * the socket the same way.
 */
export const POST: RequestHandler = async ({ request, locals, url }) => {
	if (!isSameOrigin(request, url)) error(403);
	const user = requireUser(locals.user);
	const posted = await readBody(request);
	if (!posted) error(400);

	// The epoch BEFORE the switches: an opt-out landing after the read below moves it, and admission
	// then refuses this request instead of generating after the member said no (rev 1 F2).
	const epoch = adviceEpoch(user.id);
	const preferences = await prisma.user.findUniqueOrThrow({
		where: { id: user.id },
		select: { aiInsightsEnabled: true, aiIncludeLabels: true }
	});
	if (!isLocalLlmEnabled(process.env) || !preferences.aiInsightsEnabled) {
		// Stale: the page was drawn with the AI on and it is off now (perhaps from another tab). The
		// card reloads the page's data, which removes the card, rather than offering an action that
		// can only come back idle (narrow pass F3).
		return json({ stale: true }, { status: 409 });
	}

	const periodData = await readDashboardPeriodData(user.id, posted.period);
	const prepared = prepareAdvice({ periodData, includeLabels: preferences.aiIncludeLabels });
	// The key the card was shown must still be the key of what would be sent (final pass F1). A
	// relative period resolves again on this clock, so « this month » opened at 00:01 on the 1st is
	// another month than the figures on screen; data may also have changed in another tab. The card
	// reloads the page's data on 409 and asks again with the new key.
	if (prepared.key !== posted.aiAdviceKey) return json({ stale: true }, { status: 409 });
	const cancelled = new AbortController();
	const signal = AbortSignal.any([request.signal, cancelled.signal]);
	const encoder = new TextEncoder();

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let advice: LocalAiAdvice;
			try {
				advice = await generateAdvice({ userId: user.id, prepared, epoch, signal });
			} catch {
				// `unreachable` for the same reason the dashboard's `.catch` used it: nothing downstream of
				// the gateway throws on a model failure (it answers a code), so reaching here means the
				// call never completed, and that is what unreachable names.
				advice = { insights: [], unavailable: true, failureCode: 'unreachable' };
			}
			if (signal.aborted) return;
			controller.enqueue(encoder.encode(JSON.stringify(advice)));
			controller.close();
		},
		cancel() {
			cancelled.abort();
		}
	});
	return new Response(body, { headers: { 'content-type': 'application/json' } });
};

function isSameOrigin(request: Request, url: URL): boolean {
	const site = request.headers.get('sec-fetch-site');
	if (site !== null) return site === 'same-origin';
	return request.headers.get('origin') === url.origin;
}

const ADVICE_KEY = /^[0-9a-f]{64}$/;

/**
 * Positive validation: the period must be EXACTLY the canonical form the dashboard serialised, so
 * anything else, an extra parameter included, is refused rather than read leniently; the key must be
 * a sha256 digest in lowercase hex, the only form `prepareAdvice` produces.
 */
async function readBody(
	request: Request
): Promise<{ period: DateRange; aiAdviceKey: string } | null> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return null;
	}
	if (typeof body !== 'object' || body === null) return null;
	const { period: written, aiAdviceKey } = body as { period?: unknown; aiAdviceKey?: unknown };
	if (typeof written !== 'string' || typeof aiAdviceKey !== 'string') return null;
	if (!ADVICE_KEY.test(aiAdviceKey)) return null;
	const period = parseDateRange(new URLSearchParams(written));
	return serializePeriodParams(period) === written ? { period, aiAdviceKey } : null;
}
