import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Isolated unit tests for the bank-sync orchestration service (step 4b). Prisma is
 * mocked with plain vi.fn()s (same style as import/persist.spec.ts) and the shared
 * import persistence module is mocked too, so this spec only asserts the service
 * DELEGATES to it — never that it re-inlines persistence. No real network call
 * anywhere: connectors are hand-rolled fakes injected via BankSyncOptions.getConnector.
 */

vi.hoisted(() => {
	// $lib/server/crypto requires this at import time (see crypto.spec.ts for the pattern).
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
});

const prismaMock = vi.hoisted(() => ({
	bankAuthorizationRequest: {
		deleteMany: vi.fn(),
		create: vi.fn(),
		findUnique: vi.fn(),
		updateMany: vi.fn()
	},
	bankConnection: {
		create: vi.fn(),
		findFirst: vi.fn(),
		findMany: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		deleteMany: vi.fn()
	},
	account: {
		findMany: vi.fn(),
		updateMany: vi.fn()
	},
	/**
	 * The interactive transaction, modelled by handing the callback THIS SAME fake as its `tx`.
	 *
	 * That is faithful for what these two cases assert, and it is deliberately not faithful about
	 * atomicity: a fake cannot roll anything back, so a spec here can never show that the clearing
	 * and the delete stand or fall together. That claim is asserted where it can be, against a real
	 * engine, in `net-worth/connectedBadgeOutlivesConnection.db-smoke.ts`. See AGENTS.md: a fake
	 * must fail loudly on a predicate it CANNOT model, and be honest about the one it is standing
	 * in for.
	 */
	$transaction: vi.fn()
}));

const persistMock = vi.hoisted(() => ({
	resolveImportBucketAccount: vi.fn(),
	createImportBatch: vi.fn(),
	persistImportedTransactions: vi.fn()
}));

const netWorthMock = vi.hoisted(() => ({
	recordSyncedBalance: vi.fn()
}));

vi.mock('$lib/server/db', () => ({ prisma: prismaMock }));
vi.mock('$lib/server/import/persist', () => persistMock);
vi.mock('$lib/server/net-worth/service', () => netWorthMock);

const { encryptSecret, decryptSecret } = await import('$lib/server/crypto');
const { EnableBankingApiError } = await import('$lib/server/banking/enablebanking/http');
const {
	BankSyncError,
	listBankAspsps,
	startBankAuthorization,
	completeBankAuthorization,
	listUserBankConnections,
	syncBankConnection,
	deleteBankConnection
} = await import('./service');
const { BANK_SYNC_CALLBACK_PATH } = await import('$lib/server/banking/config');
import type { BankConnector } from '$lib/server/banking/connectors/types';

const ENABLED_ENV = {
	BANK_SYNC_ENABLED: 'true',
	BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: 'http://localhost:5173'
} as unknown as NodeJS.ProcessEnv;

const DISABLED_ENV = {} as unknown as NodeJS.ProcessEnv;

const NOW = new Date('2026-07-19T12:00:00.000Z');

function fakeConnector(overrides: Partial<BankConnector> = {}): BankConnector {
	return {
		id: 'mock',
		displayName: 'Mock Bank',
		createConnection: vi.fn(),
		completeAuthorization: vi.fn(),
		listAccounts: vi.fn(),
		fetchTransactions: vi.fn(),
		getConnectionStatus: vi.fn(),
		...overrides
	} as unknown as BankConnector;
}

beforeEach(() => {
	vi.clearAllMocks();
	// Default: the atomic throttle-claim in syncBankConnection succeeds. Renewal tests
	// that specifically exercise bankConnection.updateMany override this per-call.
	prismaMock.bankConnection.updateMany.mockResolvedValue({ count: 1 });
});

describe('gating — BANK_SYNC_ENABLED', () => {
	it('listBankAspsps throws BankSyncError("disabled") when the flag is off', async () => {
		await expect(listBankAspsps('mock', 'FR', { env: DISABLED_ENV })).rejects.toMatchObject({
			code: 'disabled'
		});
	});

	it('startBankAuthorization throws BankSyncError("disabled") when the flag is off', async () => {
		await expect(
			startBankAuthorization(
				{
					userId: 'user-1',
					provider: 'mock',
					aspspName: 'Bank',
					aspspCountry: 'FR',
					origin: 'http://localhost:5173'
				},
				{ env: DISABLED_ENV }
			)
		).rejects.toMatchObject({ code: 'disabled' });
		expect(prismaMock.bankAuthorizationRequest.create).not.toHaveBeenCalled();
	});

	it('completeBankAuthorization throws BankSyncError("disabled") when the flag is off', async () => {
		await expect(
			completeBankAuthorization(
				{ userId: 'user-1', params: { state: 'x', code: 'y' } },
				{ env: DISABLED_ENV }
			)
		).rejects.toMatchObject({ code: 'disabled' });
		expect(prismaMock.bankAuthorizationRequest.findUnique).not.toHaveBeenCalled();
	});

	it('syncBankConnection throws BankSyncError("disabled") when the flag is off, without touching prisma', async () => {
		await expect(
			syncBankConnection({ userId: 'user-1', connectionId: 'conn-1' }, { env: DISABLED_ENV })
		).rejects.toMatchObject({ code: 'disabled' });
		expect(prismaMock.bankConnection.findFirst).not.toHaveBeenCalled();
	});
});

describe('listBankAspsps', () => {
	it('throws unknown_provider when getConnector resolves nothing', async () => {
		await expect(
			listBankAspsps('ghost', 'FR', { env: ENABLED_ENV, getConnector: () => null })
		).rejects.toMatchObject({ code: 'unknown_provider' });
	});

	it('returns [] when the connector has no listBanks method', async () => {
		const connector = fakeConnector({ listBanks: undefined });
		const result = await listBankAspsps('mock', 'FR', {
			env: ENABLED_ENV,
			getConnector: () => connector
		});
		expect(result).toEqual([]);
	});

	it('delegates to connector.listBanks(country)', async () => {
		const banks = [{ name: 'Bank A', country: 'FR' }];
		const connector = fakeConnector({ listBanks: vi.fn().mockResolvedValue(banks) });
		const result = await listBankAspsps('mock', 'FR', {
			env: ENABLED_ENV,
			getConnector: () => connector
		});
		expect(result).toBe(banks);
		expect(connector.listBanks).toHaveBeenCalledWith('FR');
	});
});

