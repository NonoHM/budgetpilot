import { describe, expect, it, vi } from 'vitest';
import { requestLocalBudgetInsights } from './local-llm';

/**
 * One generation is TWO requests since #524: a connect probe on `/api/version`, then the generation
 * on `/api/chat`. The probe carries its own small budget so a stopped Ollama is refused in about two
 * seconds instead of costing the whole generation budget.
 *
 * That is why these mocks route on the path instead of queueing responses. A
 * `mockResolvedValueOnce` carrying only the chat response now feeds the PROBE, and the real chat
 * call escapes to the network, where it hangs until the test's own 5 s limit. The failure then reads
 * as "timed out", which is a fact about the mock rather than about the code, and the in-flight real
 * request lands on the NEXT test's fresh spy and reports calls that test never made. Both were
 * observed on this file before the helper existed.
 *
 * `probe` is a parameter rather than a constant so the probe leg can be put under test itself: a
 * probe that never settles is what a stopped Ollama actually looks like.
 */
function mockOllamaFetch(
	chat: (init: RequestInit) => Promise<Response>,
	probe: () => Promise<Response> = async () =>
		new Response(JSON.stringify({ version: '0.32.5' }), { status: 200 })
) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;
		return url.endsWith('/api/version') ? probe() : chat((init ?? {}) as RequestInit);
	});
}

