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

// The #1087 block decides what the net worth writes answer; nothing else in this file reaches them.
const netWorth = vi.hoisted(() => ({
	createNetWorthAccount: vi.fn(),
	linkBankAccountToNetWorth: vi.fn(),
	readLinkableNetWorthAccounts: vi.fn()
}));
vi.mock('$lib/server/net-worth/service', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/net-worth/service')>()),
	...netWorth
}));

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

/**
 * L4b-2 (#250, owner ruling 3): removing a bank connection writes `sensitive_delete`, scope
 * bank_connection (its accounts and transactions are kept), no count. Wire names as literals.
 */
describe('/imports/bank-connections ?/delete writes sensitive_delete', () => {
	async function remove(): Promise<unknown> {
		const body = new FormData();
		body.set('connectionId', 'connection-1');
		const request = new Request('http://localhost/imports/bank-connections?/delete', {
			method: 'POST',
			body
		});
		return actions.delete({ locals: { user: USER }, request } as never);
	}
	const deletes = () =>
		logged.filter((line) => (line as { event: string }).event === 'sensitive_delete');

	beforeEach(() => {
		logged.length = 0;
		service.deleteBankConnection.mockReset();
	});

	it('a connection that resolved: one line, scope bank_connection', async () => {
		service.deleteBankConnection.mockResolvedValue(true);
		await remove();
		expect(deletes()).toEqual([
			{
				event: 'sensitive_delete',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(USER.id),
					'budgetpilot.data.operation': 'delete_bank_connection',
					'budgetpilot.data.scope': 'bank_connection'
				}
			}
		]);
	});

	it('a connection that does not resolve writes none', async () => {
		service.deleteBankConnection.mockResolvedValue(false);
		await remove();
		expect(deletes()).toEqual([]);
	});
});

/**
 * #1087 piece 2: linking a bank account with mode=create creates a net worth account, so it writes
 * `sensitive_create`, scope net_worth_account, right after `createNetWorthAccount` returns and
 * BEFORE the link, so a link that fails cannot hide a row already stored. Modes none and existing
 * create nothing and write no such line. Wire names as literals.
 */
describe('#1087: linkAccount writes sensitive_create', () => {
	async function link(fields: Record<string, string>): Promise<{ status?: number }> {
		const body = new FormData();
		body.set('accountId', 'bank-account-1');
		for (const [key, value] of Object.entries(fields)) body.set(key, value);
		const request = new Request('http://localhost/imports/bank-connections?/linkAccount', {
			method: 'POST',
			body
		});
		return (await actions.linkAccount({ locals: { user: USER }, request } as never)) as {
			status?: number;
		};
	}
	const creates = () =>
		logged.filter((line) => (line as { event: string }).event === 'sensitive_create');
	const createdLine = {
		event: 'sensitive_create',
		attributes: {
			'budgetpilot.user.pseudonym': logUserPseudonym(USER.id),
			'budgetpilot.data.operation': 'create_net_worth_account',
			'budgetpilot.data.scope': 'net_worth_account'
		}
	};
	const CREATE = { mode: 'create', name: 'Compte courant', type: 'checking', balance: '100' };

	beforeEach(() => {
		logged.length = 0;
		netWorth.createNetWorthAccount.mockReset();
		netWorth.linkBankAccountToNetWorth.mockReset();
	});

	// Separates "the route logs the account mode=create stored" from "writes nothing on link".
	it('mode=create: one line, operation create_net_worth_account', async () => {
		netWorth.createNetWorthAccount.mockResolvedValue({ id: 'nw-new' });
		netWorth.linkBankAccountToNetWorth.mockResolvedValue(undefined);
		await link(CREATE);
		expect(creates()).toEqual([createdLine]);
	});

	// Separates "line after the create" from "line at the end of the action": the account is stored
	// when the link throws, and the action answers a failure.
	it('mode=create whose link fails after the account was stored: the line is still written', async () => {
		netWorth.createNetWorthAccount.mockResolvedValue({ id: 'nw-new' });
		netWorth.linkBankAccountToNetWorth.mockRejectedValue(new Error('link failed'));
		await link(CREATE);
		expect(creates()).toEqual([createdLine]);
	});

	// Green today; separates "line after the create returned" from "line before the call".
	it('mode=create refused by the service writes none', async () => {
		netWorth.createNetWorthAccount.mockRejectedValue(new Error('invalid balance'));
		const result = await link({ ...CREATE, balance: 'abc' });
		expect({ status: result.status, lines: creates() }).toEqual({ status: 400, lines: [] });
	});

	// Green today; separates "a line for the account created" from "a line for any link".
	it.each([
		['none', { mode: 'none' }],
		['existing', { mode: 'existing', netWorthAccountId: 'nw-existing' }]
	])('mode=%s creates nothing and writes none', async (_mode, fields) => {
		netWorth.linkBankAccountToNetWorth.mockResolvedValue(undefined);
		const result = await link(fields);
		expect({ status: result.status, lines: creates() }).toEqual({ status: undefined, lines: [] });
	});
});
