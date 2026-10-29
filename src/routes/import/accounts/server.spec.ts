import { beforeEach, describe, expect, it, vi } from 'vitest';

// The handler reaches the database through the limiter and `createStatementAccount`, both mocked.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

vi.hoisted(() => {
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
});
const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

const limiter = vi.hoisted(() => ({
	isImportRateLimited: vi.fn(async (): Promise<unknown> => null),
	recordImportAttempt: vi.fn(async () => undefined)
}));
vi.mock('$lib/server/auth/rateLimit', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/auth/rateLimit')>()),
	...limiter
}));

// `AccountWriteError` stays real: the handler's refusal branch is an `instanceof` on it.
const accounts = vi.hoisted(() => ({ createStatementAccount: vi.fn() }));
vi.mock('$lib/server/accounts/service', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/accounts/service')>()),
	...accounts
}));

const { POST } = await import('./+server');
const { AccountWriteError } = await import('$lib/server/accounts/service');
const { logUserPseudonym } = await import('$lib/server/logging/pseudonym');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

async function post(fields: Record<string, string>): Promise<Response> {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	const request = new Request('http://localhost/import/accounts', { method: 'POST', body });
	return POST({
		locals: { user: testUser },
		request,
		getClientAddress: () => '192.0.2.10'
	} as never);
}

/**
 * #1087 piece 2: « Créer et sélectionner » stores a statement account, so it writes
 * `sensitive_create`, scope statement_account, after `createStatementAccount` returns. Wire names as
 * literals.
 */
describe('#1087: POST /import/accounts writes sensitive_create', () => {
	const creates = () =>
		logged.filter((line) => (line as { event: string }).event === 'sensitive_create');

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
		limiter.isImportRateLimited.mockResolvedValue(null);
		accounts.createStatementAccount.mockReset();
		accounts.createStatementAccount.mockResolvedValue({
			id: 'account-new',
			name: 'Compte joint',
			discriminant: null,
			currency: 'EUR'
		});
	});

	// Separates "the endpoint logs the account it created" from "writes nothing on create".
	it('a created account: one line, operation create_statement_account', async () => {
		await post({ name: 'Compte joint' });
		expect(creates()).toEqual([
			{
				event: 'sensitive_create',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(testUser.id),
					'budgetpilot.data.operation': 'create_statement_account',
					'budgetpilot.data.scope': 'statement_account'
				}
			}
		]);
	});

	// Green today; separates "line after the create returned" from "line before the call".
	it('a name the service refuses writes none', async () => {
		accounts.createStatementAccount.mockRejectedValue(new AccountWriteError('name-taken'));
		const response = await post({ name: 'Compte joint' });
		expect({ status: response.status, lines: creates() }).toEqual({ status: 400, lines: [] });
	});

	// Green today; separates "line after the create" from "line before the currency check".
	it('a currency off the allow list writes none', async () => {
		const response = await post({ name: 'Compte joint', currency: 'XXX-NOT-A-CURRENCY' });
		expect({
			status: response.status,
			called: accounts.createStatementAccount.mock.calls.length,
			lines: creates()
		}).toEqual({ status: 400, called: 0, lines: [] });
	});

	// Green today; separates "line after the create" from "line before the limiter".
	it('a rate-limited request writes none', async () => {
		limiter.isImportRateLimited.mockResolvedValue({ counter: 'subject' });
		const response = await post({ name: 'Compte joint' });
		expect({
			status: response.status,
			called: accounts.createStatementAccount.mock.calls.length,
			lines: creates()
		}).toEqual({ status: 429, called: 0, lines: [] });
	});
});