describe('requestLocalBudgetInsights', () => {
	it('refuse une URL LLM non locale sans appeler fetch', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'https://example.com'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('refuse une redirection Ollama vers un hôte non autorisé (#215) et ne le contacte jamais', async () => {
		expect.assertions(3);

		// Base URL allowlisted, but Ollama answers 302 to a non-allowlisted internal host.
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: 'http://127.0.0.2:9998/latest/meta-data/' }
			})
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(result?.unavailable).toBe(true);
		// Only the first (allowlisted) hop ran; the internal target was never requested.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
			'http://127.0.0.2:9998/latest/meta-data/'
		);

		fetchMock.mockRestore();
	});

	it('retourne unavailable quand le contenu renvoyé par Ollama n’est pas du JSON valide', async () => {
		expect.assertions(2);

		const fetchMock = mockOllamaFetch(
			async () =>
				new Response(
					JSON.stringify({
						message: { content: 'ceci n’est pas du JSON' }
					}),
					{ status: 200 }
				)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(result?.unavailable).toBe(true);
		expect(result?.insights).toEqual([]);

		fetchMock.mockRestore();
	});

	it('retourne unavailable quand le JSON est syntaxiquement valide mais hors schéma (title manquant)', async () => {
		expect.assertions(2);

		const fetchMock = mockOllamaFetch(
			async () =>
				new Response(
					JSON.stringify({
						message: {
							content: JSON.stringify({
								summary: 'ok',
								insights: [{ message: 'sans titre', severity: 'info', category: 'budget' }]
							})
						}
					}),
					{ status: 200 }
				)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(result?.unavailable).toBe(true);
		expect(result?.insights).toEqual([]);

		fetchMock.mockRestore();
	});

	it('retourne unavailable quand un champ dépasse la longueur maximale autorisée', async () => {
		expect.assertions(1);

		const fetchMock = mockOllamaFetch(
			async () =>
				new Response(
					JSON.stringify({
						message: {
							content: JSON.stringify({ summary: 'x'.repeat(161), insights: [] })
						}
					}),
					{ status: 200 }
				)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('n’appelle jamais fetch quand LLM_ALLOWED_HOSTS ne whiteliste pas l’hôte fourni', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://host.docker.internal:11434',
			LLM_ALLOWED_HOSTS: 'un-autre-hote.example'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('accepte un hôte custom listé dans LLM_ALLOWED_HOSTS', async () => {
		expect.assertions(2);

		const fetchMock = mockOllamaFetch(
			async () =>
				new Response(
					JSON.stringify({
						message: {
							content: JSON.stringify({ summary: 'ok', insights: [] })
						}
					}),
					{ status: 200 }
				)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://host.docker.internal:11434',
			LLM_ALLOWED_HOSTS: 'host.docker.internal'
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'http://host.docker.internal:11434/api/chat',
			expect.objectContaining({ method: 'POST' })
		);
		expect(result?.summary).toBe('ok');

		fetchMock.mockRestore();
	});

	it('rejette un hôte non listé même quand LLM_ALLOWED_HOSTS est renseigné avec d’autres hôtes', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://autre-hote.example:11434',
			LLM_ALLOWED_HOSTS: 'host.docker.internal, localhost'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('rejette un protocole non-HTTP même avec LLM_ALLOWED_HOSTS renseigné', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'https://host.docker.internal:11434',
			LLM_ALLOWED_HOSTS: 'host.docker.internal'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('reste strict par défaut (localhost/127.0.0.1/::1 uniquement) quand LLM_ALLOWED_HOSTS est absent', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://host.docker.internal:11434'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('accepte toujours 127.0.0.1 quand LLM_ALLOWED_HOSTS est absent', async () => {
		expect.assertions(1);

		const fetchMock = mockOllamaFetch(
			async () =>
				new Response(
					JSON.stringify({
						message: { content: JSON.stringify({ summary: 'ok', insights: [] }) }
					}),
					{ status: 200 }
				)
		);
		await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(fetchMock).toHaveBeenCalled();

		fetchMock.mockRestore();
	});

	it('rejette http: pour un hôte distant non-Docker même listé dans LLM_ALLOWED_HOSTS', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://vps.example.com:11434',
			LLM_ALLOWED_HOSTS: 'vps.example.com'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('accepte https: pour un hôte distant non-Docker listé dans LLM_ALLOWED_HOSTS', async () => {
		expect.assertions(2);

		const fetchMock = mockOllamaFetch(
			async () =>
				new Response(
					JSON.stringify({
						message: { content: JSON.stringify({ summary: 'ok', insights: [] }) }
					}),
					{ status: 200 }
				)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'https://vps.example.com:11434',
			LLM_ALLOWED_HOSTS: 'vps.example.com'
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'https://vps.example.com:11434/api/chat',
			expect.objectContaining({ method: 'POST' })
		);
		expect(result?.summary).toBe('ok');

		fetchMock.mockRestore();
	});

	it('rejette http: pour un hôte non-loopback non listé dans LLM_HTTP_PERMITTED_HOSTS', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://ollama:11434',
			LLM_ALLOWED_HOSTS: 'ollama'
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result?.unavailable).toBe(true);

		fetchMock.mockRestore();
	});

	it('accepte http: pour un hôte listé dans LLM_HTTP_PERMITTED_HOSTS (ex. service Docker Compose)', async () => {
		expect.assertions(2);

		const fetchMock = mockOllamaFetch(
			async () =>
				new Response(
					JSON.stringify({
						message: { content: JSON.stringify({ summary: 'ok', insights: [] }) }
					}),
					{ status: 200 }
				)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://ollama:11434',
			LLM_ALLOWED_HOSTS: 'ollama',
			LLM_HTTP_PERMITTED_HOSTS: 'ollama'
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'http://ollama:11434/api/chat',
			expect.objectContaining({ method: 'POST' })
		);
		expect(result?.summary).toBe('ok');

		fetchMock.mockRestore();
	});

	it('autorise Ollama sur localhost', async () => {
		expect.assertions(2);

		const fetchMock = mockOllamaFetch(
			async () =>
				new Response(
					JSON.stringify({
						message: {
							content: JSON.stringify({ summary: 'ok', insights: [] })
						}
					}),
					{ status: 200 }
				)
		);
		const result = await requestLocalBudgetInsights('prompt agrégé', {
			LLM_ENABLED: 'true',
			LLM_PROVIDER: 'ollama',
			LLM_BASE_URL: 'http://127.0.0.1:11434'
		});

		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:11434/api/chat',
			expect.objectContaining({ method: 'POST' })
		);
		expect(result?.summary).toBe('ok');

		fetchMock.mockRestore();
	});
});

/**
 * WHICH of the five states the run ended in (#524), not merely that it ended badly.
 *
 * `unavailable: true` had five producers and one message. These tests exist to keep them five, and
 * each one names the two states it separates, because "unavailable" was green for all five and that
 * is precisely why the defect shipped.
 *
 * The failures are driven through the REAL mechanisms rather than by handing the classifier a
 * hand-built error object. A fabricated `{ name: 'TimeoutError' }` would assert that the recogniser
 * reads a field this test just wrote, which is the retyped-oracle shape AGENTS.md forbids: it passes
 * whether or not `AbortSignal.timeout` actually produces that shape. So the abort is a real
 * `AbortSignal.timeout` firing, and the 404 is a real `Response` the Ollama client converts.
 */
describe('requestLocalBudgetInsights failure codes', () => {
	/** Like `mockOllamaFetch`, but the chat leg receives `init` so it can honour the abort signal. */
	function mockOllamaWithSignal(
		chat: (init: RequestInit) => Promise<Response>,
		probe: (init: RequestInit) => Promise<Response> = async () =>
			new Response(JSON.stringify({ version: '0.32.5' }), { status: 200 })
	) {
		return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
			const url =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.href
						: (input as Request).url;
			const requestInit = (init ?? {}) as RequestInit;
			return url.endsWith('/api/version') ? probe(requestInit) : chat(requestInit);
		});
	}

	/** What a hung Ollama looks like: the socket is open and nothing ever comes back. */
	const neverAnswers = (init: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			const { signal } = init;
			signal?.addEventListener('abort', () => reject(signal.reason));
		});

	const baseEnv = {
		LLM_ENABLED: 'true',
		LLM_PROVIDER: 'ollama',
		LLM_BASE_URL: 'http://127.0.0.1:11434'
	};

	/** Structural parameter type: `ReturnType<typeof vi.spyOn>` drops the generics and lands on `any`. */
	function chatCalls(fetchMock: { mock: { calls: unknown[][] } }): string[] {
		return fetchMock.mock.calls
			.map((call) => String(call[0]))
			.filter((url) => url.endsWith('/api/chat'));
	}

	it('separates a refused base URL from an unreachable one: not_configured, and no socket at all', async () => {
		expect.assertions(2);

		const fetchMock = vi.spyOn(globalThis, 'fetch');
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', {
				...baseEnv,
				LLM_BASE_URL: 'http://autre-hote.example:11434'
			});

			// The distinction the card depends on: nothing was contacted, so "check that it is running"
			// would be advice about a service this instance was never willing to call.
			expect(result?.failureCode).toBe('not_configured');
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('separates a stopped Ollama from a slow one: unreachable, bounded by the CONNECT budget', async () => {
		expect.assertions(4);

		// The probe hangs, which is what a stopped service behind a firewall looks like: no refusal,
		// just silence. The generation budget is three orders of magnitude larger than the connect
		// budget, so the two states this separates are "gave up at connect" and "waited on generation",
		// and the elapsed time can only fall in one of them.
		// `neverAnswers` on the PROBE leg, not a promise that ignores the signal. A mock that never
		// settles and never listens for `abort` hangs past the runner's own limit and reports a
		// timeout, which is a fact about the mock. Honouring the signal is also what makes this test
		// assert something real: it fails if the connect budget never reaches the probe's fetch.
		const fetchMock = mockOllamaWithSignal(
			async () => new Response('{}', { status: 200 }),
			neverAnswers
		);
		try {
			const startedAt = Date.now();
			const result = await requestLocalBudgetInsights('prompt agrégé', {
				...baseEnv,
				LLM_CONNECT_TIMEOUT_MS: '50',
				LLM_TIMEOUT_MS: '30000'
			});
			const elapsedMs = Date.now() - startedAt;

			expect(result?.failureCode).toBe('unreachable');
			// The generation budget was never opened. This is the assertion that makes the fix a fix
			// rather than a bigger number: a dead Ollama costs the connect budget, not 30 seconds.
			expect(chatCalls(fetchMock)).toEqual([]);
			expect(elapsedMs).toBeLessThan(5_000);
			expect(elapsedMs).toBeGreaterThanOrEqual(50);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('separates a cold load from a stopped service: cold_start, because the probe already answered', async () => {
		expect.assertions(2);

		// Ollama accepted the connection and is loading the model into VRAM, which is exactly the
		// reported bug: `499 after 10.285320802s`, "client connection closed before llama-server
		// finished loading". The probe answers, the generation does not, and only the ORDER of those
		// two facts distinguishes this from the test above. A real AbortSignal.timeout produces the
		// abort, so this also asserts that the signal reaches the fetch at all.
		const fetchMock = mockOllamaWithSignal(neverAnswers);
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', {
				...baseEnv,
				LLM_CONNECT_TIMEOUT_MS: '5000',
				LLM_TIMEOUT_MS: '50'
			});

			expect(result?.failureCode).toBe('cold_start');
			expect(chatCalls(fetchMock)).toHaveLength(1);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('separates a missing model from an absent service: model_unavailable on a real 404', async () => {
		expect.assertions(2);

		// The Ollama client turns a 404 into its own ResponseError; nothing here fabricates one, so a
		// client that stopped doing that would redden this rather than passing on a shape we invented.
		const fetchMock = mockOllamaWithSignal(
			async () =>
				new Response(JSON.stringify({ error: 'model "qwen2.5:0.5b" not found' }), { status: 404 })
		);
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', baseEnv);

			expect(result?.failureCode).toBe('model_unavailable');
			expect(chatCalls(fetchMock)).toHaveLength(1);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('separates an unreadable answer from an absent one: response_unusable after a completed generation', async () => {
		expect.assertions(2);

		const fetchMock = mockOllamaWithSignal(
			async () =>
				new Response(JSON.stringify({ message: { content: 'ceci n’est pas du JSON' } }), {
					status: 200
				})
		);
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', baseEnv);

			// The generation SUCCEEDED and the reading failed, which is the one state where telling the
			// operator to check that Ollama is running points at a service that is working.
			expect(result?.failureCode).toBe('response_unusable');
			expect(chatCalls(fetchMock)).toHaveLength(1);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('reports response_unusable when the generation returns an EMPTY message rather than a bad one', async () => {
		expect.assertions(2);

		// A SECOND producer of the same code, and it exists because a break-check found the first test
		// did not reach it: rewriting the `!content` branch to return `cold_start` left this file
		// entirely green, so that branch was covered by nothing. Empty content and unparseable content
		// travel different paths (`requestLocalBudgetInsights` versus `parseLocalLlmContent`) and only
		// this fixture separates "the model said nothing" from "the model said something unreadable".
		const fetchMock = mockOllamaWithSignal(
			async () => new Response(JSON.stringify({ message: { content: '' } }), { status: 200 })
		);
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', baseEnv);

			expect(result?.failureCode).toBe('response_unusable');
			expect(chatCalls(fetchMock)).toHaveLength(1);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('separates a truncated answer from an unreadable one: response_truncated on done_reason length', async () => {
		expect.assertions(2);

		// THE STATE THAT ARRIVED BY ACCIDENT. Ollama returns 200 with a `done_reason` of "length" when
		// the generation hits `num_predict`, and the JSON stops mid-object. `JSON.parse` fails exactly
		// as it does on garbage, so the two were one code and one sentence until `done_reason` was read.
		//
		// The distinction is not cosmetic: truncation is OUR fault and means raise the ceiling, while an
		// unreadable answer is the model's and means try a different one. The fixture is a real prefix
		// of a valid response rather than random text, because that is what truncation produces.
		const fetchMock = mockOllamaWithSignal(
			async () =>
				new Response(
					JSON.stringify({
						message: { content: '{"summary":"Vos dépenses","insights":[{"title":"Aliment' },
						done_reason: 'length'
					}),
					{ status: 200 }
				)
		);
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', baseEnv);

			expect(result?.failureCode).toBe('response_truncated');
			expect(chatCalls(fetchMock)).toHaveLength(1);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('keeps response_unusable for the SAME broken JSON when the model stopped on its own', async () => {
		expect.assertions(1);

		// The other half, and the only assertion that proves the code is read from `done_reason` rather
		// than from the parse failing. Byte-for-byte the same unparseable content as the test above;
		// only `done_reason` differs. Without this pair, hardcoding either code passes one test.
		const fetchMock = mockOllamaWithSignal(
			async () =>
				new Response(
					JSON.stringify({
						message: { content: '{"summary":"Vos dépenses","insights":[{"title":"Aliment' },
						done_reason: 'stop'
					}),
					{ status: 200 }
				)
		);
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', baseEnv);
			expect(result?.failureCode).toBe('response_unusable');
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('keeps a truncated answer whose JSON is nevertheless complete and schema-valid', async () => {
		expect.assertions(3);

		// HALF 2 OF THE `done_reason` RULE, and the only case that can see it. The pair above varies
		// `done_reason` over the SAME broken content, so both of its cells fail to parse and neither
		// reaches the accept path: they separate the two failure CODES and say nothing about whether a
		// truncated-but-readable answer survives.
		//
		// Which two states this separates: « the answer is usable » from « the generation was cut short ».
		// `done_reason` is `length` here and the content is complete and valid, which Ollama does produce
		// — the ceiling can be reached on trailing tokens after the object has closed. Reading
		// `truncated` on the accept path would report `response_truncated` for this response and tell the
		// reader the advice could not be read, over advice that reads fine.
		//
		// Break-check: making the accept path return `unreadable(truncated)` reddens the first assertion
		// with `response_truncated`, which is the state this pins against. Not merely « something failed »
		// — the failure names the wrong verdict.
		const fetchMock = mockOllamaWithSignal(
			async () =>
				new Response(
					JSON.stringify({
						message: {
							content: JSON.stringify({
								summary: 'Vos dépenses ont augmenté',
								insights: [
									{
										title: 'Alimentation en hausse',
										message: 'Vous avez dépensé davantage quen juin.',
										severity: 'warning',
										category: 'spending'
									}
								]
							})
						},
						done_reason: 'length'
					}),
					{ status: 200 }
				)
		);
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', baseEnv);

			expect(result?.failureCode).toBeUndefined();
			expect(result?.unavailable).toBeUndefined();
			expect(result?.insights).toHaveLength(1);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('strips markdown the model emitted, so the reader never sees the asterisks', async () => {
		expect.assertions(3);

		// The fifth producer, and the only one found by USING the feature rather than by reading a log.
		// ministral emits « **35%** » into an insight; nothing in the schema or the prompt forbids it,
		// so what renders depends on which model the operator pulled. Asserted through the whole
		// reception path rather than on `stripMarkdown` alone, because the unit is already covered and
		// what was missing is the WIRING: the strip existing and the strip being applied are different
		// facts, and only this test separates them.
		const fetchMock = mockOllamaWithSignal(
			async () =>
				new Response(
					JSON.stringify({
						message: {
							content: JSON.stringify({
								summary: 'Vos **dépenses** ont augmenté',
								insights: [
									{
										title: '`Alimentation` en hausse',
										message: 'Vous avez dépensé **35%** de plus quen juin.',
										severity: 'warning',
										category: 'spending'
									}
								]
							})
						},
						done_reason: 'stop'
					}),
					{ status: 200 }
				)
		);
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', baseEnv);

			expect(result?.summary).toBe('Vos dépenses ont augmenté');
			expect(result?.insights[0]?.title).toBe('Alimentation en hausse');
			expect(result?.insights[0]?.message).toBe('Vous avez dépensé 35% de plus quen juin.');
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('sets no failure code on a successful generation, so the card cannot render a reason for a success', async () => {
		expect.assertions(3);

		const fetchMock = mockOllamaWithSignal(
			async () =>
				new Response(
					JSON.stringify({
						message: { content: JSON.stringify({ summary: 'ok', insights: [] }) }
					}),
					{ status: 200 }
				)
		);
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', baseEnv);

			expect(result?.summary).toBe('ok');
			expect(result?.unavailable).toBeUndefined();
			expect(result?.failureCode).toBeUndefined();
		} finally {
			fetchMock.mockRestore();
		}
	});
});

/**
 * THESE TWO ASSERT ABOUT THE REQUEST, NOT ABOUT THE OUTCOME, and that is a limit of this file
 * rather than a choice. Every test here mocks `globalThis.fetch`, so no response in this suite can
 * carry a `message.thinking` field: reasoning being SUPPRESSED is not observable from a mock, and a
 * test claiming to observe it would be asserting about its own fixture. What is observable is
 * whether the field leaves the process, which is the whole of the defect: nothing in the tree set
 * it. The outcome half was measured against a real reasoning model and lives in #527: the same
 * prompt returned `done_reason: length`, 1060 tokens and zero characters of content without the
 * field, and `stop`, 282 tokens and complete French JSON with it.
 */
describe('requestLocalBudgetInsights generation request', () => {
	const baseEnv = {
		LLM_ENABLED: 'true',
		LLM_PROVIDER: 'ollama',
		LLM_BASE_URL: 'http://127.0.0.1:11434'
	};

	/**
	 * Reads the body the Ollama client actually serialised for `/api/chat`, rather than trusting the
	 * options object we handed it. The client owns the mapping from its arguments to the wire, so
	 * asserting on our own input would assert that we called a function with what we passed it.
	 */
	function chatBody(): { body: () => Record<string, unknown>; restore: () => void } {
		let captured: string | null = null;
		// Built on `mockOllamaFetch` rather than beside it: the two-request routing it documents is
		// the thing that must stay true, and a second copy of it here would be a second place to keep
		// true. All this adds is recording the body of the leg that reaches `/api/chat`.
		const fetchMock = mockOllamaFetch(async (init) => {
			captured = typeof init.body === 'string' ? init.body : null;
			return new Response(
				JSON.stringify({
					message: { content: JSON.stringify({ summary: 'ok', insights: [] }) },
					done_reason: 'stop'
				}),
				{ status: 200 }
			);
		});
		return {
			body: () => {
				// An unread body and a body missing a field print the same `undefined` one line down, so
				// the absence is refused here rather than reported as a failed field assertion.
				if (captured === null) throw new Error('no /api/chat request body was captured');
				return JSON.parse(captured) as Record<string, unknown>;
			},
			restore: () => fetchMock.mockRestore()
		};
	}

	it('sends think: false, so a reasoning model spends its ceiling on the answer', async () => {
		expect.assertions(2);

		// Separates « the field reaches Ollama » from « the field was never sent », which is the state
		// this repository was in: `ChatRequest.think` exists in the client we depend on and no call
		// site set it. A model that reasons puts its reasoning tokens through the same `num_predict`
		// budget as the answer, so on the model measured in #527 the reasoning consumed the entire
		// ceiling and the answer was empty, not degraded but absent.
		const capture = chatBody();
		try {
			const result = await requestLocalBudgetInsights('prompt agrégé', {
				...baseEnv,
				LLM_MODEL: 'qwen3.5:4b-q8_0'
			});

			expect(result?.unavailable).toBeUndefined();
			expect(capture.body().think).toBe(false);
		} finally {
			capture.restore();
		}
	});

	it('sends it for a model that cannot reason too, so nothing gates the field on the model', async () => {
		expect.assertions(2);

		// Separates « sent unconditionally » from « sent only when the model looks like a reasoning
		// one ». That gate is the plausible next change: `/api/tags` reports a `capabilities` array
		// carrying `thinking`, so a probe is available and would look like diligence. #527 measured
		// that it buys nothing (`qwen2.5:0.5b` and `ministral-3:3b` both answer 200 with no error
		// field when sent `think: false`) and it would cost a request, a branch and a second thing to
		// keep true. Without this test the gate could be added and the suite would stay green.
		//
		// Where the field lives was CHECKED against a running server rather than against the client's
		// types, and the two disagree: Ollama 0.32.5 returns `capabilities` per model on `/api/tags`
		// (`thinking` present for qwen3.5:4b-q8_0, absent for qwen2.5:0.5b), while `ollama@0.6.3`
		// declares it only on `ShowResponse`, so `ModelResponse` has no such field and the typed
		// client cannot see what the endpoint sends. A reviewer reading the `.d.ts` alone concluded
		// the endpoint does not carry it, which is why the source of the answer is named here.
		const capture = chatBody();
		try {
			// No LLM_MODEL: the default is `qwen2.5:0.5b`, which `/api/tags` reports with no `thinking`
			// capability. The name is retyped from `DEFAULT_MODEL` rather than imported (it is not
			// exported), and the assertion on it is deliberate rather than incidental: it pins the
			// PREMISE this test rests on, so changing the default to some other model reddens here and
			// forces someone to confirm the new default cannot reason either.
			await requestLocalBudgetInsights('prompt agrégé', baseEnv);

			expect(capture.body().model).toBe('qwen2.5:0.5b');
			expect(capture.body().think).toBe(false);
		} finally {
			capture.restore();
		}
	});
});
