import { randomUUID } from 'node:crypto';
import { constantTimeEquals } from '$lib/server/banking/constantTime';
import { isValidIsoDate } from '$lib/domain/transaction';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';
import type { ImportedTransaction, ImportedTransactionType } from '$lib/server/import/types';
import {
	buildDeduplicationGroupKey,
	buildDeduplicationKey,
	hashFingerprint,
	UNCLASSIFIED_CATEGORY
} from '$lib/server/import/utils/safety';
import { createOccurrenceCounter } from '$lib/server/import/occurrence';
import type {
	AuthorizationCallbackInput,
	BankAspsp,
	BankConnectionLifecycleStatus,
	BankConnector,
	BankConnectorAccount,
	ConnectionContext,
	CreateConnectionInput,
	EstablishedConnection,
	FetchedAccountBalance,
	FetchTransactionsRange,
	PendingAuthorization
} from './types';

const MOCK_CONSENT_DAYS = 180;

const accounts: BankConnectorAccount[] = [
	{ id: 'mock-checking', name: 'Compte courant (démo)', currency: 'EUR' },
	{ id: 'mock-savings', name: 'Livret (démo)', currency: 'EUR' }
];

/** Deterministic fictional balances, roughly consistent with MONTHLY_FLOWS' running totals. */
const MOCK_BALANCES: Record<string, { amountCents: number; currency: string }> = {
	'mock-checking': { amountCents: 182_540, currency: 'EUR' },
	'mock-savings': { amountCents: 15_000, currency: 'EUR' }
};

/**
 * Recurring monthly flows per account: realistic shapes (salary, rent, groceries,
 * transport, savings transfer) with clearly fictional labels. Deterministic: the same
 * range always yields the same transactions, so specs can assert exact contents.
 */
const MONTHLY_FLOWS: Record<string, Array<{ day: number; label: string; amountCents: number }>> = {
	'mock-checking': [
		{ day: 2, label: 'VIREMENT SALAIRE ACME DEMO', amountCents: 210_000 },
		{ day: 3, label: 'LOYER AGENCE FICTIVE DEMO', amountCents: -85_000 },
		{ day: 9, label: 'CB SUPERMARCHE DEMO', amountCents: -5_420 },
		{ day: 15, label: 'ABONNEMENT TRANSPORT DEMO', amountCents: -8_600 },
		{ day: 23, label: 'CB SUPERMARCHE DEMO', amountCents: -6_180 }
	],
	'mock-savings': [{ day: 5, label: 'VIREMENT EPARGNE DEMO', amountCents: 15_000 }]
};

/**
 * Second real implementation of the BankConnector contract (not a leftover stub):
 * exercises the full lifecycle — consent flow with anti-CSRF state, credential
 * encryption through server/crypto.ts, status derivation, ranged fetches — without
 * any network call. Used by specs and by a future demo mode.
 */
export class MockBankConnector implements BankConnector {
	readonly id = 'mock';
	readonly displayName = 'Banque de démonstration';

	async listBanks(country: string): Promise<BankAspsp[]> {
		return [{ name: 'Banque Fictive Démo', country }];
	}

	async createConnection(input: CreateConnectionInput): Promise<PendingAuthorization> {
		const state = randomUUID();
		// .invalid TLD (RFC 2606): guaranteed non-resolvable — nothing can ever call it.
		const authorizationUrl = new URL('https://bank.mock.invalid/authorize');
		authorizationUrl.searchParams.set('state', state);
		authorizationUrl.searchParams.set('redirect_uri', input.redirectUrl);
		return { authorizationUrl: authorizationUrl.toString(), state };
	}

	async completeAuthorization(input: AuthorizationCallbackInput): Promise<EstablishedConnection> {
		// Constant-time like the real connector (security review): the mock must never be
		// a structurally weaker path if a demo mode ever routes to it.
		if (!input.params.state || !constantTimeEquals(input.params.state, input.expectedState)) {
			throw new Error('Authorization state mismatch');
		}
		const code = input.params.code;
		if (!code) {
			throw new Error('Missing authorization code');
		}
		const consentExpiresAt = new Date(Date.now() + MOCK_CONSENT_DAYS * 24 * 60 * 60 * 1000);
		return {
			providerSessionId: `mock-session-${randomUUID()}`,
			credentialsEncrypted: encryptSecret(JSON.stringify({ authorizationCode: code })),
			consentExpiresAt
		};
	}