describe('startBankAuthorization', () => {
	const baseInput = {
		userId: 'user-1',
		provider: 'mock',
		aspspName: 'Bank A',
		aspspCountry: 'FR',
		origin: 'http://localhost:5173'
	};

	it('throws redirect_not_allowed when BANK_SYNC_REDIRECT_ALLOWED_ORIGINS is unset (fail-safe)', async () => {
		const connector = fakeConnector();
		await expect(
			startBankAuthorization(baseInput, {
				env: { BANK_SYNC_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv,
				getConnector: () => connector
			})
		).rejects.toMatchObject({ code: 'redirect_not_allowed' });
		expect(connector.createConnection).not.toHaveBeenCalled();
	});

	it('throws redirect_not_allowed when the origin is not in the allowlist', async () => {
		const connector = fakeConnector();
		await expect(
			startBankAuthorization(
				{ ...baseInput, origin: 'https://evil.example' },
				{ env: ENABLED_ENV, getConnector: () => connector }
			)
		).rejects.toMatchObject({ code: 'redirect_not_allowed' });
		expect(connector.createConnection).not.toHaveBeenCalled();
	});

	it('throws unknown_bank when the picked bank is not in the connector list', async () => {
		const connector = fakeConnector({
			listBanks: vi.fn().mockResolvedValue([{ name: 'Other Bank', country: 'FR' }])
		});
		await expect(
			startBankAuthorization(baseInput, { env: ENABLED_ENV, getConnector: () => connector })
		).rejects.toMatchObject({ code: 'unknown_bank' });
		expect(connector.createConnection).not.toHaveBeenCalled();
	});

	it('persists the request and passes the exact callback redirect URL, on success', async () => {
		const connector = fakeConnector({
			listBanks: vi.fn().mockResolvedValue([{ name: 'Bank A', country: 'FR' }]),
			createConnection: vi.fn().mockResolvedValue({
				authorizationUrl: 'https://bank.example/authorize',
				state: 'raw-state-123'
			})
		});
		prismaMock.bankAuthorizationRequest.deleteMany.mockResolvedValue({ count: 0 });
		prismaMock.bankAuthorizationRequest.create.mockResolvedValue({});

		const result = await startBankAuthorization(baseInput, {
			env: ENABLED_ENV,
			now: () => NOW,
			getConnector: () => connector
		});

		expect(result).toEqual({ authorizationUrl: 'https://bank.example/authorize' });
		expect(connector.createConnection).toHaveBeenCalledWith({
			redirectUrl: `http://localhost:5173${BANK_SYNC_CALLBACK_PATH}`,
			aspsp: { name: 'Bank A', country: 'FR' }
		});

		expect(prismaMock.bankAuthorizationRequest.deleteMany).toHaveBeenCalledWith({
			where: { userId: 'user-1', expiresAt: { lt: NOW } }
		});

		expect(prismaMock.bankAuthorizationRequest.create).toHaveBeenCalledTimes(1);
		const createCall = prismaMock.bankAuthorizationRequest.create.mock.calls[0][0] as {
			data: {
				userId: string;
				provider: string;
				stateHash: string;
				stateEncrypted: string;
				aspspName: string;
				aspspCountry: string;
				expiresAt: Date;
			};
		};
		expect(createCall.data.userId).toBe('user-1');
		expect(createCall.data.provider).toBe('mock');
		expect(createCall.data.aspspName).toBe('Bank A');
		expect(createCall.data.aspspCountry).toBe('FR');
		expect(createCall.data.stateHash).toBe(
			createHash('sha256').update('raw-state-123').digest('hex')
		);
		expect(decryptSecret(createCall.data.stateEncrypted)).toBe('raw-state-123');
		expect(createCall.data.expiresAt.getTime() - NOW.getTime()).toBe(30 * 60 * 1000);
	});

	it('passes aspsp: undefined when the connector has no listBanks (no bank-selection requirement)', async () => {
		const connector = fakeConnector({
			listBanks: undefined,
			createConnection: vi
				.fn()
				.mockResolvedValue({ authorizationUrl: 'https://bank.example/authorize', state: 'state-x' })
		});
		prismaMock.bankAuthorizationRequest.deleteMany.mockResolvedValue({ count: 0 });
		prismaMock.bankAuthorizationRequest.create.mockResolvedValue({});

		await startBankAuthorization(baseInput, {
			env: ENABLED_ENV,
			now: () => NOW,
			getConnector: () => connector
		});

		expect(connector.createConnection).toHaveBeenCalledWith(
			expect.objectContaining({ aspsp: undefined })
		);
	});

	describe('renewal mode (renewConnectionId)', () => {
		it('loads the stored aspsp from the target connection, ignoring client-supplied aspsp fields', async () => {
			prismaMock.bankConnection.findFirst.mockResolvedValueOnce({
				aspspName: 'Stored Bank',
				aspspCountry: 'DE'
			});
			const connector = fakeConnector({
				listBanks: vi.fn().mockResolvedValue([{ name: 'Stored Bank', country: 'DE' }]),
				createConnection: vi.fn().mockResolvedValue({
					authorizationUrl: 'https://bank.example/authorize',
					state: 'renew-state'
				})
			});
			prismaMock.bankAuthorizationRequest.deleteMany.mockResolvedValue({ count: 0 });
			prismaMock.bankAuthorizationRequest.create.mockResolvedValue({});

			await startBankAuthorization(
				{
					...baseInput,
					aspspName: 'Client-Supplied Bank',
					aspspCountry: 'FR',
					renewConnectionId: 'conn-1'
				},
				{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
			);

			expect(prismaMock.bankConnection.findFirst).toHaveBeenCalledWith({
				where: { id: 'conn-1', userId: 'user-1', provider: 'mock' },
				select: { aspspName: true, aspspCountry: true }
			});
			// The bank list lookup and the persisted row both use the STORED bank, not the client input.
			expect(connector.listBanks).toHaveBeenCalledWith('DE');
			expect(connector.createConnection).toHaveBeenCalledWith(
				expect.objectContaining({ aspsp: { name: 'Stored Bank', country: 'DE' } })
			);
			const createCall = prismaMock.bankAuthorizationRequest.create.mock.calls[0][0] as {
				data: { aspspName: string; aspspCountry: string; renewsConnectionId: string | null };
			};
			expect(createCall.data.aspspName).toBe('Stored Bank');
			expect(createCall.data.aspspCountry).toBe('DE');
			expect(createCall.data.renewsConnectionId).toBe('conn-1');
		});

		it('sets renewsConnectionId to null when renewConnectionId is not passed (non-renewal flow)', async () => {
			const connector = fakeConnector({
				listBanks: vi.fn().mockResolvedValue([{ name: 'Bank A', country: 'FR' }]),
				createConnection: vi.fn().mockResolvedValue({
					authorizationUrl: 'https://bank.example/authorize',
					state: 'plain-state'
				})
			});
			prismaMock.bankAuthorizationRequest.deleteMany.mockResolvedValue({ count: 0 });
			prismaMock.bankAuthorizationRequest.create.mockResolvedValue({});

			await startBankAuthorization(baseInput, {
				env: ENABLED_ENV,
				now: () => NOW,
				getConnector: () => connector
			});

			expect(prismaMock.bankConnection.findFirst).not.toHaveBeenCalled();
			const createCall = prismaMock.bankAuthorizationRequest.create.mock.calls[0][0] as {
				data: { renewsConnectionId: string | null };
			};
			expect(createCall.data.renewsConnectionId).toBeNull();
		});

		it('throws not_found when the target connection does not exist or belongs to another user', async () => {
			prismaMock.bankConnection.findFirst.mockResolvedValueOnce(null);
			const connector = fakeConnector();

			await expect(
				startBankAuthorization(
					{ ...baseInput, renewConnectionId: 'conn-not-mine' },
					{ env: ENABLED_ENV, getConnector: () => connector }
				)
			).rejects.toMatchObject({ code: 'not_found' });
			expect(connector.createConnection).not.toHaveBeenCalled();
		});

		it('throws not_found when the stored connection has null aspspName/aspspCountry', async () => {
			prismaMock.bankConnection.findFirst.mockResolvedValueOnce({
				aspspName: null,
				aspspCountry: null
			});
			const connector = fakeConnector();

			await expect(
				startBankAuthorization(
					{ ...baseInput, renewConnectionId: 'conn-1' },
					{ env: ENABLED_ENV, getConnector: () => connector }
				)
			).rejects.toMatchObject({ code: 'not_found' });
			expect(connector.createConnection).not.toHaveBeenCalled();
		});
	});
});

describe('completeBankAuthorization', () => {
	const baseRequest = {
		id: 'req-1',
		userId: 'user-1',
		provider: 'mock',
		stateHash: createHash('sha256').update('raw-state').digest('hex'),
		stateEncrypted: encryptSecret('raw-state'),
		aspspName: 'Bank A',
		aspspCountry: 'FR',
		expiresAt: new Date(NOW.getTime() + 60_000),
		consumedAt: null
	};

	it('throws invalid_state when state is missing from callback params, without querying prisma', async () => {
		await expect(
			completeBankAuthorization(
				{ userId: 'user-1', params: { code: 'abc' } },
				{ env: ENABLED_ENV, now: () => NOW }
			)
		).rejects.toMatchObject({ code: 'invalid_state' });
		expect(prismaMock.bankAuthorizationRequest.findUnique).not.toHaveBeenCalled();
	});

	it('throws invalid_state when the stateHash is unknown', async () => {
		prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce(null);
		await expect(
			completeBankAuthorization(
				{ userId: 'user-1', params: { state: 'raw-state', code: 'abc' } },
				{ env: ENABLED_ENV, now: () => NOW }
			)
		).rejects.toMatchObject({ code: 'invalid_state' });
	});

	it('throws invalid_state when the request row belongs to another user', async () => {
		prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce({
			...baseRequest,
			userId: 'someone-else'
		});
		await expect(
			completeBankAuthorization(
				{ userId: 'user-1', params: { state: 'raw-state', code: 'abc' } },
				{ env: ENABLED_ENV, now: () => NOW }
			)
		).rejects.toMatchObject({ code: 'invalid_state' });
	});

	it('throws invalid_state when the request has expired', async () => {
		prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce({
			...baseRequest,
			expiresAt: new Date(NOW.getTime() - 1)
		});
		await expect(
			completeBankAuthorization(
				{ userId: 'user-1', params: { state: 'raw-state', code: 'abc' } },
				{ env: ENABLED_ENV, now: () => NOW }
			)
		).rejects.toMatchObject({ code: 'invalid_state' });
		expect(prismaMock.bankAuthorizationRequest.updateMany).not.toHaveBeenCalled();
	});

	it('throws invalid_state when the row is already consumed (single-use guard, updateMany count 0)', async () => {
		prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce(baseRequest);
		prismaMock.bankAuthorizationRequest.updateMany.mockResolvedValueOnce({ count: 0 });

		await expect(
			completeBankAuthorization(
				{ userId: 'user-1', params: { state: 'raw-state', code: 'abc' } },
				{ env: ENABLED_ENV, now: () => NOW }
			)
		).rejects.toMatchObject({ code: 'invalid_state' });

		expect(prismaMock.bankAuthorizationRequest.updateMany).toHaveBeenCalledWith({
			where: { id: 'req-1', consumedAt: null },
			data: { consumedAt: NOW }
		});
	});

	it('throws authorization_failed (machine code only) when the connector rejects, never leaking params.code', async () => {
		prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce(baseRequest);
		prismaMock.bankAuthorizationRequest.updateMany.mockResolvedValueOnce({ count: 1 });
		const connector = fakeConnector({
			completeAuthorization: vi.fn().mockRejectedValue(new Error('leaked secret code XYZ'))
		});

		let caught: unknown;
		try {
			await completeBankAuthorization(
				{ userId: 'user-1', params: { state: 'raw-state', code: 'super-secret-auth-code' } },
				{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toMatchObject({ code: 'authorization_failed' });
		expect((caught as Error).message).not.toContain('super-secret-auth-code');
		expect((caught as Error).message).not.toContain('leaked secret code XYZ');
	});

	it('on success, creates the BankConnection and resolves one bucket per returned account', async () => {
		prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce(baseRequest);
		prismaMock.bankAuthorizationRequest.updateMany.mockResolvedValueOnce({ count: 1 });
		prismaMock.bankConnection.create.mockResolvedValueOnce({ id: 'conn-1' });
		const consentExpiresAt = new Date('2027-01-14T00:00:00.000Z');
		const connector = fakeConnector({
			completeAuthorization: vi.fn().mockResolvedValue({
				providerSessionId: 'sess-1',
				credentialsEncrypted: 'enc-blob',
				consentExpiresAt,
				accounts: [
					{ id: 'acc-1', name: 'Compte courant', currency: 'EUR' },
					{ id: 'acc-2', name: 'Livret', currency: 'EUR' }
				]
			})
		});
		persistMock.resolveImportBucketAccount.mockResolvedValue({ accountId: 'x', created: true });

		const result = await completeBankAuthorization(
			{ userId: 'user-1', params: { state: 'raw-state', code: 'auth-code' } },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		expect(result).toEqual({ connectionId: 'conn-1', accountCount: 2 });
		expect(prismaMock.bankConnection.create).toHaveBeenCalledWith({
			data: {
				userId: 'user-1',
				provider: 'mock',
				providerSessionId: 'sess-1',
				credentialsEncrypted: 'enc-blob',
				status: 'active',
				aspspName: 'Bank A',
				aspspCountry: 'FR',
				consentExpiresAt
			},
			select: { id: true }
		});

		expect(persistMock.resolveImportBucketAccount).toHaveBeenCalledTimes(2);
		expect(persistMock.resolveImportBucketAccount).toHaveBeenNthCalledWith(1, {
			userId: 'user-1',
			name: 'Compte courant',
			source: 'mock_connector',
			// The pair, never a bare currency: `ImportBucketInput.denomination` is one field so a
			// caller cannot supply a code without the exponent that says how to read the integers
			// filed under it. The provider names only the code, so the exponent is stated at the
			// call site in sync/service.ts rather than defaulted out of sight.
			denomination: { currency: 'EUR', exponent: 2 },
			bankConnectionId: 'conn-1',
			providerAccountId: 'acc-1',
			providerCashAccountType: null
		});
		expect(persistMock.resolveImportBucketAccount).toHaveBeenNthCalledWith(2, {
			userId: 'user-1',
			name: 'Livret',
			source: 'mock_connector',
			// The pair, never a bare currency: `ImportBucketInput.denomination` is one field so a
			// caller cannot supply a code without the exponent that says how to read the integers
			// filed under it. The provider names only the code, so the exponent is stated at the
			// call site in sync/service.ts rather than defaulted out of sight.
			denomination: { currency: 'EUR', exponent: 2 },
			bankConnectionId: 'conn-1',
			providerAccountId: 'acc-2',
			providerCashAccountType: null
		});
	});

	it('propagates the connector-reported cashAccountType onto providerCashAccountType', async () => {
		prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce(baseRequest);
		prismaMock.bankAuthorizationRequest.updateMany.mockResolvedValueOnce({ count: 1 });
		prismaMock.bankConnection.create.mockResolvedValueOnce({ id: 'conn-1' });
		const consentExpiresAt = new Date('2027-01-14T00:00:00.000Z');
		const connector = fakeConnector({
			completeAuthorization: vi.fn().mockResolvedValue({
				providerSessionId: 'sess-1',
				credentialsEncrypted: 'enc-blob',
				consentExpiresAt,
				accounts: [
					{ id: 'acc-1', name: 'Compte courant', currency: 'EUR', cashAccountType: 'CACC' }
				]
			})
		});
		persistMock.resolveImportBucketAccount.mockResolvedValue({ accountId: 'x', created: true });

		await completeBankAuthorization(
			{ userId: 'user-1', params: { state: 'raw-state', code: 'auth-code' } },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		expect(persistMock.resolveImportBucketAccount).toHaveBeenCalledWith(
			expect.objectContaining({ providerCashAccountType: 'CACC' })
		);
	});

	it('maps a non-mock provider id directly to Transaction.source', async () => {
		prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce({
			...baseRequest,
			provider: 'enablebanking'
		});
		prismaMock.bankAuthorizationRequest.updateMany.mockResolvedValueOnce({ count: 1 });
		prismaMock.bankConnection.create.mockResolvedValueOnce({ id: 'conn-2' });
		const connector = fakeConnector({
			completeAuthorization: vi.fn().mockResolvedValue({
				providerSessionId: 'sess-2',
				credentialsEncrypted: null,
				consentExpiresAt: null,
				accounts: [{ id: 'acc-1', name: 'Compte', currency: 'EUR' }]
			})
		});
		persistMock.resolveImportBucketAccount.mockResolvedValue({ accountId: 'x', created: true });

		await completeBankAuthorization(
			{ userId: 'user-1', params: { state: 'raw-state', code: 'auth-code' } },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		expect(persistMock.resolveImportBucketAccount).toHaveBeenCalledWith(
			expect.objectContaining({ source: 'enablebanking' })
		);
	});

	describe('renewal (request.renewsConnectionId set)', () => {
		it('updates the existing connection in place instead of creating one, and resolves buckets with its id', async () => {
			prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce({
				...baseRequest,
				renewsConnectionId: 'conn-1'
			});
			prismaMock.bankAuthorizationRequest.updateMany.mockResolvedValueOnce({ count: 1 });
			prismaMock.bankConnection.updateMany.mockResolvedValueOnce({ count: 1 });
			const consentExpiresAt = new Date('2027-02-01T00:00:00.000Z');
			const connector = fakeConnector({
				completeAuthorization: vi.fn().mockResolvedValue({
					providerSessionId: 'sess-renewed',
					credentialsEncrypted: 'enc-renewed',
					consentExpiresAt,
					accounts: [{ id: 'acc-1', name: 'Compte courant', currency: 'EUR' }]
				})
			});
			persistMock.resolveImportBucketAccount.mockResolvedValue({ accountId: 'x', created: false });

			const result = await completeBankAuthorization(
				{ userId: 'user-1', params: { state: 'raw-state', code: 'auth-code' } },
				{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
			);

			expect(result).toEqual({ connectionId: 'conn-1', accountCount: 1 });
			expect(prismaMock.bankConnection.updateMany).toHaveBeenCalledWith({
				where: { id: 'conn-1', userId: 'user-1', provider: 'mock' },
				data: {
					providerSessionId: 'sess-renewed',
					credentialsEncrypted: 'enc-renewed',
					status: 'active',
					consentExpiresAt,
					lastSyncStatus: null,
					lastSyncError: null
				}
			});
			expect(prismaMock.bankConnection.create).not.toHaveBeenCalled();
			expect(persistMock.resolveImportBucketAccount).toHaveBeenCalledWith(
				expect.objectContaining({ bankConnectionId: 'conn-1', providerAccountId: 'acc-1' })
			);
		});

		it('falls back to creating a new connection when the renewal target was deleted meanwhile (updateMany count 0)', async () => {
			prismaMock.bankAuthorizationRequest.findUnique.mockResolvedValueOnce({
				...baseRequest,
				renewsConnectionId: 'conn-deleted'
			});
			prismaMock.bankAuthorizationRequest.updateMany.mockResolvedValueOnce({ count: 1 });
			prismaMock.bankConnection.updateMany.mockResolvedValueOnce({ count: 0 });
			prismaMock.bankConnection.create.mockResolvedValueOnce({ id: 'conn-fresh' });
			const connector = fakeConnector({
				completeAuthorization: vi.fn().mockResolvedValue({
					providerSessionId: 'sess-1',
					credentialsEncrypted: 'enc-blob',
					consentExpiresAt: null,
					accounts: []
				})
			});

			const result = await completeBankAuthorization(
				{ userId: 'user-1', params: { state: 'raw-state', code: 'auth-code' } },
				{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
			);

			expect(result).toEqual({ connectionId: 'conn-fresh', accountCount: 0 });
			expect(prismaMock.bankConnection.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ userId: 'user-1', provider: 'mock' })
				})
			);
		});
	});
});

describe('listUserBankConnections', () => {
	it('never returns providerSessionId, credentialsEncrypted or lastSyncError', async () => {
		prismaMock.bankConnection.findMany.mockResolvedValueOnce([
			{
				id: 'conn-1',
				provider: 'mock',
				aspspName: 'Bank A',
				status: 'active',
				consentExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
				lastSyncAt: new Date('2026-07-01T00:00:00.000Z'),
				lastSyncStatus: 'ok',
				createdAt: new Date('2026-06-01T00:00:00.000Z'),
				accounts: [
					{
						id: 'account-1',
						name: 'Compte courant',
						netWorthAccountId: 'nwa-1',
						providerCashAccountType: 'CACC',
						netWorthAccount: { name: 'Compte courant NW' }
					},
					{
						id: 'account-2',
						name: 'Livret',
						netWorthAccountId: null,
						providerCashAccountType: null,
						netWorthAccount: null
					}
				]
			}
		]);

		const result = await listUserBankConnections('user-1');

		expect(result).toEqual([
			{
				id: 'conn-1',
				provider: 'mock',
				aspspName: 'Bank A',
				status: 'active',
				consentExpiresAt: '2027-01-01T00:00:00.000Z',
				lastSyncAt: '2026-07-01T00:00:00.000Z',
				lastSyncStatus: 'ok',
				syncAvailableAt: '2026-07-01T06:00:00.000Z',
				accountCount: 2,
				accounts: [
					{
						id: 'account-1',
						name: 'Compte courant',
						netWorthAccountId: 'nwa-1',
						netWorthAccountName: 'Compte courant NW',
						providerCashAccountType: 'CACC'
					},
					{
						id: 'account-2',
						name: 'Livret',
						netWorthAccountId: null,
						netWorthAccountName: null,
						providerCashAccountType: null
					}
				],
				createdAt: '2026-06-01T00:00:00.000Z'
			}
		]);
		for (const connection of result) {
			expect(connection).not.toHaveProperty('providerSessionId');
			expect(connection).not.toHaveProperty('credentialsEncrypted');
			expect(connection).not.toHaveProperty('lastSyncError');
		}
		expect(prismaMock.bankConnection.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId: 'user-1' } })
		);
	});

	it('maps null dates to null strings', async () => {
		prismaMock.bankConnection.findMany.mockResolvedValueOnce([
			{
				id: 'conn-1',
				provider: 'mock',
				aspspName: null,
				status: 'active',
				consentExpiresAt: null,
				lastSyncAt: null,
				lastSyncStatus: null,
				createdAt: new Date('2026-06-01T00:00:00.000Z'),
				accounts: []
			}
		]);

		const [result] = await listUserBankConnections('user-1');
		expect(result.consentExpiresAt).toBeNull();
		expect(result.lastSyncAt).toBeNull();
	});

	it('sets syncAvailableAt to null when lastSyncAt is null', async () => {
		prismaMock.bankConnection.findMany.mockResolvedValueOnce([
			{
				id: 'conn-1',
				provider: 'mock',
				aspspName: 'Bank A',
				status: 'active',
				consentExpiresAt: null,
				lastSyncAt: null,
				lastSyncStatus: null,
				createdAt: new Date('2026-06-01T00:00:00.000Z'),
				accounts: []
			}
		]);

		const [result] = await listUserBankConnections('user-1');
		expect(result.syncAvailableAt).toBeNull();
	});
});

describe('syncBankConnection', () => {
	const activeConnection = {
		id: 'conn-1',
		userId: 'user-1',
		provider: 'mock',
		providerSessionId: 'sess-1',
		credentialsEncrypted: null,
		status: 'active' as const,
		aspspName: 'Bank A',
		consentExpiresAt: new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 30),
		lastSyncAt: null as Date | null
	};

	it('throws not_found for a connection belonging to another user', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce(null);
		await expect(
			syncBankConnection(
				{ userId: 'user-1', connectionId: 'conn-1' },
				{ env: ENABLED_ENV, now: () => NOW }
			)
		).rejects.toMatchObject({ code: 'not_found' });
		expect(prismaMock.bankConnection.findFirst).toHaveBeenCalledWith({
			where: { id: 'conn-1', userId: 'user-1' }
		});
	});

	it.each(['revoked', 'expired'])('returns outcome "unavailable" for status %s', async (status) => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce({ ...activeConnection, status });
		const result = await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW }
		);
		expect(result).toEqual({ outcome: 'unavailable' });
		expect(prismaMock.bankConnection.update).not.toHaveBeenCalled();
	});

	it('marks the connection expired and returns "consent_expired" when consentExpiresAt has passed', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce({
			...activeConnection,
			consentExpiresAt: new Date(NOW.getTime() - 1)
		});
		const result = await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW }
		);
		expect(result).toEqual({ outcome: 'consent_expired' });
		expect(prismaMock.bankConnection.update).toHaveBeenCalledWith({
			where: { id: 'conn-1' },
			data: { status: 'expired' }
		});
	});

	it('returns "throttled" when lastSyncAt is under 6h old and force is not set', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce({
			...activeConnection,
			lastSyncAt: new Date(NOW.getTime() - 1000 * 60 * 60) // 1h ago
		});
		const result = await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW }
		);
		expect(result).toEqual({ outcome: 'throttled' });
	});

	it('returns "throttled" when the atomic claim loses the race to a concurrent sync (updateMany count 0)', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
		prismaMock.bankConnection.updateMany.mockResolvedValueOnce({ count: 0 });

		const result = await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW }
		);

		expect(result).toEqual({ outcome: 'throttled' });
		expect(prismaMock.bankConnection.updateMany).toHaveBeenCalledWith({
			where: { id: 'conn-1', userId: 'user-1', lastSyncAt: activeConnection.lastSyncAt },
			data: { lastSyncAt: NOW }
		});
		expect(prismaMock.account.findMany).not.toHaveBeenCalled();
	});

	it('bypasses the throttle when force is true', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce({
			...activeConnection,
			lastSyncAt: new Date(NOW.getTime() - 1000 * 60 * 60)
		});
		prismaMock.account.findMany.mockResolvedValueOnce([]);
		prismaMock.bankConnection.update.mockResolvedValueOnce({});
		const connector = fakeConnector();

		const result = await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1', force: true },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		expect(result).toEqual({ outcome: 'synced', importedRows: 0, duplicateRows: 0 });
	});

	it('fetches only buckets with a non-null providerAccountId, persists via the shared module, and marks lastSyncStatus ok', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
		prismaMock.account.findMany.mockResolvedValueOnce([
			{ id: 'account-1', providerAccountId: 'acc-1' },
			{ id: 'account-2', providerAccountId: 'acc-2' }
		]);
		prismaMock.bankConnection.update.mockResolvedValue({});
		persistMock.createImportBatch.mockResolvedValue('batch-1');
		persistMock.persistImportedTransactions.mockResolvedValue({
			importedRows: 3,
			duplicateRows: 1
		});
		const fetchTransactions = vi
			.fn()
			.mockResolvedValueOnce([{ id: 't1' }])
			.mockResolvedValueOnce([{ id: 't2' }]);
		const connector = fakeConnector({ fetchTransactions });

		const result = await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		expect(prismaMock.account.findMany).toHaveBeenCalledWith({
			where: { userId: 'user-1', bankConnectionId: 'conn-1', providerAccountId: { not: null } },
			select: { id: true, providerAccountId: true, netWorthAccountId: true, currency: true }
		});
		expect(fetchTransactions).toHaveBeenCalledTimes(2);
		expect(persistMock.createImportBatch).toHaveBeenCalledTimes(2);
		expect(persistMock.createImportBatch).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'user-1', source: 'mock_connector' })
		);
		expect(persistMock.persistImportedTransactions).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'user-1',
				accountId: 'account-1',
				importBatchId: 'batch-1',
				source: 'mock_connector'
			})
		);
		expect(result).toEqual({ outcome: 'synced', importedRows: 6, duplicateRows: 2 });
		expect(prismaMock.bankConnection.update).toHaveBeenCalledWith({
			where: { id: 'conn-1' },
			data: { lastSyncAt: NOW, lastSyncStatus: 'ok', lastSyncError: null }
		});
	});

	it('uses a ~90 day lookback range on the first sync (no lastSyncAt)', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce({
			...activeConnection,
			lastSyncAt: null
		});
		prismaMock.account.findMany.mockResolvedValueOnce([
			{ id: 'account-1', providerAccountId: 'acc-1' }
		]);
		prismaMock.bankConnection.update.mockResolvedValue({});
		persistMock.createImportBatch.mockResolvedValue('batch-1');
		persistMock.persistImportedTransactions.mockResolvedValue({
			importedRows: 0,
			duplicateRows: 0
		});
		const fetchTransactions = vi.fn().mockResolvedValue([{ id: 't1' }]);
		const connector = fakeConnector({ fetchTransactions });

		await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		const [, , range] = fetchTransactions.mock.calls[0];
		expect(range.to).toBe('2026-07-19');
		const fromDate = new Date(`${range.from}T00:00:00.000Z`);
		const daysBack = (NOW.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
		expect(daysBack).toBeGreaterThan(89);
		expect(daysBack).toBeLessThan(91);
	});

	it('honors BANK_SYNC_FIRST_LOOKBACK_DAYS on the first sync, ignoring out-of-bounds values', async () => {
		const runFirstSync = async (lookbackValue: string) => {
			prismaMock.bankConnection.findFirst.mockResolvedValueOnce({
				...activeConnection,
				lastSyncAt: null
			});
			prismaMock.account.findMany.mockResolvedValueOnce([
				{ id: 'account-1', providerAccountId: 'acc-1' }
			]);
			prismaMock.bankConnection.update.mockResolvedValue({});
			persistMock.createImportBatch.mockResolvedValue('batch-1');
			persistMock.persistImportedTransactions.mockResolvedValue({
				importedRows: 0,
				duplicateRows: 0
			});
			const fetchTransactions = vi.fn().mockResolvedValue([{ id: 't1' }]);
			const connector = fakeConnector({ fetchTransactions });
			await syncBankConnection(
				{ userId: 'user-1', connectionId: 'conn-1' },
				{
					env: { ...ENABLED_ENV, BANK_SYNC_FIRST_LOOKBACK_DAYS: lookbackValue },
					now: () => NOW,
					getConnector: () => connector
				}
			);
			const [, , range] = fetchTransactions.mock.calls[0];
			const fromDate = new Date(`${range.from}T00:00:00.000Z`);
			return (NOW.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
		};

		// ±1 day tolerance: the range's `from` is truncated to an ISO date.
		expect(await runFirstSync('2200')).toBeGreaterThan(2199);
		expect(await runFirstSync('2200')).toBeLessThan(2201);
		// Invalid or out-of-bounds values fall back to the 90-day default.
		for (const invalid of ['0', '999999', 'not-a-number']) {
			const daysBack = await runFirstSync(invalid);
			expect(daysBack).toBeGreaterThan(89);
			expect(daysBack).toBeLessThan(91);
		}
	});

	it('uses a lastSyncAt - 7 day overlap range on a subsequent sync', async () => {
		const lastSyncAt = new Date('2026-07-10T00:00:00.000Z');
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce({ ...activeConnection, lastSyncAt });
		prismaMock.account.findMany.mockResolvedValueOnce([
			{ id: 'account-1', providerAccountId: 'acc-1' }
		]);
		prismaMock.bankConnection.update.mockResolvedValue({});
		persistMock.createImportBatch.mockResolvedValue('batch-1');
		persistMock.persistImportedTransactions.mockResolvedValue({
			importedRows: 0,
			duplicateRows: 0
		});
		const fetchTransactions = vi.fn().mockResolvedValue([{ id: 't1' }]);
		const connector = fakeConnector({ fetchTransactions });

		await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1', force: true },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		const [, , range] = fetchTransactions.mock.calls[0];
		expect(range.from).toBe('2026-07-03'); // lastSyncAt - 7 days
	});

	it('skips createImportBatch/persistImportedTransactions when the bucket has no transactions', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
		prismaMock.account.findMany.mockResolvedValueOnce([
			{ id: 'account-1', providerAccountId: 'acc-1' }
		]);
		prismaMock.bankConnection.update.mockResolvedValue({});
		const connector = fakeConnector({ fetchTransactions: vi.fn().mockResolvedValue([]) });

		const result = await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		expect(persistMock.createImportBatch).not.toHaveBeenCalled();
		expect(persistMock.persistImportedTransactions).not.toHaveBeenCalled();
		expect(result).toEqual({ outcome: 'synced', importedRows: 0, duplicateRows: 0 });
	});

	it('on an EnableBankingApiError, stores a sanitized "http_STATUS:CODE" summary, sets status "error" only for 401/403, and returns outcome "error"', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
		prismaMock.account.findMany.mockResolvedValueOnce([
			{ id: 'account-1', providerAccountId: 'acc-1' }
		]);
		prismaMock.bankConnection.update.mockResolvedValue({});
		const connector = fakeConnector({
			fetchTransactions: vi
				.fn()
				.mockRejectedValue(new EnableBankingApiError(500, 'SOME_CODE', 'raw sensitive body'))
		});

		const result = await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		expect(result).toEqual({ outcome: 'error' });
		expect(prismaMock.bankConnection.update).toHaveBeenCalledWith({
			where: { id: 'conn-1' },
			data: { lastSyncAt: NOW, lastSyncStatus: 'error', lastSyncError: 'http_500:SOME_CODE' }
		});
	});

	it('sets status "error" when the EnableBankingApiError is a 401 (auth rejection)', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
		prismaMock.account.findMany.mockResolvedValueOnce([
			{ id: 'account-1', providerAccountId: 'acc-1' }
		]);
		prismaMock.bankConnection.update.mockResolvedValue({});
		const connector = fakeConnector({
			fetchTransactions: vi
				.fn()
				.mockRejectedValue(new EnableBankingApiError(401, null, 'unauthorized'))
		});

		await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		expect(prismaMock.bankConnection.update).toHaveBeenCalledWith({
			where: { id: 'conn-1' },
			data: {
				lastSyncAt: NOW,
				lastSyncStatus: 'error',
				lastSyncError: 'http_401',
				status: 'error'
			}
		});
	});

	it('stores the generic "sync_failed" marker (never the raw message) and leaves status untouched for a non-EnableBanking error', async () => {
		prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
		prismaMock.account.findMany.mockResolvedValueOnce([
			{ id: 'account-1', providerAccountId: 'acc-1' }
		]);
		prismaMock.bankConnection.update.mockResolvedValue({});
		const connector = fakeConnector({
			fetchTransactions: vi.fn().mockRejectedValue(new Error('database is on fire, leaking creds'))
		});

		const result = await syncBankConnection(
			{ userId: 'user-1', connectionId: 'conn-1' },
			{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
		);

		expect(result).toEqual({ outcome: 'error' });
		const updateCall = prismaMock.bankConnection.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(updateCall.data.lastSyncError).toBe('sync_failed');
		expect(updateCall.data.lastSyncError).not.toContain('database is on fire');
		expect(updateCall.data).not.toHaveProperty('status');
	});

	describe('balance enrichment', () => {
		it('calls recordSyncedBalance when the bucket is linked and fetchAccountBalance resolves a balance', async () => {
			prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
			prismaMock.account.findMany.mockResolvedValueOnce([
				{
					id: 'account-1',
					providerAccountId: 'acc-1',
					netWorthAccountId: 'nw-1',
					currency: 'EUR'
				}
			]);
			prismaMock.bankConnection.update.mockResolvedValue({});
			persistMock.createImportBatch.mockResolvedValue('batch-1');
			persistMock.persistImportedTransactions.mockResolvedValue({
				importedRows: 0,
				duplicateRows: 0
			});
			const fetchAccountBalance = vi.fn().mockResolvedValue({
				balanceCents: 12345,
				currency: 'EUR',
				balanceType: 'CLBD',
				asOf: new Date('2026-07-19')
			});
			const connector = fakeConnector({
				fetchTransactions: vi.fn().mockResolvedValue([]),
				fetchAccountBalance
			});

			const result = await syncBankConnection(
				{ userId: 'user-1', connectionId: 'conn-1' },
				{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
			);

			expect(result).toEqual({ outcome: 'synced', importedRows: 0, duplicateRows: 0 });
			expect(fetchAccountBalance).toHaveBeenCalledWith(expect.anything(), 'acc-1', 'EUR');
			expect(netWorthMock.recordSyncedBalance).toHaveBeenCalledWith('user-1', 'nw-1', 12345, NOW);
		});

		it('skips the balance step entirely when the bucket has no netWorthAccountId', async () => {
			prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
			prismaMock.account.findMany.mockResolvedValueOnce([
				{ id: 'account-1', providerAccountId: 'acc-1', netWorthAccountId: null, currency: 'EUR' }
			]);
			prismaMock.bankConnection.update.mockResolvedValue({});
			persistMock.createImportBatch.mockResolvedValue('batch-1');
			persistMock.persistImportedTransactions.mockResolvedValue({
				importedRows: 0,
				duplicateRows: 0
			});
			const fetchAccountBalance = vi.fn();
			const connector = fakeConnector({
				fetchTransactions: vi.fn().mockResolvedValue([]),
				fetchAccountBalance
			});

			const result = await syncBankConnection(
				{ userId: 'user-1', connectionId: 'conn-1' },
				{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
			);

			expect(result).toEqual({ outcome: 'synced', importedRows: 0, duplicateRows: 0 });
			expect(fetchAccountBalance).not.toHaveBeenCalled();
			expect(netWorthMock.recordSyncedBalance).not.toHaveBeenCalled();
		});

		it('still completes as "synced" when fetchAccountBalance throws — the throw never propagates to the outer catch', async () => {
			prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
			prismaMock.account.findMany.mockResolvedValueOnce([
				{
					id: 'account-1',
					providerAccountId: 'acc-1',
					netWorthAccountId: 'nw-1',
					currency: 'EUR'
				}
			]);
			prismaMock.bankConnection.update.mockResolvedValue({});
			persistMock.createImportBatch.mockResolvedValue('batch-1');
			persistMock.persistImportedTransactions.mockResolvedValue({
				importedRows: 3,
				duplicateRows: 0
			});
			const fetchAccountBalance = vi.fn().mockRejectedValue(new Error('balance endpoint down'));
			const connector = fakeConnector({
				fetchTransactions: vi.fn().mockResolvedValue([{ id: 't1' }]),
				fetchAccountBalance
			});
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await syncBankConnection(
				{ userId: 'user-1', connectionId: 'conn-1' },
				{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
			);

			expect(result).toEqual({ outcome: 'synced', importedRows: 3, duplicateRows: 0 });
			expect(netWorthMock.recordSyncedBalance).not.toHaveBeenCalled();
			expect(prismaMock.bankConnection.update).toHaveBeenCalledWith({
				where: { id: 'conn-1' },
				data: { lastSyncAt: NOW, lastSyncStatus: 'ok', lastSyncError: null }
			});
			warnSpy.mockRestore();
		});

		it('completes normally with no crash when the connector does not implement fetchAccountBalance at all', async () => {
			prismaMock.bankConnection.findFirst.mockResolvedValueOnce(activeConnection);
			prismaMock.account.findMany.mockResolvedValueOnce([
				{
					id: 'account-1',
					providerAccountId: 'acc-1',
					netWorthAccountId: 'nw-1',
					currency: 'EUR'
				}
			]);
			prismaMock.bankConnection.update.mockResolvedValue({});
			persistMock.createImportBatch.mockResolvedValue('batch-1');
			persistMock.persistImportedTransactions.mockResolvedValue({
				importedRows: 0,
				duplicateRows: 0
			});
			// No fetchAccountBalance key at all — matches an optional-method connector (e.g. the
			// EnableBanking stub / a minimal test double), not a spy resolving to undefined.
			const connector = fakeConnector({ fetchTransactions: vi.fn().mockResolvedValue([]) });

			const result = await syncBankConnection(
				{ userId: 'user-1', connectionId: 'conn-1' },
				{ env: ENABLED_ENV, now: () => NOW, getConnector: () => connector }
			);

			expect(result).toEqual({ outcome: 'synced', importedRows: 0, duplicateRows: 0 });
			expect(netWorthMock.recordSyncedBalance).not.toHaveBeenCalled();
		});
	});
});

describe('deleteBankConnection', () => {
	beforeEach(() => {
		// The callback receives the same fake as its `tx`, so both statements are observable.
		prismaMock.$transaction.mockImplementation((callback: (tx: typeof prismaMock) => unknown) =>
			callback(prismaMock)
		);
		prismaMock.account.updateMany.mockResolvedValue({ count: 0 });
	});

	it('scopes the delete by userId and connectionId, returning true when a row was deleted', async () => {
		prismaMock.bankConnection.deleteMany.mockResolvedValueOnce({ count: 1 });
		const result = await deleteBankConnection('user-1', 'conn-1');
		expect(result).toBe(true);
		expect(prismaMock.bankConnection.deleteMany).toHaveBeenCalledWith({
			where: { id: 'conn-1', userId: 'user-1' }
		});
	});

	it('returns false when no row matched (wrong user or unknown id)', async () => {
		prismaMock.bankConnection.deleteMany.mockResolvedValueOnce({ count: 0 });
		const result = await deleteBankConnection('user-1', 'conn-not-mine');
		expect(result).toBe(false);
	});

	/**
	 * The SHAPE of the clearing, which is what a fake can honestly answer: the `where` names the
	 * user AND the connection, so the write cannot reach a bucket belonging to either another
	 * tenant or another connection.
	 *
	 * Whether it actually clears anything, whether the bucket and its transactions survive, and
	 * whether a manual link is left alone are all questions about the database, and they are
	 * asserted against a real engine in `connectedBadgeOutlivesConnection.db-smoke.ts`. Removing
	 * the ownership clause leaves that suite green, which is recorded there rather than papered
	 * over: this assertion is the only place the clause is pinned at all.
	 */
	it('clears the net worth link on that connection’s buckets, scoped to the owner', async () => {
		expect.assertions(2);
		prismaMock.bankConnection.deleteMany.mockResolvedValueOnce({ count: 1 });

		await deleteBankConnection('user-1', 'conn-1');

		expect(prismaMock.account.updateMany).toHaveBeenCalledWith({
			where: { userId: 'user-1', bankConnectionId: 'conn-1', netWorthAccountId: { not: null } },
			data: { netWorthAccountId: null }
		});
		// Ordering is not decorative: the buckets are found BY the connection, so a clearing that
		// ran after the delete would find none.
		expect(prismaMock.account.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
			prismaMock.bankConnection.deleteMany.mock.invocationCallOrder[0]
		);
	});
});

describe('BankSyncError', () => {
	it('carries only the machine code, never a param/context-dependent message', () => {
		const error = new BankSyncError('unknown_bank');
		expect(error.code).toBe('unknown_bank');
		expect(error.name).toBe('BankSyncError');
		expect(error.message).toBe('Bank sync error: unknown_bank');
	});
});
