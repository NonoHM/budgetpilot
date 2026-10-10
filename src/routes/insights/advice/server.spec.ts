import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /insights/advice` (#535): the only route that starts a model generation. What is asserted
 * here is the door, not the model: who may knock, with what, and that nothing behind the door runs
 * for a refused knock. The gateway and the reads are faked so their call counts are the measure.
 */
const gateway = vi.hoisted(() => ({
	generateAdvice: vi.fn(async () => ({ insights: [], unavailable: false })),
	prepareAdvice: vi.fn(() => ({ key: 'a'.repeat(64), prompt: 'p' })),
	adviceEpoch: vi.fn(() => 7)
}));
vi.mock('$lib/server/ai/gateway', () => gateway);

const periodData = vi.hoisted(() => ({ readDashboardPeriodData: vi.fn(async () => ({})) }));
vi.mock('$lib/server/dashboard/periodData', () => periodData);

const preferences = vi.hoisted(() => ({
	value: { aiInsightsEnabled: true, aiIncludeLabels: false },
	read: vi.fn()
}));
vi.mock('$lib/server/db', () => ({
	prisma: {
		user: {
			findUniqueOrThrow: preferences.read.mockImplementation(async () => preferences.value)
		}
	}
}));

const { POST } = await import('./+server');

const ORIGIN = 'http://app.example.test';
const KEY = 'a'.repeat(64);
const USER = { id: 'user-a', sessionId: 'session-a' };

function call(options: { headers?: Record<string, string>; body?: string; signal?: AbortSignal }) {
	const request = new Request(`${ORIGIN}/insights/advice`, {
		method: 'POST',
		headers: options.headers ?? { 'sec-fetch-site': 'same-origin' },
		body: options.body ?? JSON.stringify({ period: 'period=last-month', aiAdviceKey: KEY }),
		signal: options.signal
	});
	return POST({
		request,
		url: new URL(request.url),
		locals: { user: USER }
	} as never);
}

async function statusOf(promise: Promise<Response> | Response): Promise<number> {
	try {
		return (await promise).status;
	} catch (thrown) {
		return (thrown as { status: number }).status;
	}
}

describe('POST /insights/advice (#535)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv('LLM_ENABLED', 'true');
		preferences.value = { aiInsightsEnabled: true, aiIncludeLabels: false };
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// The control: a same-origin call does reach the gateway, so every 0 below is a refusal and not
	// a fake that is never wired.
	it('a same-origin call reaches the gateway once, for the session user', async () => {
		expect(await statusOf(call({}))).toBe(200);
		expect(gateway.generateAdvice).toHaveBeenCalledTimes(1);
		expect(gateway.generateAdvice).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'user-a' })
		);
	});

	// A cross-site page posting with the member's cookie (`no-cors`, a simple request SvelteKit's
	// own check does not cover) versus the dashboard's own fetch.
	it.each(['cross-site', 'same-site', 'none'])(
		'refuses Sec-Fetch-Site %s with 403 before any read or model work',
		async (site) => {
			expect(await statusOf(call({ headers: { 'sec-fetch-site': site } }))).toBe(403);
			expect(periodData.readDashboardPeriodData).not.toHaveBeenCalled();
			expect(gateway.generateAdvice).not.toHaveBeenCalled();
		}
	);

	// A browser without Fetch Metadata still sends Origin on a POST: equal is the app, different is
	// another site, and neither header at all is not a browser this card runs in.
	it('without Sec-Fetch-Site, admits an equal Origin and refuses a different or missing one', async () => {
		expect(await statusOf(call({ headers: { origin: ORIGIN } }))).toBe(200);
		expect(await statusOf(call({ headers: { origin: 'http://evil.example.test' } }))).toBe(403);
		expect(await statusOf(call({ headers: {} }))).toBe(403);
		expect(gateway.generateAdvice).toHaveBeenCalledTimes(1);
	});

	// Positive validation: the period must be exactly the canonical form the dashboard serialised.
	// Every case carries everything else valid, so each is refused for its own reason only (a
	// break-check found the non-canonical case refused for its missing key instead).
	it.each([
		['not JSON', 'period=last-month'],
		['no period', JSON.stringify({ aiAdviceKey: KEY })],
		['a period that is not a string', JSON.stringify({ period: 3, aiAdviceKey: KEY })],
		[
			'a period that is not canonical',
			JSON.stringify({ period: 'period=bogus', aiAdviceKey: KEY })
		],
		[
			'a canonical period with an extra parameter',
			JSON.stringify({ period: 'period=last-month&x=1', aiAdviceKey: KEY })
		],
		['no key', JSON.stringify({ period: 'period=last-month' })],
		[
			'a key that is not a sha256 digest',
			JSON.stringify({ period: 'period=last-month', aiAdviceKey: 'k' })
		]
	])('refuses %s with 400 and starts nothing', async (_name, body) => {
		expect(await statusOf(call({ body }))).toBe(400);
		expect(gateway.generateAdvice).not.toHaveBeenCalled();
	});

	// The member is the session's, never the body's: a posted userId is a claim (AGENTS.md).
	it('ignores a userId in the body', async () => {
		await call({
			body: JSON.stringify({ period: 'period=last-month', aiAdviceKey: KEY, userId: 'user-b' })
		});
		expect(periodData.readDashboardPeriodData).toHaveBeenCalledWith('user-a', expect.anything());
		expect(gateway.generateAdvice).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'user-a' })
		);
	});

	// The switches are read on the server for every call, versus a card that kept a stale `aiAllowed`.
	it.each([
		['the instance switch is off', () => vi.stubEnv('LLM_ENABLED', 'false')],
		[
			'the member turned the AI off',
			() => (preferences.value = { aiInsightsEnabled: false, aiIncludeLabels: false })
		]
	])('when %s, answers no advice and starts nothing', async (_name, arrange) => {
		arrange();
		const response = await call({});
		// Stale, like a key that no longer matches: the page was drawn with the AI on (perhaps another
		// tab turned it off), so the page reloads and the card disappears (narrow pass F3), versus
		// an action that posts and comes back idle forever.
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ stale: true });
		expect(gateway.generateAdvice).not.toHaveBeenCalled();
	});

	// Final pass F1: the period is resolved again on the server's clock, and the data may have changed
	// since the page was drawn. The key the card was shown must still be the key of what would be
	// sent, versus advice about November beside October's figures after midnight on the 31st.
	it('refuses with 409 when the key the card was shown no longer matches, and starts nothing', async () => {
		gateway.prepareAdvice.mockReturnValueOnce({ key: 'b'.repeat(64), prompt: 'p' });
		const response = await call({});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ stale: true });
		expect(gateway.generateAdvice).not.toHaveBeenCalled();
	});

	// The request's own signal is what a closed tab fires: it must reach the generation.
	it('passes the request signal to the gateway', async () => {
		const controller = new AbortController();
		await call({ signal: controller.signal });
		const passed = (gateway.generateAdvice.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0]
			.signal;
		controller.abort();
		expect(passed.aborted).toBe(true);
	});

	// Rev 1 F1: the adapter aborts `request.signal` only while the body is unread, so the endpoint
	// reads the body first and that signal is inert afterwards. The streamed answer's cancel, which
	// SvelteKit's setResponse calls on the socket's close, is what reaches the generation.
	it('cancelling the answer stream aborts the signal the gateway holds', async () => {
		let release!: () => void;
		gateway.generateAdvice.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ insights: [], unavailable: false });
				})
		);
		const response = await call({});
		await vi.waitFor(() => expect(gateway.generateAdvice).toHaveBeenCalledTimes(1));
		const passed = (gateway.generateAdvice.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0]
			.signal;
		expect(passed.aborted).toBe(false);
		await response.body!.cancel();
		expect(passed.aborted).toBe(true);
		release();
	});

	// Rev 1 F2: the epoch is read BEFORE the switches, so an opt-out landing between the switch read
	// and admission moves the epoch this request carries. Read after, the window reopens.
	it('reads the member epoch before the switches and hands it to the gateway', async () => {
		await call({});
		expect(gateway.adviceEpoch).toHaveBeenCalledWith('user-a');
		expect(gateway.adviceEpoch.mock.invocationCallOrder[0]).toBeLessThan(
			preferences.read.mock.invocationCallOrder[0]
		);
		expect(gateway.generateAdvice).toHaveBeenCalledWith(expect.objectContaining({ epoch: 7 }));
	});

	it('returns what the gateway answered, as JSON', async () => {
		gateway.generateAdvice.mockResolvedValueOnce({
			insights: [],
			unavailable: true,
			failureCode: 'busy'
		} as never);
		const response = await call({});
		expect(await response.json()).toEqual({ insights: [], unavailable: true, failureCode: 'busy' });
	});
});
