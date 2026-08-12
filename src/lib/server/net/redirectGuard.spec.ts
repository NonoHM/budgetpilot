import { describe, expect, it, vi } from 'vitest';
import { fetchWithRedirectGuard, SsrfRedirectError } from './redirectGuard';

function redirect(status: number, location: string): Response {
	return new Response(null, { status, headers: { location } });
}

// Typed as the real fetch so it is assignable to the guard's fetchImpl option, and so that
// `mock.calls[i][j]` narrows to (input, init) rather than an empty tuple.
type FetchFn = typeof fetch;

// Allowlist used by most tests: only api.example.test is permitted.
const allowExample = (target: URL) => target.hostname === 'api.example.test';

describe('fetchWithRedirectGuard', () => {
	it('returns a non-redirect response with a single fetch, adding redirect: manual', async () => {
		expect.assertions(3);

		const fetchImpl = vi.fn<FetchFn>(async () => new Response('ok', { status: 200 }));
		const response = await fetchWithRedirectGuard(
			'https://api.example.test/data',
			{ method: 'GET' },
			{ fetchImpl, isRedirectTargetAllowed: allowExample }
		);

		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
	});

	it('REFUSES a redirect to a non-allowlisted host, and never issues a request to it', async () => {
		expect.assertions(3);

		const fetchImpl = vi.fn<FetchFn>(async () =>
			redirect(302, 'http://127.0.0.2:9998/latest/meta-data/')
		);

		await expect(
			fetchWithRedirectGuard(
				'https://api.example.test/auth',
				{ method: 'POST' },
				{ fetchImpl, isRedirectTargetAllowed: allowExample }
			)
		).rejects.toBeInstanceOf(SsrfRedirectError);

		// The whole point: the internal target is NEVER fetched. Only the first hop ran.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(['https://api.example.test/auth']);
	});

	it('follows a redirect to an allowlisted host and returns the final response', async () => {
		expect.assertions(3);

		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(redirect(302, 'https://api.example.test/v2/data'))
			.mockResolvedValueOnce(new Response('final', { status: 200 }));

		const response = await fetchWithRedirectGuard(
			'https://api.example.test/v1/data',
			{ method: 'GET' },
			{ fetchImpl, isRedirectTargetAllowed: allowExample }
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('final');
		expect(fetchImpl.mock.calls[1][0]).toBe('https://api.example.test/v2/data');
	});

	it('resolves a RELATIVE Location against the current URL before validating it', async () => {
		expect.assertions(2);

		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(redirect(302, '/v2/data'))
			.mockResolvedValueOnce(new Response('final', { status: 200 }));

		const response = await fetchWithRedirectGuard(
			'https://api.example.test/v1/data',
			{ method: 'GET' },
			{ fetchImpl, isRedirectTargetAllowed: allowExample }
		);

		expect(response.status).toBe(200);
		expect(fetchImpl.mock.calls[1][0]).toBe('https://api.example.test/v2/data');
	});

	it('drops Authorization and Cookie on a cross-origin hop, keeps them same-origin', async () => {
		expect.assertions(4);

		// Two allowlisted hosts so a cross-origin hop is possible.
		const allowBoth = (u: URL) =>
			u.hostname === 'api.example.test' || u.hostname === 'other.example.test';

		const crossFetch = vi
			.fn()
			.mockResolvedValueOnce(redirect(302, 'https://other.example.test/data'))
			.mockResolvedValueOnce(new Response('final', { status: 200 }));
		await fetchWithRedirectGuard(
			'https://api.example.test/data',
			{ method: 'GET', headers: { Authorization: 'Bearer secret', Cookie: 'sid=1' } },
			{ fetchImpl: crossFetch, isRedirectTargetAllowed: allowBoth }
		);
		const crossHeaders = new Headers(crossFetch.mock.calls[1][1]?.headers);
		expect(crossHeaders.get('authorization')).toBeNull();
		expect(crossHeaders.get('cookie')).toBeNull();

		const sameFetch = vi
			.fn()
			.mockResolvedValueOnce(redirect(302, 'https://api.example.test/v2/data'))
			.mockResolvedValueOnce(new Response('final', { status: 200 }));
		await fetchWithRedirectGuard(
			'https://api.example.test/v1/data',
			{ method: 'GET', headers: { Authorization: 'Bearer secret' } },
			{ fetchImpl: sameFetch, isRedirectTargetAllowed: allowExample }
		);
		const sameHeaders = new Headers(sameFetch.mock.calls[1][1]?.headers);
		expect(sameHeaders.get('authorization')).toBe('Bearer secret');
		expect(new URL(sameFetch.mock.calls[1][0] as string).origin).toBe('https://api.example.test');
	});

	it('turns a 303 on a POST into a GET with no body', async () => {
		expect.assertions(2);

		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(redirect(303, 'https://api.example.test/result'))
			.mockResolvedValueOnce(new Response('done', { status: 200 }));

		await fetchWithRedirectGuard(
			'https://api.example.test/submit',
			{ method: 'POST', body: JSON.stringify({ a: 1 }) },
			{ fetchImpl, isRedirectTargetAllowed: allowExample }
		);

		const secondInit = fetchImpl.mock.calls[1][1] as RequestInit;
		expect(secondInit.method).toBe('GET');
		expect(secondInit.body).toBeUndefined();
	});

	it('refuses after more than maxRedirects allowlisted hops', async () => {
		expect.assertions(2);

		// Always redirect to an allowlisted target, so only the hop cap can stop it.
		const fetchImpl = vi.fn(async () => redirect(302, 'https://api.example.test/loop'));

		await expect(
			fetchWithRedirectGuard(
				'https://api.example.test/start',
				{ method: 'GET' },
				{ fetchImpl, isRedirectTargetAllowed: allowExample, maxRedirects: 2 }
			)
		).rejects.toBeInstanceOf(SsrfRedirectError);

		// Initial hop + 2 followed redirects = 3 calls, then the 4th would exceed the cap.
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it('returns a 3xx that carries no Location rather than treating it as followable', async () => {
		expect.assertions(2);

		const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
		const response = await fetchWithRedirectGuard(
			'https://api.example.test/data',
			{ method: 'GET' },
			{ fetchImpl, isRedirectTargetAllowed: allowExample }
		);

		expect(response.status).toBe(304);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
