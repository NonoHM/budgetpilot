import type { ImportedTransaction } from '$lib/server/import/types';

/**
 * Bank connector contract — the thin abstract interface validated during the bank-sync
 * exploration. A connector is a pure protocol adapter for one aggregator: it never
 * touches Prisma (persistence of what it returns belongs to the sync service, step 4)
 * and never applies categorization (transactions always come back with the
 * UNCLASSIFIED_CATEGORY sentinel — rules run exclusively in the shared import
 * pipeline, same convention as CSV profiles).
 *
 * Implementations: MockBankConnector (tests + demo mode, no network at all) and the
 * Enable Banking connector (stub until step 4). Any real network call must be gated on
 * isBankSyncEnabled() and validated via getBankProviderBaseUrl() (server/banking/config.ts).
 *
 * Contract invariants (security-reviewed; binding on every implementation AND caller):
 * - No method ever returns decrypted credentials — decryption stays internal to the
 *   connector (getConnectionStatus models this). Do not add a getCredentials()-style method.
 * - The step-4 sync service must persist PendingAuthorization.state server-side, bound to
 *   the initiating user's session (expectedState is NEVER read from client input), single-use
 *   (consumed on first completeAuthorization) and with a TTL; the real state comparison
 *   should be constant-time.
 * - redirectUrl must be validated server-side against an allowlist (same posture as
 *   BANK_SYNC_ALLOWED_HOSTS) — never rely solely on provider-side registration.
 */

/** Mirrors Prisma's BankConnectionStatus enum (kept literal to avoid coupling the contract to Prisma). */
export type BankConnectionLifecycleStatus = 'active' | 'expired' | 'revoked' | 'error';

/** A selectable bank in the provider's own list — the only valid source for CreateConnectionInput.aspsp. */
export interface BankAspsp {
	name: string;
	country: string;
}

/** Provider-side account, as listed under an authorized connection. */
export interface BankConnectorAccount {
	/** Provider-side account identifier — opaque, never displayed raw to the user. */
	id: string;
	name: string;
	currency: string;
	/**
	 * Provider-side cash account type (e.g. Enable Banking's CACC/SVGS/CARD/LOAN/CASH/OTHR)
	 * when the connector exposes it — opaque non-sensitive metadata persisted on the bucket
	 * to feed a NetWorthAccount TYPE suggestion at explicit-link time, never authoritative.
	 * Absent/null for connectors that don't have the concept (mock).
	 */
	cashAccountType?: string | null;
	/**
	 * Whether the provider reported a credit limit on this account — used only to break the
	 * CARD checking-vs-credit ambiguity in the type suggestion (domain/netWorth.ts's
	 * suggestNetWorthAccountType); never the limit amount itself.
	 */
	hasCreditLimit?: boolean;
}

export interface CreateConnectionInput {
	/**
	 * URL the provider redirects the user back to after bank-side authorization.
	 * Registered/whitelisted on the provider side; the browser performs the redirect,
	 * so a localhost/LAN URL works behind NAT (no public URL required).
	 */
	redirectUrl: string;
	/**
	 * Bank (ASPSP) the user wants to connect, when the provider requires selecting it
	 * before authorization (Enable Banking does; the mock ignores it). The sync service
	 * sources this from a provider-supplied bank list, never from free-text input.
	 */
	aspsp?: { name: string; country: string };
}

/** Result of initiating the consent flow: where to send the user, and the anti-CSRF state to keep. */
export interface PendingAuthorization {
	authorizationUrl: string;
	/** Random single-use value; must match the callback's `state` param (anti-CSRF). */
	state: string;
}

export interface AuthorizationCallbackInput {
	/**
	 * Query params the provider appended to the redirect URL. Treat as SECRET material:
	 * the authorization `code` is a credential — never log these params and never
	 * interpolate them into thrown-error messages.
	 */
	params: Record<string, string>;
	/** The `state` issued by createConnection, echoed back for verification. */
	expectedState: string;
}

/**
 * What the sync service persists into a BankConnection row once authorization completes.
 * `credentialsEncrypted` is produced by the connector itself via server/crypto.ts
 * (the credential shape is provider-specific, so serialization + encryption happen
 * here) — it must NEVER exist in plaintext outside the connector.
 */
