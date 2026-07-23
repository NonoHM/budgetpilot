import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
});

const { MockBankConnector } = await import('./mock');
const { encryptSecret } = await import('$lib/server/crypto');

describe('MockBankConnector', () => {
	describe('createConnection / completeAuthorization', () => {
		it('crée une autorisation en attente avec une URL mock et un state aléatoire', async () => {
			const connector = new MockBankConnector();
			const pending = await connector.createConnection({
				redirectUrl: 'http://localhost:5173/banking/callback'
			});

			expect(pending.authorizationUrl).toMatch(/^https:\/\/bank\.mock\.invalid\/authorize\?/);
			const url = new URL(pending.authorizationUrl);
			expect(url.searchParams.get('state')).toBe(pending.state);
			expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/banking/callback');
			expect(pending.state).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
			);
		});

		it('génère un state différent à chaque appel', async () => {
			const connector = new MockBankConnector();
			const first = await connector.createConnection({ redirectUrl: 'http://localhost/cb' });
			const second = await connector.createConnection({ redirectUrl: 'http://localhost/cb' });
			expect(first.state).not.toBe(second.state);
		});

		it('complète une autorisation valide en échouant le state fourni et en chiffrant le code', async () => {
			const connector = new MockBankConnector();
			const pending = await connector.createConnection({ redirectUrl: 'http://localhost/cb' });

			const established = await connector.completeAuthorization({
				params: { state: pending.state, code: 'auth-code-123' },
				expectedState: pending.state
			});

			expect(established.providerSessionId).toMatch(/^mock-session-/);
			expect(established.credentialsEncrypted).not.toBeNull();
			expect(established.credentialsEncrypted).not.toContain('auth-code-123');
			expect(established.consentExpiresAt).toBeInstanceOf(Date);
			const daysAhead =
				((established.consentExpiresAt as Date).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
			expect(daysAhead).toBeGreaterThan(179);
			expect(daysAhead).toBeLessThan(181);
		});

		it('rejette un state absent dans les params du callback', async () => {
			const connector = new MockBankConnector();
			await expect(
				connector.completeAuthorization({
					params: { code: 'auth-code-123' },
					expectedState: 'some-state'
				})
			).rejects.toThrow('Authorization state mismatch');
		});

		it('rejette un state différent de celui attendu', async () => {
			const connector = new MockBankConnector();
			await expect(
				connector.completeAuthorization({
					params: { state: 'wrong-state', code: 'auth-code-123' },
					expectedState: 'expected-state'
				})
			).rejects.toThrow('Authorization state mismatch');
		});

		it('rejette un code d’autorisation manquant', async () => {
			const connector = new MockBankConnector();
			const pending = await connector.createConnection({ redirectUrl: 'http://localhost/cb' });
			await expect(
				connector.completeAuthorization({
					params: { state: pending.state },
					expectedState: pending.state
				})
			).rejects.toThrow('Missing authorization code');
		});
	});

	describe('getConnectionStatus', () => {
		it('retourne "revoked" quand providerSessionId est absent', async () => {
			const connector = new MockBankConnector();
			const status = await connector.getConnectionStatus({
				providerSessionId: null,
				credentialsEncrypted: encryptSecret('{}'),
				consentExpiresAt: new Date(Date.now() + 1000)
			});
			expect(status).toBe('revoked');
		});

		it('retourne "error" quand credentialsEncrypted est absent', async () => {
			const connector = new MockBankConnector();
			const status = await connector.getConnectionStatus({
				providerSessionId: 'mock-session-x',
				credentialsEncrypted: null,
				consentExpiresAt: new Date(Date.now() + 1000)
			});
			expect(status).toBe('error');
		});

		it('retourne "error" quand credentialsEncrypted est indéchiffrable (corrompu)', async () => {
			const connector = new MockBankConnector();
			const status = await connector.getConnectionStatus({
				providerSessionId: 'mock-session-x',
				credentialsEncrypted: 'not-a-valid-encrypted-secret',
				consentExpiresAt: new Date(Date.now() + 1000)
			});
			expect(status).toBe('error');
		});

		it('retourne "expired" quand consentExpiresAt est dans le passé', async () => {
			const connector = new MockBankConnector();
			const status = await connector.getConnectionStatus({
				providerSessionId: 'mock-session-x',
				credentialsEncrypted: encryptSecret('{}'),
				consentExpiresAt: new Date(Date.now() - 1000)
			});
			expect(status).toBe('expired');
		});

		it('retourne "active" quand tout est valide et le consentement non expiré', async () => {
			const connector = new MockBankConnector();
			const status = await connector.getConnectionStatus({
				providerSessionId: 'mock-session-x',
				credentialsEncrypted: encryptSecret('{}'),
				consentExpiresAt: new Date(Date.now() + 1000)
			});
			expect(status).toBe('active');
		});

		it('retourne "active" quand consentExpiresAt est null (pas de contrainte d’expiration)', async () => {
			const connector = new MockBankConnector();
			const status = await connector.getConnectionStatus({
				providerSessionId: 'mock-session-x',
				credentialsEncrypted: encryptSecret('{}'),
				consentExpiresAt: null
			});
			expect(status).toBe('active');
		});
	});

	describe('listAccounts / fetchTransactions — connexion inactive', () => {
		const inactiveConnection = {
			providerSessionId: null,
			credentialsEncrypted: null,
			consentExpiresAt: null
		};

		it('refuse listAccounts sur une connexion non active', async () => {
			const connector = new MockBankConnector();
			await expect(connector.listAccounts(inactiveConnection)).rejects.toThrow(
				'Connection is not active (status: revoked)'
			);
		});

		it('refuse fetchTransactions sur une connexion non active', async () => {
			const connector = new MockBankConnector();
			await expect(
				connector.fetchTransactions(inactiveConnection, 'mock-checking', {
					from: '2026-01-01',
					to: '2026-01-31'
				})
			).rejects.toThrow('Connection is not active (status: revoked)');
		});
	});

	describe('lifecycle complet + fetchTransactions', () => {
		async function establishActiveConnection() {
			const connector = new MockBankConnector();
			const pending = await connector.createConnection({ redirectUrl: 'http://localhost/cb' });
			const established = await connector.completeAuthorization({
				params: { state: pending.state, code: 'auth-code-abc' },
				expectedState: pending.state
			});
			return { connector, connection: established };
		}

		it('parcourt le cycle complet createConnection -> completeAuthorization -> getConnectionStatus actif -> listAccounts', async () => {
			const { connector, connection } = await establishActiveConnection();

			const status = await connector.getConnectionStatus(connection);
			expect(status).toBe('active');

			const accounts = await connector.listAccounts(connection);
			expect(accounts).toEqual([
				{ id: 'mock-checking', name: 'Compte courant (démo)', currency: 'EUR' },
				{ id: 'mock-savings', name: 'Livret (démo)', currency: 'EUR' }
			]);
		});

		it('récupère des transactions déterministes sur une plage de 2 mois, triées par date croissante, toutes non catégorisées', async () => {
			const { connector, connection } = await establishActiveConnection();

			const transactions = await connector.fetchTransactions(connection, 'mock-checking', {
				from: '2026-01-01',
				to: '2026-02-28'
			});

			// 5 flows/month x 2 months
			expect(transactions).toHaveLength(10);
			expect(transactions.every((tx) => tx.category === 'uncategorized')).toBe(true);
			expect(transactions.every((tx) => tx.source === 'mock_connector')).toBe(true);

			const dates = transactions.map((tx) => tx.date);
			const sortedDates = [...dates].sort();
			expect(dates).toEqual(sortedDates);
		});

		it('produit des identifiants et deduplicationKey stables entre deux fetch identiques', async () => {
			const { connector, connection } = await establishActiveConnection();
			const range = { from: '2026-01-01', to: '2026-01-31' };

			const first = await connector.fetchTransactions(connection, 'mock-checking', range);
			const second = await connector.fetchTransactions(connection, 'mock-checking', range);

			expect(first.map((tx) => tx.id)).toEqual(second.map((tx) => tx.id));
			expect(first.map((tx) => tx.metadata.deduplicationKey)).toEqual(
				second.map((tx) => tx.metadata.deduplicationKey)
			);
		});

		it('retourne le flux d’épargne mensuel unique pour le compte livret', async () => {
			const { connector, connection } = await establishActiveConnection();
			const transactions = await connector.fetchTransactions(connection, 'mock-savings', {
				from: '2026-01-01',
				to: '2026-01-31'
			});

			expect(transactions).toHaveLength(1);
			expect(transactions[0]).toMatchObject({
				date: '2026-01-05',
				amountCents: 15_000,
				category: 'uncategorized',
				source: 'mock_connector'
			});
			expect(transactions[0].metadata).toMatchObject({
				reference: '',
				notes: transactions[0].label,
				type: 'income'
			});
		});

		it('rejette un identifiant de compte inconnu', async () => {
			const { connector, connection } = await establishActiveConnection();
			await expect(
				connector.fetchTransactions(connection, 'mock-unknown', {
					from: '2026-01-01',
					to: '2026-01-31'
				})
			).rejects.toThrow('Unknown mock account');
		});

		it('rejette une plage de dates invalide (from > to)', async () => {
			const { connector, connection } = await establishActiveConnection();
			await expect(
				connector.fetchTransactions(connection, 'mock-checking', {
					from: '2026-02-01',
					to: '2026-01-01'
				})
			).rejects.toThrow('Invalid date range');
		});

		it('rejette une plage de dates avec une date ISO malformée', async () => {
			const { connector, connection } = await establishActiveConnection();
			await expect(
				connector.fetchTransactions(connection, 'mock-checking', {
					from: 'not-a-date',
					to: '2026-01-31'
				})
			).rejects.toThrow('Invalid date range');
		});

		it('ne plante pas sur une plage incluant le 31 d’un mois de 30 jours (avril)', async () => {
			const { connector, connection } = await establishActiveConnection();
			const transactions = await connector.fetchTransactions(connection, 'mock-checking', {
				from: '2026-04-01',
				to: '2026-04-30'
			});
			// avril = 30 jours: les 5 flux tombent tous avant le 31, aucun crash, 5 lignes
			expect(transactions).toHaveLength(5);
		});

		it('retourne exactement le flux du jour pour une plage d’un seul jour', async () => {
			const { connector, connection } = await establishActiveConnection();
			const transactions = await connector.fetchTransactions(connection, 'mock-checking', {
				from: '2026-01-09',
				to: '2026-01-09'
			});
			expect(transactions).toHaveLength(1);
			expect(transactions[0]).toMatchObject({ date: '2026-01-09', amountCents: -5_420 });
		});

		it('ne laisse fuiter aucun secret ni le code d’autorisation en clair dans les sorties', async () => {
			const { connector, connection } = await establishActiveConnection();
			const accounts = await connector.listAccounts(connection);
			const transactions = await connector.fetchTransactions(connection, 'mock-checking', {
				from: '2026-01-01',
				to: '2026-01-31'
			});

			const serialized = JSON.stringify({ accounts, transactions });
			expect(serialized).not.toMatch(/password|secret|iban|login/i);
			expect(serialized).not.toContain('auth-code-abc');
		});

		describe('fetchAccountBalance', () => {
			it('returns the deterministic static balance for a known account id and matching currency', async () => {
				const { connector, connection } = await establishActiveConnection();
				const balance = await connector.fetchAccountBalance(connection, 'mock-checking', 'EUR');
				expect(balance).toMatchObject({
					balanceCents: 182_540,
					currency: 'EUR',
					balanceType: 'CLBD'
				});
				expect(balance?.asOf).toBeInstanceOf(Date);
			});

			it('returns null for an unknown account id', async () => {
				const { connector, connection } = await establishActiveConnection();
				const balance = await connector.fetchAccountBalance(connection, 'mock-unknown', 'EUR');
				expect(balance).toBeNull();
			});

			it('returns null on a currency mismatch', async () => {
				const { connector, connection } = await establishActiveConnection();
				const balance = await connector.fetchAccountBalance(connection, 'mock-checking', 'USD');
				expect(balance).toBeNull();
			});

			it('rejects fetchAccountBalance on a non-active connection', async () => {
				const connector = new MockBankConnector();
				const inactiveConnection = {
					providerSessionId: null,
					credentialsEncrypted: null,
					consentExpiresAt: null
				};
				await expect(
					connector.fetchAccountBalance(inactiveConnection, 'mock-checking', 'EUR')
				).rejects.toThrow('Connection is not active (status: revoked)');
			});
		});
	});
});
