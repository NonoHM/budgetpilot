import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';
import { logUserPseudonym } from '$lib/server/logging/pseudonym';

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));
vi.mock('$lib/server/db', () => ({ prisma: {} }));

const service = vi.hoisted(() => ({
	BankSyncError: class BankSyncError extends Error {},
	deleteBankConnection: vi.fn(),
	listBankAspsps: vi.fn(),
	listUserBankConnections: vi.fn(),
	startBankAuthorization: vi.fn(),
	syncBankConnection: vi.fn()
}));
vi.mock('$lib/server/banking/sync/service', () => service);

const { actions } = await import('./+page.server');

const USER = { id: 'user-sync', email: 'sync@example.test', role: 'USER' as const };

async function sync(): Promise<{ status?: number }> {
	const body = new FormData();
	body.set('connectionId', 'connection-1');
	const request = new Request('http://localhost/imports/bank-connections?/sync', {
		method: 'POST',
		body
	});
	return (await actions.sync({ locals: { user: USER }, request } as never)) as { status?: number };
}

/**
 * #250 L4b: the six-hour sync interval refuses a member who repeats a sync, which is anti-automation
 * in `v5.0.0-16.3.3`'s words, so the refusal is logged like the limiter's (owner, 2026-10-27). The
 * whole event is compared: the member and no client, R1. `subject` is the connection's own interval.
 */
describe('/imports/bank-connections ?/sync', () => {
	beforeEach(() => {
		logged.length = 0;
		service.syncBankConnection.mockReset();
	});

	it('logs a refusal inside the interval once, with the member and no client', async () => {
		service.syncBankConnection.mockResolvedValue({ outcome: 'throttled' });
		const result = await sync();
		expect({
			status: result.status,
			lines: logged.filter((line) => (line as { event: string }).event === EVENT.rateLimitExceeded)
		}).toEqual({
			status: 429,
			lines: [
				{
					event: EVENT.rateLimitExceeded,
					attributes: {
						[ATTRIBUTE.rateLimitKind]: 'BANK_SYNC',
						[ATTRIBUTE.rateLimitCounter]: 'subject',
						[ATTRIBUTE.userPseudonym]: logUserPseudonym(USER.id)
					}
				}
			]
		});
	});

	it('writes no rate-limit line for a sync that ran', async () => {
		service.syncBankConnection.mockResolvedValue({
			outcome: 'synced',
			importedRows: 1,
			duplicateRows: 0
		});
		await sync();
		expect(
			logged.filter((line) => (line as { event: string }).event === EVENT.rateLimitExceeded)
		).toEqual([]);
	});
});