	async listAccounts(connection: ConnectionContext): Promise<BankConnectorAccount[]> {
		await this.assertActive(connection);
		return accounts;
	}

	async fetchTransactions(
		connection: ConnectionContext,
		accountId: string,
		range: FetchTransactionsRange
	): Promise<ImportedTransaction[]> {
		await this.assertActive(connection);
		if (!accounts.some((account) => account.id === accountId)) {
			throw new Error('Unknown mock account');
		}
		if (!isValidIsoDate(range.from) || !isValidIsoDate(range.to) || range.from > range.to) {
			throw new Error('Invalid date range');
		}

		const transactions: ImportedTransaction[] = [];
		// One counter per fetch. See occurrence.ts: sharing one across two fetches would number
		// the second fetch's rows as continuations of the first, so the same transaction would key
		// differently on the next sync and import again.
		const nextOccurrence = createOccurrenceCounter();
		for (const date of enumerateFlowDates(accountId, range)) {
			const flow = date.flow;
			const type: ImportedTransactionType = flow.amountCents >= 0 ? 'income' : 'expense';
			// `category` left the key in v2: it was the constant UNCLASSIFIED_CATEGORY here, so it
			// never distinguished anything, and on the CSV side it made the key depend on which
			// columns a file carried.
			const group = { date: date.iso, label: flow.label, amountCents: flow.amountCents, type };
			const fingerprint = buildDeduplicationKey({
				...group,
				occurrence: nextOccurrence(buildDeduplicationGroupKey(group)),
				accountScope: accountId
			});
			transactions.push({
				id: `mock-${hashFingerprint(fingerprint)}`,
				date: date.iso,
				label: flow.label,
				amountCents: flow.amountCents,
				// Never a pre-filled category: categorization belongs exclusively to the
				// rules pipeline (same constraint as the real connector and CSV profiles).
				category: UNCLASSIFIED_CATEGORY,
				source: 'mock_connector',
				metadata: {
					reference: '',
					notes: flow.label,
					type,
					deduplicationKey: fingerprint
				}
			});
		}
		return transactions;
	}

	async getConnectionStatus(connection: ConnectionContext): Promise<BankConnectionLifecycleStatus> {
		if (!connection.providerSessionId) return 'revoked';
		if (!connection.credentialsEncrypted) return 'error';
		try {
			decryptSecret(connection.credentialsEncrypted);
		} catch {
			return 'error';
		}
		if (connection.consentExpiresAt && connection.consentExpiresAt.getTime() <= Date.now()) {
			return 'expired';
		}
		return 'active';
	}

	/** Deterministic fictional balance, same currency-filter contract as the real connector. */
	async fetchAccountBalance(
		connection: ConnectionContext,
		accountId: string,
		accountCurrency: string
	): Promise<FetchedAccountBalance | null> {
		await this.assertActive(connection);
		const balance = MOCK_BALANCES[accountId];
		if (!balance || balance.currency !== accountCurrency) return null;
		return {
			balanceCents: balance.amountCents,
			currency: balance.currency,
			balanceType: 'CLBD',
			asOf: new Date()
		};
	}

	private async assertActive(connection: ConnectionContext): Promise<void> {
		const status = await this.getConnectionStatus(connection);
		if (status !== 'active') {
			throw new Error(`Connection is not active (status: ${status})`);
		}
	}
}

function enumerateFlowDates(
	accountId: string,
	range: FetchTransactionsRange
): Array<{ iso: string; flow: { day: number; label: string; amountCents: number } }> {
	const flows = MONTHLY_FLOWS[accountId] ?? [];
	const from = new Date(`${range.from}T00:00:00Z`);
	const to = new Date(`${range.to}T00:00:00Z`);
	const results: Array<{ iso: string; flow: (typeof flows)[number] }> = [];

	const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
	while (cursor.getTime() <= to.getTime()) {
		const daysInMonth = new Date(
			Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)
		).getUTCDate();
		for (const flow of flows) {
			if (flow.day > daysInMonth) continue;
			const occurrence = new Date(
				Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), flow.day)
			);
			if (occurrence.getTime() < from.getTime() || occurrence.getTime() > to.getTime()) continue;
			results.push({ iso: occurrence.toISOString().slice(0, 10), flow });
		}
		cursor.setUTCMonth(cursor.getUTCMonth() + 1);
	}

	results.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
	return results;
}
