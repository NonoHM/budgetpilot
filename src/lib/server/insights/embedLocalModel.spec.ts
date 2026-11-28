import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBED_MAX_TEXT_CHARS, EMBED_MAX_TEXTS, embedLocalModel } from './local-llm';
import {
	DIGEST,
	MODEL,
	closeFakeHosts,
	envFor,
	fakeHost,
	goJson,
	tags,
	version,
	type Route
} from './fakeModelHost.fixture';

// Not halted (#986): the halt's own cases are `ai/inferenceHalt.db-smoke.ts`.
vi.mock('$lib/server/db', () => ({
	prisma: { inferenceHalt: { findUnique: async () => null } }
}));

/**
 * The embedding reader (#1015, B3) through the same door as the chat call. Each case names the two
 * states it separates; the shared door's own cases stay in `local-llm.spec.ts` and
 * `modelHostBounds.spec.ts`, which run against the same `throughModelHost`.
 */

afterEach(closeFakeHosts);

const embedder = { name: MODEL, digest: DIGEST };

const embed =
	(embeddings: unknown): Route =>
	(_req, res) => {
		res
			.writeHead(200, { 'Content-Type': 'application/json' })
			.end(goJson({ model: MODEL, embeddings, total_duration: 1, prompt_eval_count: 2 }));
	};

async function hostWith(embedRoute: Route) {
	return fakeHost({ '/api/version': version, '/api/tags': tags(), '/api/embed': embedRoute });
}

describe('embedLocalModel', () => {
	it('returns one vector per text, read under the digest listed before and after', async () => {
		const host = await hostWith(
			embed([
				[0.1, -0.2],
				[0.3, 0.4]
			])
		);
		const result = await embedLocalModel(['carrefour', 'edf'], embedder, envFor(host));
		expect(result).toStrictEqual({
			value: [
				[0.1, -0.2],
				[0.3, 0.4]
			],
			model: { digest: DIGEST, format: 'gguf' }
		});
		// Before and after: a list read once would hand over a vector from weights swapped mid-call.
		expect(host.hits['/api/tags']).toBe(2);
	});

	it('is off when the connection is off, without a socket', async () => {
		const host = await hostWith(embed([[1]]));
		const env = { ...envFor(host), LLM_ENABLED: 'false' };
		expect(await embedLocalModel(['a'], embedder, env)).toBeNull();
		expect(host.hits).toStrictEqual({});
	});

	// Pinned versus unpinned weights: other weights under the same name never receive a text.
	it('refuses other weights under the same name before sending them a text', async () => {
		const host = await hostWith(embed([[1]]));
		const other = { ...embedder, digest: 'f'.repeat(64) };
		const result = await embedLocalModel(['a'], other, envFor(host));
		expect(result).toStrictEqual({
			unavailable: true,
			failureCode: 'model_mismatch',
			notCharged: true
		});
		expect(host.hits['/api/embed']).toBeUndefined();
	});

	// A full answer versus one missing a vector: a short list would shift every label onto the
	// next one's vector.
	it('refuses an answer that does not hold one vector per text', async () => {
		const host = await hostWith(embed([[1, 2]]));
		const result = await embedLocalModel(['a', 'b'], embedder, envFor(host));
		expect(result).toStrictEqual({ unavailable: true, failureCode: 'response_unusable' });
	});

	// One width versus two: a cosine across widths compares nothing.
	it('refuses vectors of different widths', async () => {
		const host = await hostWith(embed([[1, 2], [3]]));
		const result = await embedLocalModel(['a', 'b'], embedder, envFor(host));
		expect(result).toStrictEqual({ unavailable: true, failureCode: 'response_unusable' });
	});

	// A bounded read versus a whole one: the bound for one text is about 100 KB. The 4 MB answer is
	// otherwise VALID, one vector of width 1 whose number is written with 4 MB of digits, so only
	// the bound can refuse it (a wide vector would be refused by the width check instead).
	it('stops reading an answer larger than one text can earn', async () => {
		const host = await hostWith((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(`{"model":"x","embeddings":[[0.5${'0'.repeat(4 * 1024 * 1024)}]]}`);
		});
		const result = await embedLocalModel(['a'], embedder, envFor(host));
		expect(result).toStrictEqual({ unavailable: true, failureCode: 'response_unusable' });
	});

	// The model host gets no redirect: the text stays on the base URL's host.
	it('follows no redirect from the embed endpoint', async () => {
		const elsewhere = await hostWith(embed([[1]]));
		const host = await hostWith((_req, res) => {
			res.writeHead(307, { Location: `${elsewhere.baseUrl}/api/embed` }).end();
		});
		const result = await embedLocalModel(['a'], embedder, envFor(host));
		// The shared door's catch-all, as on the chat call; its advice is filed with the 400 case.
		expect(result).toStrictEqual({ unavailable: true, failureCode: 'unreachable' });
		expect(elsewhere.hits['/api/embed']).toBeUndefined();
	});

	it.each([
		['no text', [] as string[], 'between 1 and'],
		['one text too many', Array.from({ length: EMBED_MAX_TEXTS + 1 }, () => 'a'), 'between 1 and'],
		['an empty text', [''], 'each text holds'],
		['a text one character too long', ['a'.repeat(EMBED_MAX_TEXT_CHARS + 1)], 'each text holds']
	])('throws on %s, before any socket', async (_name, texts, reason) => {
		const host = await hostWith(embed([[1]]));
		await expect(embedLocalModel(texts, embedder, envFor(host))).rejects.toThrow(reason);
		expect(host.hits).toStrictEqual({});
	});

	it('accepts the bounds themselves', async () => {
		const host = await hostWith(embed(Array.from({ length: EMBED_MAX_TEXTS }, () => [1])));
		const texts = Array.from({ length: EMBED_MAX_TEXTS }, () => 'a'.repeat(EMBED_MAX_TEXT_CHARS));
		const result = await embedLocalModel(texts, embedder, envFor(host));
		expect(result?.value).toHaveLength(EMBED_MAX_TEXTS);
	});

	it('throws on an embedder digest that could never match, before any socket', async () => {
		const host = await hostWith(embed([[1]]));
		const short = { ...embedder, digest: DIGEST.slice(0, 12) };
		await expect(embedLocalModel(['a'], short, envFor(host))).rejects.toThrow('64 lowercase');
		expect(host.hits).toStrictEqual({});
	});
});
