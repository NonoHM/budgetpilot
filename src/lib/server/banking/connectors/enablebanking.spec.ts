import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EnableBankingConnector } from './enablebanking';
import { UNCLASSIFIED_CATEGORY } from '$lib/server/import/utils/safety';
import { assignDedupeKeysForBatch } from '$lib/server/import/dedupeRecompute';

/**
 * The bucket these rows land in. The key is built by the write path now, so a spec that wants to
 * talk about fingerprints asks that path what it would write, through the same function it calls.
 */
const EB_BUCKET = {
	accountId: 'account-1',
	source: 'enablebanking',
	currency: 'EUR',
	exponent: 2,
	providerAccountId: 'acc-1'
};

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const BASE_ENV = {
	BANK_SYNC_ENABLED: 'true',
	ENABLE_BANKING_APP_ID: 'test-app',
	ENABLE_BANKING_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function decodeJwt(token: string): {
	header: Record<string, unknown>;
	payload: Record<string, unknown>;
} {
	const [headerPart, payloadPart] = token.split('.');
	const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
	const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
	return { header, payload };
}

function makeConnector(overrides: {
	env?: Record<string, string | undefined>;
	fetchImpl?: ReturnType<typeof vi.fn>;
	now?: () => Date;
}) {
	const fetchImpl = overrides.fetchImpl ?? vi.fn();
	const connector = new EnableBankingConnector({
		env: { ...BASE_ENV, ...overrides.env } as unknown as NodeJS.ProcessEnv,
		fetchImpl: fetchImpl as unknown as typeof fetch,
		now: overrides.now ?? (() => new Date('2026-07-18T00:00:00.000Z'))
	});
	return { connector, fetchImpl };
}

describe('EnableBankingConnector — gating', () => {
	it('rejette createConnection quand BANK_SYNC_ENABLED est absent, sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({ env: { BANK_SYNC_ENABLED: undefined } });
		await expect(
			connector.createConnection({
				redirectUrl: 'http://localhost/cb',
				aspsp: { name: 'Test Bank', country: 'FR' }
			})
		).rejects.toThrow('Bank sync is disabled');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejette quand BANK_SYNC_ENABLED vaut "false", sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({ env: { BANK_SYNC_ENABLED: 'false' } });
		await expect(
			connector.createConnection({
				redirectUrl: 'http://localhost/cb',
				aspsp: { name: 'Test Bank', country: 'FR' }
			})
		).rejects.toThrow('Bank sync is disabled');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejette une base URL non whitelistée, sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({
			env: { ENABLE_BANKING_BASE_URL: 'https://evil.example' }
		});
		await expect(
			connector.createConnection({
				redirectUrl: 'http://localhost/cb',
				aspsp: { name: 'Test Bank', country: 'FR' }
			})
		).rejects.toThrow('not allowlisted');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejette quand ENABLE_BANKING_APP_ID est manquant, sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({ env: { ENABLE_BANKING_APP_ID: undefined } });
		await expect(
			connector.createConnection({
				redirectUrl: 'http://localhost/cb',
				aspsp: { name: 'Test Bank', country: 'FR' }
			})
		).rejects.toThrow('credentials are not configured');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejette quand ENABLE_BANKING_PRIVATE_KEY est manquant, sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({
			env: { ENABLE_BANKING_PRIVATE_KEY: undefined }
		});
		await expect(
			connector.createConnection({
				redirectUrl: 'http://localhost/cb',
				aspsp: { name: 'Test Bank', country: 'FR' }
			})
		).rejects.toThrow('credentials are not configured');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('EnableBankingConnector, SSRF redirect guard (#215)', () => {
	it('REFUSES a provider redirect to a non-allowlisted host and never fetches it', async () => {
		// Allowlisted base (default api.enablebanking.com), but the provider answers 302 to an
		// internal host. Pre-fix, fetch auto-followed and issued GET to 127.0.0.2; now the redirect
		// target is re-validated against the same allowlist and refused.
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: 'http://127.0.0.2:9998/latest/meta-data/' }
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		await expect(
			connector.createConnection({
				redirectUrl: 'http://localhost/cb',
				aspsp: { name: 'Test Bank', country: 'FR' }
			})
		).rejects.toThrow(/not allowlisted/);

		// Only the first hop ran; the internal target was never requested.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl.mock.calls.map((call) => String(call[0]))).not.toContain(
			'http://127.0.0.2:9998/latest/meta-data/'
		);
	});
});

describe('EnableBankingConnector — JWT signing', () => {
	it("signe l'Authorization header avec un JWT RS256 correctement formé", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ url: 'https://bank.example/authorize' }));
		const { connector } = makeConnector({ fetchImpl });

		await connector.createConnection({
			redirectUrl: 'http://localhost/cb',
			aspsp: { name: 'Test Bank', country: 'FR' }
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [, requestInit] = fetchImpl.mock.calls[0];
		const authHeader = (requestInit.headers as Record<string, string>).Authorization;
		expect(authHeader).toMatch(/^Bearer .+/);
		const token = authHeader.replace('Bearer ', '');
		const { header, payload } = decodeJwt(token);

		expect(header.alg).toBe('RS256');
		expect(header.kid).toBe('test-app');
		expect(payload.iss).toBe('enablebanking.com');
		expect(payload.aud).toBe('api.enablebanking.com');
		expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
	});
});

