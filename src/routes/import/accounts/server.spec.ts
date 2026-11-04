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

/**
 * #1211: the fragment stored on a new account is read from the file, and on a file the member
 * declared headerless line 1 is a transaction. The designation screen posts that answer beside the
 * file; absent, the file is read with a header row, as `/import`'s currency refusal always sends.
 */
describe('#1211: the new account reads a headerless file from line 1', () => {
	const IBAN_A = 'FR7630006000011234567890189';
	const IBAN_B = 'DE89370400440532013000';

	async function postFile(lines: string[], hasHeaderRow?: 'true' | 'false'): Promise<void> {
		const body = new FormData();
		body.set('name', 'Compte joint');
		body.set('csvFile', new File([lines.join('\n')], 'releve.csv', { type: 'text/csv' }));
		if (hasHeaderRow !== undefined) body.set('hasHeaderRow', hasHeaderRow);
		const request = new Request('http://localhost/import/accounts', { method: 'POST', body });
		await POST({
			locals: { user: testUser },
			request,
			getClientAddress: () => '192.0.2.10'
		} as never);
	}

	const storedFragment = () =>
		(accounts.createStatementAccount.mock.calls.at(-1)?.[0] as { discriminant: string | null })
			?.discriminant;

	const TWO_ACCOUNTS = [
		`2026-06-01,${IBAN_A},CB A,-10.00`,
		`2026-06-02,${IBAN_B},CB B,-20.00`,
		`2026-06-03,${IBAN_B},CB C,-30.00`
	];

	beforeEach(() => {
		vi.clearAllMocks();
		limiter.isImportRateLimited.mockResolvedValue(null);
		accounts.createStatementAccount.mockReset();
		accounts.createStatementAccount.mockResolvedValue({
			id: 'account-new',
			name: 'Compte joint',
			discriminant: null,
			currency: 'EUR'
		});
	});

	// SEPARATES « line 1 is evidence » FROM « line 1 is skipped as a header ». Skipped, the file
	// reads as account B throughout and B's fragment is stored on an account the file contradicts.
	it('stores no fragment when line 1 of a headerless file names another account', async () => {
		await postFile(TWO_ACCOUNTS, 'false');
		expect(storedFragment()).toBeNull();
	});

	// Guards against over-refusal: a headerless file naming one account on every line keeps its
	// fragment once line 1 counts.
	it('stores the fragment a headerless file names on every line', async () => {
		await postFile(
			TWO_ACCOUNTS.map((line) => line.replace(IBAN_A, IBAN_B)),
			'false'
		);
		expect(storedFragment()).toBe('3000');
	});

	// Calibration: the same bytes with no answer posted are read with a header row, as before.
	it('reads line 1 as a header when no answer is posted', async () => {
		await postFile(TWO_ACCOUNTS);
		expect(storedFragment()).toBe('3000');
	});
});