export interface EstablishedConnection {
	providerSessionId: string;
	credentialsEncrypted: string | null;
	consentExpiresAt: Date | null;
	/**
	 * Accounts captured at authorization time, when the provider returns them richer
	 * there than on later lookups (Enable Banking's POST /sessions returns full account
	 * resources while GET /sessions/{id} only returns bare uids). Optional: connectors
	 * without that asymmetry can omit it and rely on listAccounts().
	 */
	accounts?: BankConnectorAccount[];
}

/**
 * Runtime view of a stored BankConnection row, as loaded by the sync service.
 * Deliberately a plain shape (not the Prisma type): connectors stay testable without a DB.
 */
export interface ConnectionContext {
	providerSessionId: string | null;
	credentialsEncrypted: string | null;
	consentExpiresAt: Date | null;
}

export interface FetchTransactionsRange {
	/** ISO date (YYYY-MM-DD), inclusive. */
	from: string;
	/** ISO date (YYYY-MM-DD), inclusive. */
	to: string;
}

/**
 * A provider balance, already narrowed to the single one the connector treats as
 * authoritative (see domain/bankBalance.ts's selectPreferredBalance/D3). The balance comes
 * directly from the bank — never derived from the app's own transaction history (that idea
 * was explored and explicitly dropped, see CLAUDE.md).
 */
export interface FetchedAccountBalance {
	balanceCents: number;
	currency: string;
	/** Raw provider balance_type/status code (e.g. CLBD/ITBD/XPCD) — informational only. */
	balanceType: string;
	/** reference_date / last_change_date_time when the provider supplies one; null otherwise. */
	asOf: Date | null;
}

export interface BankConnector {
	/** Stable connector identifier, stored in BankConnection.provider (e.g. "enablebanking", "mock"). */
	readonly id: string;
	readonly displayName: string;

	/**
	 * Provider-supplied bank list for a country (ISO 3166-1 alpha-2). Optional: only
	 * providers requiring pre-auth bank selection implement it. The sync service MUST
	 * validate any user-picked bank against this list — never accept free-text input.
	 */
	listBanks?(country: string): Promise<BankAspsp[]>;

	/** Initiates the consent flow: provider-side session creation + authorization URL. */
	createConnection(input: CreateConnectionInput): Promise<PendingAuthorization>;

	/**
	 * Finalizes the flow after the user is redirected back. Verifies `state`, exchanges
	 * the callback for a provider session, and returns what to persist (credentials
	 * already encrypted). Throws on state mismatch or provider rejection.
	 */
	completeAuthorization(input: AuthorizationCallbackInput): Promise<EstablishedConnection>;

	listAccounts(connection: ConnectionContext): Promise<BankConnectorAccount[]>;

	/**
	 * Fetches the account's transactions within the range, as ImportedTransaction[] —
	 * the same convergence type the CSV profiles produce, so the shared import
	 * persistence (dedup via metadata.deduplicationKey, rule application, ImportBatch)
	 * absorbs both sources identically. `category` is always the UNCLASSIFIED_CATEGORY
	 * sentinel: categorization is the rules pipeline's job, never the source's.
	 */
	fetchTransactions(
		connection: ConnectionContext,
		accountId: string,
		range: FetchTransactionsRange
	): Promise<ImportedTransaction[]>;

	/** Derives the connection's lifecycle status (consent expiry, provider-side revocation, ...). */
	getConnectionStatus(connection: ConnectionContext): Promise<BankConnectionLifecycleStatus>;

	/**
	 * Fetches the account's current balance, when the provider exposes one and the connector
	 * supports it. Optional: connectors without a balance concept simply omit it. Returns
	 * null for a normal, non-error "no usable balance" outcome (empty response, or nothing
	 * survives the currency filter/selection) — DISTINCT from a thrown error (network/provider
	 * failure). The caller (sync service) must treat both null and a thrown error as "skip
	 * this sync's balance enrichment" — a balance-fetch problem must NEVER block or fail the
	 * transaction sync it rides along with.
	 */
	fetchAccountBalance?(
		connection: ConnectionContext,
		accountId: string,
		/** The bucket's own Account.currency — used to discard foreign-currency sub-balances. */
		accountCurrency: string
	): Promise<FetchedAccountBalance | null>;
}
