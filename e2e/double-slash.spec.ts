import { expect, test } from './fixtures';
import { E2E_BASE_URL } from './config';

/**
 * GHSA-pfhg-q3qv-9q6r (kit < 3, #1148), the BUILT-SERVER half. hooks.server.spec.ts calls
 * handleDoubleSlash directly, so it stays green if the hook is dropped from `sequence(...)`;
 * only a real response separates « refused before rendering » from « the layout rendered a 404 ».
 * Signed in, through the suite's shared session, because the page a lured user would land on is
 * the signed-in layout. The target is absolute: a relative `//evil.example/` would be read as
 * protocol-relative and leave for another host.
 */
test('a path beginning with // is refused before any page renders', async ({ request }) => {
	const response = await request.get(`${E2E_BASE_URL}//evil.example/`, { maxRedirects: 0 });

	expect(response.status()).toBe(404);
	expect(response.headers()['content-type']).toBe('text/plain; charset=utf-8');
	expect(await response.text()).toBe('Not Found');
	// Last in `sequence`, inside handleSecurityHeaders: moved ahead of it, the refusal loses these.
	expect(response.headers()['x-content-type-options']).toBe('nosniff');
	expect(response.headers()['x-frame-options']).toBe('DENY');
});