describe('EnableBankingConnector — createConnection', () => {
	it("échoue avec 'Missing ASPSP selection' sans appeler fetch quand aspsp est absent", async () => {
		const { connector, fetchImpl } = makeConnector({});
		await expect(
			connector.createConnection({ redirectUrl: 'http://localhost/cb' })
		).rejects.toThrow('Missing ASPSP selection');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('envoie un POST /auth avec access.valid_until (~180 jours), aspsp, state, redirect_url et psu_type "personal"', async () => {
		const now = new Date('2026-07-18T00:00:00.000Z');
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ url: 'https://bank.example/authorize?x=1' }));
		const { connector } = makeConnector({ fetchImpl, now: () => now });

		const pending = await connector.createConnection({
			redirectUrl: 'http://localhost/cb',
			aspsp: { name: 'Test Bank', country: 'FR' }
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, requestInit] = fetchImpl.mock.calls[0];
		expect(String(url)).toContain('/auth');
		expect(requestInit.method).toBe('POST');
		const body = JSON.parse(requestInit.body as string);
		expect(body.aspsp).toEqual({ name: 'Test Bank', country: 'FR' });
		expect(body.redirect_url).toBe('http://localhost/cb');
		expect(body.psu_type).toBe('personal');
		expect(body.state).toBe(pending.state);

		const validUntil = new Date(body.access.valid_until);
		const daysAhead = (validUntil.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
		expect(daysAhead).toBeGreaterThan(179);
		expect(daysAhead).toBeLessThan(181);

		expect(pending.authorizationUrl).toBe('https://bank.example/authorize?x=1');
	});
});

describe('EnableBankingConnector — completeAuthorization', () => {
	it('rejette un state incohérent sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({});
		await expect(
			connector.completeAuthorization({
				params: { state: 'wrong', code: 'abc' },
				expectedState: 'expected'
			})
		).rejects.toThrow('Authorization state mismatch');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejette un state absent sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({});
		await expect(
			connector.completeAuthorization({ params: { code: 'abc' }, expectedState: 'expected' })
		).rejects.toThrow('Authorization state mismatch');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejette un code absent sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({});
		await expect(
			connector.completeAuthorization({ params: { state: 'match' }, expectedState: 'match' })
		).rejects.toThrow('Missing authorization code');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('réussit: POST /sessions {code}, retourne providerSessionId/credentialsEncrypted null/consentExpiresAt/accounts', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				session_id: 'sess-123',
				access: { valid_until: '2027-01-14T00:00:00.000Z' },
				accounts: [
					{ uid: 'acc-1', name: 'Compte courant', currency: 'EUR' },
					{ uid: 'acc-2', name: null, currency: 'EUR' }
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const established = await connector.completeAuthorization({
			params: { state: 'match', code: 'auth-code' },
			expectedState: 'match'
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, requestInit] = fetchImpl.mock.calls[0];
		expect(String(url)).toContain('/sessions');
		expect(requestInit.method).toBe('POST');
		expect(JSON.parse(requestInit.body as string)).toEqual({ code: 'auth-code' });

		expect(established.providerSessionId).toBe('sess-123');
		expect(established.credentialsEncrypted).toBeNull();
		expect(established.consentExpiresAt).toEqual(new Date('2027-01-14T00:00:00.000Z'));
		expect(established.accounts).toEqual([
			{
				id: 'acc-1',
				name: 'Compte courant',
				currency: 'EUR',
				cashAccountType: null,
				hasCreditLimit: false
			},
			{
				id: 'acc-2',
				name: 'Compte bancaire',
				currency: 'EUR',
				cashAccountType: null,
				hasCreditLimit: false
			}
		]);
	});

	// The currency a provider names is untrusted input on a NOT NULL column, and the backup
	// boundary enforces ISO 4217's grammar. Left unchecked here, a malformed code would be stored,
	// exported, and then make the user's OWN backup refuse to restore, with hand-editing JSON as
	// the only repair.
	it.each([
		['lowercase, the realistic provider deviation', 'gbp', 'GBP'],
		['padded', '  SEK  ', 'SEK'],
		['two letters, which Intl cannot render', 'AB', 'EUR'],
		['four letters', 'EURO', 'EUR'],
		['not a code at all', '<script>', 'EUR'],
		['absent', null, 'EUR']
	])('normalises a provider currency that is %s', async (_name, provided, expected) => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				session_id: 'sess-123',
				access: { valid_until: '2027-01-14T00:00:00.000Z' },
				accounts: [{ uid: 'acc-1', name: 'Compte', currency: provided }]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const established = await connector.completeAuthorization({
			params: { state: 'match', code: 'auth-code' },
			expectedState: 'match'
		});

		expect(established.accounts?.[0].currency).toBe(expected);
	});

	it('propage cash_account_type et hasCreditLimit (credit_limit présent) depuis la ressource compte', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				session_id: 'sess-123',
				accounts: [
					{
						uid: 'acc-4',
						name: 'Carte',
						currency: 'EUR',
						cash_account_type: 'CARD',
						credit_limit: { amount: '1000', currency: 'EUR' }
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const established = await connector.completeAuthorization({
			params: { state: 'match', code: 'auth-code' },
			expectedState: 'match'
		});

		expect(established.accounts).toEqual([
			{ id: 'acc-4', name: 'Carte', currency: 'EUR', cashAccountType: 'CARD', hasCreditLimit: true }
		]);
	});

	it('masque un IBAN utilisé comme nom de fallback (4 derniers caractères seulement)', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				session_id: 'sess-123',
				accounts: [
					{
						uid: 'acc-3',
						name: null,
						currency: 'EUR',
						account_id: { iban: 'FR7612345678901234567890123' }
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const established = await connector.completeAuthorization({
			params: { state: 'match', code: 'auth-code' },
			expectedState: 'match'
		});

		expect(established.accounts).toEqual([
			{
				id: 'acc-3',
				name: 'Compte ****0123',
				currency: 'EUR',
				cashAccountType: null,
				hasCreditLimit: false
			}
		]);
		expect(established.accounts?.[0].name).not.toContain('FR76');
	});
});

describe('EnableBankingConnector — listAccounts', () => {
	it('effectue un GET /sessions/{id} et mappe les uids nus avec un nom de fallback', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ status: 'AUTHORIZED', accounts: ['acc-a', 'acc-b'] }));
		const { connector } = makeConnector({ fetchImpl });

		const accounts = await connector.listAccounts({
			providerSessionId: 'sess-123',
			credentialsEncrypted: null,
			consentExpiresAt: null
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, requestInit] = fetchImpl.mock.calls[0];
		expect(String(url)).toContain('/sessions/sess-123');
		expect(requestInit.method ?? 'GET').toBe('GET');
		expect(accounts).toEqual([
			{ id: 'acc-a', name: 'Compte 1', currency: 'EUR' },
			{ id: 'acc-b', name: 'Compte 2', currency: 'EUR' }
		]);
	});

	it('rejette sans providerSessionId, sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({});
		await expect(
			connector.listAccounts({
				providerSessionId: null,
				credentialsEncrypted: null,
				consentExpiresAt: null
			})
		).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('EnableBankingConnector — fetchTransactions', () => {
	const activeConnection = {
		providerSessionId: 'sess-123',
		credentialsEncrypted: null,
		consentExpiresAt: null
	};

	function txPage(transactions: unknown[], continuationKey?: string) {
		return jsonResponse({ transactions, continuation_key: continuationKey ?? null });
	}

	it('pagine via continuation_key et concatène les transactions des deux pages', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				txPage(
					[
						{
							entry_reference: 'ref-1',
							booking_date: '2026-01-01',
							status: 'BOOK',
							credit_debit_indicator: 'DBIT',
							transaction_amount: { currency: 'EUR', amount: '10.00' },
							remittance_information: ['Achat 1'],
							creditor: { name: 'Marchand 1' }
						}
					],
					'cont-key-1'
				)
			)
			.mockResolvedValueOnce(
				txPage([
					{
						entry_reference: 'ref-2',
						booking_date: '2026-01-02',
						status: 'BOOK',
						credit_debit_indicator: 'DBIT',
						transaction_amount: { currency: 'EUR', amount: '20.00' },
						remittance_information: ['Achat 2'],
						creditor: { name: 'Marchand 2' }
					}
				])
			);
		const { connector } = makeConnector({ fetchImpl });

		const transactions = await connector.fetchTransactions(activeConnection, 'acc-1', {
			from: '2026-01-01',
			to: '2026-01-31'
		});

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const secondUrl = new URL(String(fetchImpl.mock.calls[1][0]));
		expect(secondUrl.searchParams.get('continuation_key')).toBe('cont-key-1');
		const firstUrl = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(firstUrl.searchParams.get('continuation_key')).toBeNull();

		expect(transactions).toHaveLength(2);
		expect(transactions.map((tx) => tx.date)).toEqual(['2026-01-01', '2026-01-02']);
	});

	it('mappe CRDT en revenu positif et DBIT en dépense négative', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			txPage([
				{
					entry_reference: 'ref-crdt',
					booking_date: '2026-01-01',
					status: 'BOOK',
					credit_debit_indicator: 'CRDT',
					transaction_amount: { currency: 'EUR', amount: '12.34' },
					debtor: { name: 'Employeur' }
				},
				{
					entry_reference: 'ref-dbit',
					booking_date: '2026-01-02',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '12.34' },
					creditor: { name: 'Marchand' }
				}
			])
		);
		const { connector } = makeConnector({ fetchImpl });

		const transactions = await connector.fetchTransactions(activeConnection, 'acc-1', {
			from: '2026-01-01',
			to: '2026-01-31'
		});

		expect(transactions[0].amountCents).toBe(1234);
		expect(transactions[0].metadata.type).toBe('income');
		expect(transactions[1].amountCents).toBe(-1234);
		expect(transactions[1].metadata.type).toBe('expense');
	});

	it('ignore les entrées au statut PDNG (pending)', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			txPage([
				{
					entry_reference: 'ref-pending',
					booking_date: '2026-01-01',
					status: 'PDNG',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					creditor: { name: 'Marchand' }
				},
				{
					entry_reference: 'ref-booked',
					booking_date: '2026-01-02',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					creditor: { name: 'Marchand' }
				}
			])
		);
		const { connector } = makeConnector({ fetchImpl });

		const transactions = await connector.fetchTransactions(activeConnection, 'acc-1', {
			from: '2026-01-01',
			to: '2026-01-31'
		});

		expect(transactions).toHaveLength(1);
		expect(transactions[0].date).toBe('2026-01-02');
	});

	it('utilise booking_date, avec fallback sur value_date', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			txPage([
				{
					entry_reference: 'ref-fallback',
					value_date: '2026-01-05',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					creditor: { name: 'Marchand' }
				}
			])
		);
		const { connector } = makeConnector({ fetchImpl });

		const transactions = await connector.fetchTransactions(activeConnection, 'acc-1', {
			from: '2026-01-01',
			to: '2026-01-31'
		});

		expect(transactions[0].date).toBe('2026-01-05');
	});

	it('construit le label à partir de remittance_information, avec fallback sur le nom du tiers', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			txPage([
				{
					entry_reference: 'ref-a',
					booking_date: '2026-01-01',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					remittance_information: ['Paiement', 'CB'],
					creditor: { name: 'Marchand Fallback' }
				},
				{
					entry_reference: 'ref-b',
					booking_date: '2026-01-02',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					creditor: { name: 'Marchand Fallback' }
				},
				{
					entry_reference: 'ref-c',
					booking_date: '2026-01-03',
					status: 'BOOK',
					credit_debit_indicator: 'CRDT',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					debtor: { name: 'Debiteur Fallback' }
				}
			])
		);
		const { connector } = makeConnector({ fetchImpl });

		const transactions = await connector.fetchTransactions(activeConnection, 'acc-1', {
			from: '2026-01-01',
			to: '2026-01-31'
		});

		expect(transactions[0].label).toBe('Paiement CB');
		expect(transactions[1].label).toBe('Marchand Fallback');
		expect(transactions[2].label).toBe('Debiteur Fallback');
	});

	it('marque toujours category === UNCLASSIFIED_CATEGORY', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			txPage([
				{
					entry_reference: 'ref-a',
					booking_date: '2026-01-01',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					creditor: { name: 'Marchand' }
				}
			])
		);
		const { connector } = makeConnector({ fetchImpl });

		const transactions = await connector.fetchTransactions(activeConnection, 'acc-1', {
			from: '2026-01-01',
			to: '2026-01-31'
		});

		expect(transactions[0].category).toBe(UNCLASSIFIED_CATEGORY);
		expect(transactions[0].category).toBe('uncategorized');
	});

	it('utilise enablebanking:{accountId}:{entry_reference} comme deduplicationKey quand présent', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			txPage([
				{
					entry_reference: 'stable-ref',
					booking_date: '2026-01-01',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					creditor: { name: 'Marchand' }
				}
			])
		);
		const { connector } = makeConnector({ fetchImpl });

		const transactions = await connector.fetchTransactions(activeConnection, 'acc-1', {
			from: '2026-01-01',
			to: '2026-01-31'
		});

		// The connector no longer builds the key: it carries the provider's entry reference on
		// `metadata.reference`, and the write path turns that into the key, scoped by the bucket's
		// provider account. This asserts BOTH halves, because the connector dropping the reference
		// and the write path ignoring it fail the same way and only one of them is this file's.
		expect(transactions[0].metadata.reference).toBe('stable-ref');
		expect(assignDedupeKeysForBatch(transactions, EB_BUCKET)[0]).toBe(
			'v3|enablebanking|acc-1|stable-ref'
		);
	});

	it('construit une empreinte de contenu quand entry_reference est absent, distincte selon date/montant et sans le label brut en majuscules', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			txPage([
				{
					booking_date: '2026-01-01',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					remittance_information: ['ACHAT SUPERMARCHE']
				},
				{
					booking_date: '2026-01-02',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: '20.00' },
					remittance_information: ['ACHAT SUPERMARCHE']
				}
			])
		);
		const { connector } = makeConnector({ fetchImpl });

		const transactions = await connector.fetchTransactions(activeConnection, 'acc-1', {
			from: '2026-01-01',
			to: '2026-01-31'
		});

		const keys = assignDedupeKeysForBatch(transactions, EB_BUCKET);
		expect(keys[0]).not.toBe(keys[1]);
		// The raw uppercase label is not in the key: enablebanking folds through
		// `normalizeForMatch` before keying while storing the label as it came.
		expect(keys[0]).not.toContain('ACHAT SUPERMARCHE');
	});

	it('rejette un credit_debit_indicator inconnu', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			txPage([
				{
					entry_reference: 'ref-a',
					booking_date: '2026-01-01',
					status: 'BOOK',
					credit_debit_indicator: 'WEIRD',
					transaction_amount: { currency: 'EUR', amount: '10.00' },
					creditor: { name: 'Marchand' }
				}
			])
		);
		const { connector } = makeConnector({ fetchImpl });

		await expect(
			connector.fetchTransactions(activeConnection, 'acc-1', {
				from: '2026-01-01',
				to: '2026-01-31'
			})
		).rejects.toThrow('unknown credit/debit indicator');
	});

	it('rejette un montant non parsable', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			txPage([
				{
					entry_reference: 'ref-a',
					booking_date: '2026-01-01',
					status: 'BOOK',
					credit_debit_indicator: 'DBIT',
					transaction_amount: { currency: 'EUR', amount: 'not-a-number' },
					creditor: { name: 'Marchand' }
				}
			])
		);
		const { connector } = makeConnector({ fetchImpl });

		await expect(
			connector.fetchTransactions(activeConnection, 'acc-1', {
				from: '2026-01-01',
				to: '2026-01-31'
			})
		).rejects.toThrow('unparseable amount');
	});

	it('rejette une plage from > to sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({});
		await expect(
			connector.fetchTransactions(activeConnection, 'acc-1', {
				from: '2026-02-01',
				to: '2026-01-01'
			})
		).rejects.toThrow('Invalid date range');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rejette quand le consentement est expiré (au moment injecté), sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({
			now: () => new Date('2026-07-18T00:00:00.000Z')
		});
		const expiredConnection = {
			providerSessionId: 'sess-123',
			credentialsEncrypted: null,
			consentExpiresAt: new Date('2026-07-17T00:00:00.000Z')
		};
		await expect(
			connector.fetchTransactions(expiredConnection, 'acc-1', {
				from: '2026-01-01',
				to: '2026-01-31'
			})
		).rejects.toThrow('consent has expired');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('EnableBankingConnector — getConnectionStatus', () => {
	it('retourne "revoked" sans providerSessionId, sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({});
		const status = await connector.getConnectionStatus({
			providerSessionId: null,
			credentialsEncrypted: null,
			consentExpiresAt: null
		});
		expect(status).toBe('revoked');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('retourne "expired" quand le consentement est expiré localement, sans appeler fetch', async () => {
		const { connector, fetchImpl } = makeConnector({
			now: () => new Date('2026-07-18T00:00:00.000Z')
		});
		const status = await connector.getConnectionStatus({
			providerSessionId: 'sess-123',
			credentialsEncrypted: null,
			consentExpiresAt: new Date('2026-07-17T00:00:00.000Z')
		});
		expect(status).toBe('expired');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		['AUTHORIZED', 'active'],
		['EXPIRED', 'expired'],
		['REVOKED', 'revoked'],
		['CANCELLED', 'revoked'],
		['CLOSED', 'revoked'],
		['SOMETHING_UNKNOWN', 'error']
	])('mappe le statut API %s vers %s', async (apiStatus, expected) => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: apiStatus }));
		const { connector } = makeConnector({ fetchImpl });

		const status = await connector.getConnectionStatus({
			providerSessionId: 'sess-123',
			credentialsEncrypted: null,
			consentExpiresAt: null
		});
		expect(status).toBe(expected);
	});

	it('retourne "revoked" quand fetch renvoie 404', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 404));
		const { connector } = makeConnector({ fetchImpl });

		const status = await connector.getConnectionStatus({
			providerSessionId: 'sess-123',
			credentialsEncrypted: null,
			consentExpiresAt: null
		});
		expect(status).toBe('revoked');
	});

	it('retourne "error" quand fetch renvoie 500', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
		const { connector } = makeConnector({ fetchImpl });

		const status = await connector.getConnectionStatus({
			providerSessionId: 'sess-123',
			credentialsEncrypted: null,
			consentExpiresAt: null
		});
		expect(status).toBe('error');
	});
});

