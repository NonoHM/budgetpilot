import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestAccountCreation } from './createAccountRequest';

/**
 * #1211: the answer about line 1 travels with the file, because the endpoint reads the new
 * account's fragment from the bytes under it.
 */
describe('#1211: the create request carries the answer about line 1', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// SEPARATES « the body carries the answer » FROM « the body omits it », which the endpoint reads
	// as a header row and so skips the line that names a second account.
	it('posts false when the member said line 1 is data', async () => {
		const sent: FormData[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: unknown, init: { body: FormData }) => {
				sent.push(init.body);
				return new Response(JSON.stringify({ error: 'x' }), { status: 400 });
			})
		);
		await requestAccountCreation({
			name: 'Livret A',
			file: new File(['a'], 'releve.csv'),
			hasHeaderRow: false
		});
		expect(sent.map((body) => body.get('hasHeaderRow'))).toStrictEqual(['false']);
	});
});