describe('EnableBankingConnector — fetchAccountBalance', () => {
	const activeConnection = {
		providerSessionId: 'sess-123',
		credentialsEncrypted: null,
		consentExpiresAt: null
	};

	it('picks CLBD among several balance_type entries', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				balances: [
					{
						balance_amount: { currency: 'EUR', amount: '100.00' },
						balance_type: 'XPCD',
						reference_date: '2026-07-17'
					},
					{
						balance_amount: { currency: 'EUR', amount: '150.50' },
						balance_type: 'CLBD',
						reference_date: '2026-07-18'
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const balance = await connector.fetchAccountBalance(activeConnection, 'acc-1', 'EUR');

		expect(balance).toEqual({
			balanceCents: 15050,
			currency: 'EUR',
			balanceType: 'CLBD',
			asOf: new Date('2026-07-18')
		});
	});

	it('excludes a currency mismatch and returns null when every entry mismatches', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				balances: [
					{
						balance_amount: { currency: 'USD', amount: '100.00' },
						balance_type: 'CLBD',
						reference_date: '2026-07-18'
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const balance = await connector.fetchAccountBalance(activeConnection, 'acc-1', 'EUR');

		expect(balance).toBeNull();
	});

	it('excludes a currency mismatch but falls back to a valid matching candidate', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				balances: [
					{
						balance_amount: { currency: 'USD', amount: '999.00' },
						balance_type: 'CLBD',
						reference_date: '2026-07-18'
					},
					{
						balance_amount: { currency: 'EUR', amount: '42.00' },
						balance_type: 'ITBD',
						reference_date: '2026-07-17'
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const balance = await connector.fetchAccountBalance(activeConnection, 'acc-1', 'EUR');

		expect(balance).toEqual({
			balanceCents: 4200,
			currency: 'EUR',
			balanceType: 'ITBD',
			asOf: new Date('2026-07-17')
		});
	});

	it('returns null when balances is an empty array', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ balances: [] }));
		const { connector } = makeConnector({ fetchImpl });

		const balance = await connector.fetchAccountBalance(activeConnection, 'acc-1', 'EUR');

		expect(balance).toBeNull();
	});

	it('excludes an unparseable balance_amount.amount, falling back to another valid candidate', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				balances: [
					{
						balance_amount: { currency: 'EUR', amount: 'not-a-number' },
						balance_type: 'CLBD',
						reference_date: '2026-07-18'
					},
					{
						balance_amount: { currency: 'EUR', amount: '75.00' },
						balance_type: 'ITBD',
						reference_date: '2026-07-17'
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const balance = await connector.fetchAccountBalance(activeConnection, 'acc-1', 'EUR');

		expect(balance).toEqual({
			balanceCents: 7500,
			currency: 'EUR',
			balanceType: 'ITBD',
			asOf: new Date('2026-07-17')
		});
	});

	it('returns null when the only candidate has an unparseable amount', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				balances: [
					{
						balance_amount: { currency: 'EUR', amount: 'garbage' },
						balance_type: 'CLBD',
						reference_date: '2026-07-18'
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const balance = await connector.fetchAccountBalance(activeConnection, 'acc-1', 'EUR');

		expect(balance).toBeNull();
	});

	it('populates asOf from reference_date when present', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				balances: [
					{
						balance_amount: { currency: 'EUR', amount: '10.00' },
						balance_type: 'CLBD',
						reference_date: '2026-07-18',
						last_change_date_time: '2026-07-15T10:00:00.000Z'
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const balance = await connector.fetchAccountBalance(activeConnection, 'acc-1', 'EUR');

		expect(balance?.asOf).toEqual(new Date('2026-07-18'));
	});

	it('falls back to last_change_date_time when reference_date is absent', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				balances: [
					{
						balance_amount: { currency: 'EUR', amount: '10.00' },
						balance_type: 'CLBD',
						last_change_date_time: '2026-07-15T10:00:00.000Z'
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const balance = await connector.fetchAccountBalance(activeConnection, 'acc-1', 'EUR');

		expect(balance?.asOf).toEqual(new Date('2026-07-15T10:00:00.000Z'));
	});

	it('leaves asOf null when neither reference_date nor last_change_date_time is present', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({
				balances: [
					{
						balance_amount: { currency: 'EUR', amount: '10.00' },
						balance_type: 'CLBD'
					}
				]
			})
		);
		const { connector } = makeConnector({ fetchImpl });

		const balance = await connector.fetchAccountBalance(activeConnection, 'acc-1', 'EUR');

		expect(balance?.asOf).toBeNull();
	});
});

describe('EnableBankingConnector — hygiène des erreurs', () => {
	it("le message d'erreur d'une réponse non-ok ne contient que le status et le code provider, jamais le corps brut", async () => {
		const sensitiveBody = {
			code: 'ASPSP_RATE_LIMIT_EXCEEDED',
			message: 'secret-iban-FR7612345 leaked details here',
			debug_password: 'super-secret-value'
		};
		const fetchImpl = vi
			.fn()
			.mockImplementation(() => Promise.resolve(jsonResponse(sensitiveBody, 400)));
		const { connector } = makeConnector({ fetchImpl });

		try {
			await connector.createConnection({
				redirectUrl: 'http://localhost/cb',
				aspsp: { name: 'Test Bank', country: 'FR' }
			});
			throw new Error('expected rejection');
		} catch (caught) {
			const message = (caught as Error).message;
			expect(message).toBe('Enable Banking API error (status 400)');
			expect(message).not.toContain('secret-iban-FR7612345');
			expect(message).not.toContain('super-secret-value');
			expect((caught as { providerCode?: string }).providerCode).toBe('ASPSP_RATE_LIMIT_EXCEEDED');
		}
	});
});
