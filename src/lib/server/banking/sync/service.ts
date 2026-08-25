import { DEFAULT_EXPONENT } from '$lib/domain/money';
import { createHash } from 'node:crypto';
import { prisma } from '$lib/server/db';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';
import { getBankSyncRedirectUrl, isBankSyncEnabled } from '$lib/server/banking/config';
import { getBankConnector } from '$lib/server/banking/connectors/registry';
import { EnableBankingApiError } from '$lib/server/banking/enablebanking/http';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from '$lib/server/import/persist';
import { recordSyncedBalance } from '$lib/server/net-worth/service';
import type { TransactionSource } from '$lib/domain/transaction';
import type {
	BankAspsp,
	BankConnector,
	ConnectionContext
} from '$lib/server/banking/connectors/types';

/**
 * Bank-sync orchestration: the ONLY layer that persists BankConnection /
 * BankAuthorizationRequest rows and bridges connectors to the shared import
 * persistence (persist.ts — never re-inlined here, per the architecture posture).
 *
 * Security invariants honored here (contract in connectors/types.ts):
 * - every entry point takes an explicit userId from requireUser, never client input;
 * - the anti-CSRF state is server-persisted, bound to the initiating user, single-use
 *   (consumed transactionally) and TTL'd; stored hashed (lookup) + encrypted at rest
 *   (so the connector's constant-time compare runs against the genuine stored value);
 * - redirectUrl is validated against BANK_SYNC_REDIRECT_ALLOWED_ORIGINS server-side
 *   (getBankSyncRedirectUrl), never trusted from provider-side registration alone;
 * - the bank (ASPSP) is validated against the provider-supplied list, never free-text;
 * - callback params (code/state) are never logged and never interpolated into errors;
 * - lastSyncError only ever stores a sanitized machine summary (HTTP status + provider
 *   code), never a raw provider message/body, and is never returned to callers.
 */

/** TTL of a pending consent flow — bank-side SCA can be slow, but the state must not live long. */
const AUTH_REQUEST_TTL_MS = 30 * 60 * 1000;
/** Unattended-call budget: ~4 syncs/day (PSD2 posture), bypassable when the user explicitly asks. */
const SYNC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** First sync backfill window; later syncs re-fetch a small overlap (dedup absorbs it). */
const FIRST_SYNC_LOOKBACK_DAYS = 90;
const RESYNC_OVERLAP_DAYS = 7;
const MAX_FIRST_SYNC_LOOKBACK_DAYS = 3650;

/**
 * First-sync backfill window in days. BANK_SYNC_FIRST_LOOKBACK_DAYS overrides the
 * 90-day default (bounded 1..3650) — meant for sandbox/dev datasets frozen in the past
 * (Enable Banking's Mock ASPSP serves 2020-2021 bookings), not for production tuning:
 * the range only widens ONE historical fetch and never touches the 6h unattended-call
 * throttle, so the PSD2 budget is unaffected.
 */
function getFirstSyncLookbackDays(env: NodeJS.ProcessEnv): number {
	const parsed = Number.parseInt(env.BANK_SYNC_FIRST_LOOKBACK_DAYS ?? '', 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_FIRST_SYNC_LOOKBACK_DAYS) {
		return FIRST_SYNC_LOOKBACK_DAYS;
	}
	return parsed;
}
const LAST_SYNC_ERROR_MAX_LENGTH = 200;

export type BankSyncErrorCode =
	| 'disabled'
	| 'redirect_not_allowed'
	| 'unknown_provider'
	| 'unknown_bank'
	| 'invalid_state'
	| 'authorization_failed'
	| 'not_found';

/** Typed failure with a machine code only — routes map codes to i18n messages. */
export class BankSyncError extends Error {
	constructor(public readonly code: BankSyncErrorCode) {
		super(`Bank sync error: ${code}`);
		this.name = 'BankSyncError';
	}
}

export interface BankSyncOptions {
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
	/** Injectable for tests; defaults to the real connector registry. */
	getConnector?: (provider: string) => BankConnector | null;
}

function resolveOptions(options: BankSyncOptions) {
	const env = options.env ?? process.env;
	return {
		env,
		now: options.now ?? (() => new Date()),
		// Thread the resolved env into the default registry so a connector never silently
		// falls back to a different env than the one this call was configured with.
		getConnector:
			options.getConnector ?? ((provider: string) => getBankConnector(provider, { env }))
	};
}

function requireConnector(
	getConnector: (provider: string) => BankConnector | null,
	provider: string
): BankConnector {
	const connector = getConnector(provider);
	if (!connector) throw new BankSyncError('unknown_provider');
	return connector;
}

function hashState(state: string): string {
	return createHash('sha256').update(state).digest('hex');
}

/**
 * Transaction/bucket source for a provider. The mock connector predates bank sync and
 * emits 'mock_connector' (already in the TransactionSource union) — keep it aligned.
 */
function resolveTransactionSource(provider: string): TransactionSource {
	return provider === 'mock' ? 'mock_connector' : (provider as TransactionSource);
}

function toIsoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** Provider-supplied bank list for the connect form — never used as free text. */
export async function listBankAspsps(
	provider: string,
	country: string,
	options: BankSyncOptions = {}
): Promise<BankAspsp[]> {
	const { env, getConnector } = resolveOptions(options);
	if (!isBankSyncEnabled(env)) throw new BankSyncError('disabled');
	const connector = requireConnector(getConnector, provider);
	if (!connector.listBanks) return [];
	return await connector.listBanks(country);
}

export interface StartBankAuthorizationInput {
	userId: string;
	provider: string;
	aspspName: string;
	aspspCountry: string;
	/** Origin of the incoming request — validated against the redirect allowlist. */
	origin: string;
	/**
	 * Renewal mode: re-consent an EXISTING connection (renew/reconnect actions). The
	 * bank is taken from the stored connection — client-supplied aspsp fields are
	 * ignored — and the callback updates that connection instead of creating one.
	 */
	renewConnectionId?: string;
}

export async function startBankAuthorization(
	input: StartBankAuthorizationInput,
	options: BankSyncOptions = {}
): Promise<{ authorizationUrl: string }> {
	const { env, now, getConnector } = resolveOptions(options);
	if (!isBankSyncEnabled(env)) throw new BankSyncError('disabled');

	const redirectUrl = getBankSyncRedirectUrl(input.origin, env);
	if (!redirectUrl) throw new BankSyncError('redirect_not_allowed');

	const connector = requireConnector(getConnector, input.provider);

	// Renewal: the target must be this user's connection on this provider, and the bank
	// comes from the stored record — never from client input.
	let aspspName = input.aspspName;
	let aspspCountry = input.aspspCountry;
	if (input.renewConnectionId) {
		const existing = await prisma.bankConnection.findFirst({
			where: { id: input.renewConnectionId, userId: input.userId, provider: input.provider },
			select: { aspspName: true, aspspCountry: true }
		});
		if (!existing?.aspspName || !existing.aspspCountry) throw new BankSyncError('not_found');
		aspspName = existing.aspspName;
		aspspCountry = existing.aspspCountry;
	}

	// The picked bank must exist in the provider's own list (exact name + country match).
	let aspsp: BankAspsp | undefined;
	if (connector.listBanks) {
		const banks = await connector.listBanks(aspspCountry);
		aspsp = banks.find((bank) => bank.name === aspspName && bank.country === aspspCountry);
		if (!aspsp) throw new BankSyncError('unknown_bank');
	}

	const pending = await connector.createConnection({ redirectUrl, aspsp });

	const currentTime = now();
	// Opportunistic cleanup of this user's dead flows — keeps the table from accumulating.
	await prisma.bankAuthorizationRequest.deleteMany({
		where: { userId: input.userId, expiresAt: { lt: currentTime } }
	});
	await prisma.bankAuthorizationRequest.create({
		data: {
			userId: input.userId,
			provider: input.provider,
			stateHash: hashState(pending.state),
			stateEncrypted: encryptSecret(pending.state),
			aspspName,
			aspspCountry,
			renewsConnectionId: input.renewConnectionId ?? null,
			expiresAt: new Date(currentTime.getTime() + AUTH_REQUEST_TTL_MS)
		}
	});

	return { authorizationUrl: pending.authorizationUrl };
}

export interface CompleteBankAuthorizationInput {
	userId: string;
	/** Raw callback query params (code/state) — SECRET material, never logged. */
	params: Record<string, string>;
}

export async function completeBankAuthorization(
	input: CompleteBankAuthorizationInput,
	options: BankSyncOptions = {}
): Promise<{ connectionId: string; accountCount: number }> {
	const { env, now, getConnector } = resolveOptions(options);
	if (!isBankSyncEnabled(env)) throw new BankSyncError('disabled');

	const state = input.params.state;
	if (!state) throw new BankSyncError('invalid_state');

	const request = await prisma.bankAuthorizationRequest.findUnique({
		where: { stateHash: hashState(state) }
	});
	// Bound to the initiating user: a state issued for another account is invalid here.
	if (!request || request.userId !== input.userId) throw new BankSyncError('invalid_state');

	const currentTime = now();
	if (request.expiresAt.getTime() <= currentTime.getTime()) {
		throw new BankSyncError('invalid_state');
	}

	// Single-use: the guarded update consumes the row exactly once, even under a
	// concurrent replay of the same callback.
	const consumed = await prisma.bankAuthorizationRequest.updateMany({
		where: { id: request.id, consumedAt: null },
		data: { consumedAt: currentTime }
	});
	if (consumed.count !== 1) throw new BankSyncError('invalid_state');

	const connector = requireConnector(getConnector, request.provider);

	let established;
	try {
		established = await connector.completeAuthorization({
			params: input.params,
			expectedState: decryptSecret(request.stateEncrypted)
		});
	} catch {
		// Never propagate the connector's error (params-adjacent context): machine code only.
		throw new BankSyncError('authorization_failed');
	}

	let connectionId: string | null = null;
	if (request.renewsConnectionId) {
		// Renewal: refresh the existing connection in place. lastSyncAt is kept (throttle
		// and overlap window stay honest); stale error state is cleared.
		const renewed = await prisma.bankConnection.updateMany({
			where: { id: request.renewsConnectionId, userId: input.userId, provider: request.provider },
			data: {
				providerSessionId: established.providerSessionId,
				credentialsEncrypted: established.credentialsEncrypted,
				status: 'active',
				consentExpiresAt: established.consentExpiresAt,
				lastSyncStatus: null,
				lastSyncError: null
			}
		});
		if (renewed.count === 1) connectionId = request.renewsConnectionId;
		// Target deleted meanwhile: fall through to creation — the consent is not wasted.
	}
	if (!connectionId) {
		const connection = await prisma.bankConnection.create({
			data: {
				userId: input.userId,
				provider: request.provider,
				providerSessionId: established.providerSessionId,
				credentialsEncrypted: established.credentialsEncrypted,
				status: 'active',
				aspspName: request.aspspName,
				aspspCountry: request.aspspCountry,
				consentExpiresAt: established.consentExpiresAt
			},
			select: { id: true }
		});
		connectionId = connection.id;
	}

	const source = resolveTransactionSource(request.provider);
	const accounts = established.accounts ?? [];
	for (const account of accounts) {
		await resolveImportBucketAccount({
			userId: input.userId,
			name: account.name,
			source,
			// The provider names a currency and never an exponent, so the exponent is stated HERE
			// rather than defaulted inside `resolveImportBucketAccount`: this is the one line where
			// somebody can see that a JOD account would be stamped as if it had two decimals, and
			// it is greppable. Correcting it needs a validated code list, which is the next piece;
			// until then the assumption is visible instead of buried.
			denomination: { currency: account.currency, exponent: DEFAULT_EXPONENT },
			bankConnectionId: connectionId,
			providerAccountId: account.id,
			providerCashAccountType: account.cashAccountType ?? null
		});
	}

	return { connectionId, accountCount: accounts.length };
}

/** One bank-sync bucket's net worth link status, for the explicit-link UI on /imports/bank-connections. */
export interface BankConnectionAccountSummary {
	id: string;
	name: string;
	netWorthAccountId: string | null;
	netWorthAccountName: string | null;
	/** Feeds suggestNetWorthAccountType() at link time — never authoritative. */
	providerCashAccountType: string | null;
}

export interface BankConnectionSummary {
	id: string;
	provider: string;
	aspspName: string | null;
	status: 'active' | 'expired' | 'revoked' | 'error';
	consentExpiresAt: string | null;
	lastSyncAt: string | null;
	lastSyncStatus: string | null;
	/** When the 6h sync throttle reopens — lets the UI disable the button instead of 429ing. */
	syncAvailableAt: string | null;
	accountCount: number;
	accounts: BankConnectionAccountSummary[];
	createdAt: string;
}

/**
 * Client-safe view of a user's connections. providerSessionId, credentialsEncrypted
 * and lastSyncError deliberately never leave the server.
 */
export async function listUserBankConnections(userId: string): Promise<BankConnectionSummary[]> {
	const connections = await prisma.bankConnection.findMany({
		where: { userId },
		orderBy: { createdAt: 'desc' },
		select: {
			id: true,
			provider: true,
			aspspName: true,
			status: true,
			consentExpiresAt: true,
			lastSyncAt: true,
			lastSyncStatus: true,
			createdAt: true,
			accounts: {
				select: {
					id: true,
					name: true,
					netWorthAccountId: true,
					providerCashAccountType: true,
					netWorthAccount: { select: { name: true } }
				}
			}
		}
	});
	return connections.map((connection) => ({
		id: connection.id,
		provider: connection.provider,
		aspspName: connection.aspspName,
		status: connection.status,
		consentExpiresAt: connection.consentExpiresAt?.toISOString() ?? null,
		lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
		lastSyncStatus: connection.lastSyncStatus,
		syncAvailableAt: connection.lastSyncAt
			? new Date(connection.lastSyncAt.getTime() + SYNC_MIN_INTERVAL_MS).toISOString()
			: null,
		accountCount: connection.accounts.length,
		accounts: connection.accounts.map((account) => ({
			id: account.id,
			name: account.name,
			netWorthAccountId: account.netWorthAccountId,
			netWorthAccountName: account.netWorthAccount?.name ?? null,
			providerCashAccountType: account.providerCashAccountType
		})),
		createdAt: connection.createdAt.toISOString()
	}));
}

export type SyncOutcome =
	| { outcome: 'synced'; importedRows: number; duplicateRows: number }
	| { outcome: 'throttled' }
	| { outcome: 'consent_expired' }
	| { outcome: 'unavailable' }
	| { outcome: 'error' };

export interface SyncBankConnectionInput {
	userId: string;
	connectionId: string;
	/** true only for an explicit user-initiated sync (PSU present) — bypasses the throttle. */
	force?: boolean;
}

export async function syncBankConnection(
	input: SyncBankConnectionInput,
	options: BankSyncOptions = {}
): Promise<SyncOutcome> {
	const { env, now, getConnector } = resolveOptions(options);
	if (!isBankSyncEnabled(env)) throw new BankSyncError('disabled');

	const connection = await prisma.bankConnection.findFirst({
		where: { id: input.connectionId, userId: input.userId }
	});
	if (!connection) throw new BankSyncError('not_found');
	if (connection.status === 'revoked' || connection.status === 'expired') {
		return { outcome: 'unavailable' };
	}

	const currentTime = now();
	if (
		connection.consentExpiresAt &&
		connection.consentExpiresAt.getTime() <= currentTime.getTime()
	) {
		await prisma.bankConnection.update({
			where: { id: connection.id },
			data: { status: 'expired' }
		});
		return { outcome: 'consent_expired' };
	}

	if (
		!input.force &&
		connection.lastSyncAt &&
		currentTime.getTime() - connection.lastSyncAt.getTime() < SYNC_MIN_INTERVAL_MS
	) {
		return { outcome: 'throttled' };
	}

	if (!input.force) {
		// Atomically claim the throttle slot: the read above can race with a concurrent
		// sync on the same connection, so re-check + claim in one guarded update — only
		// one of two simultaneous requests can win when lastSyncAt still matches what we
		// just read (Prisma's DateTime equality compares exact instants).
		const claimed = await prisma.bankConnection.updateMany({
			where: { id: connection.id, userId: input.userId, lastSyncAt: connection.lastSyncAt },
			data: { lastSyncAt: currentTime }
		});
		if (claimed.count !== 1) return { outcome: 'throttled' };
	}

	const connector = requireConnector(getConnector, connection.provider);
	const source = resolveTransactionSource(connection.provider);
	const context: ConnectionContext = {
		providerSessionId: connection.providerSessionId,
		credentialsEncrypted: connection.credentialsEncrypted,
		consentExpiresAt: connection.consentExpiresAt
	};

	const buckets = await prisma.account.findMany({
		where: {
			userId: input.userId,
			bankConnectionId: connection.id,
			providerAccountId: { not: null }
		},
		select: { id: true, providerAccountId: true, netWorthAccountId: true, currency: true }
	});

	const overlapMs = connection.lastSyncAt
		? RESYNC_OVERLAP_DAYS * 24 * 60 * 60 * 1000
		: getFirstSyncLookbackDays(env) * 24 * 60 * 60 * 1000;
	const fromAnchor = connection.lastSyncAt ?? currentTime;
	const range = {
		from: toIsoDate(new Date(fromAnchor.getTime() - overlapMs)),
		to: toIsoDate(currentTime)
	};

	try {
		let importedRows = 0;
		let duplicateRows = 0;
		for (const bucket of buckets) {
			const transactions = await connector.fetchTransactions(
				context,
				bucket.providerAccountId as string,
				range
			);
			if (transactions.length > 0) {
				const importBatchId = await createImportBatch({
					userId: input.userId,
					// The bucket here IS the Account row, so its own id. The CSV routes go through
					// resolveImportBucketAccount, which returns { accountId }; this one queried the
					// table directly. Two shapes, one meaning, and the compiler is what said so.
					accountId: bucket.id,
					source,
					fileName: connection.aspspName ?? connector.displayName,
					profile: connection.provider,
					rowCount: transactions.length,
					invalidRows: 0,
					period: range
				});
				const result = await persistImportedTransactions({
					userId: input.userId,
					accountId: bucket.id,
					importBatchId,
					source,
					transactions
				});
				importedRows += result.importedRows;
				duplicateRows += result.duplicateRows;
			}

			// Balance enrichment (write-on-change net worth snapshot), best-effort: never
			// blocks or fails the transaction sync above. Only when the bucket was
			// explicitly linked to a NetWorthAccount (see linkBankAccountToNetWorth) and the
			// connector actually supports balances.
			if (bucket.netWorthAccountId && connector.fetchAccountBalance) {
				try {
					const balance = await connector.fetchAccountBalance(
						context,
						bucket.providerAccountId as string,
						bucket.currency
					);
					if (balance) {
						await recordSyncedBalance(
							input.userId,
							bucket.netWorthAccountId,
							balance.balanceCents,
							currentTime
						);
					}
				} catch (caught) {
					// Sanitized status only, never the provider response body — same hygiene
					// as lastSyncError.
					console.warn(
						`[bank-sync] balance fetch failed for connection ${connection.id}: ${toSafeSyncErrorSummary(caught)}`
					);
				}
			}
		}

		await prisma.bankConnection.update({
			where: { id: connection.id },
			data: { lastSyncAt: currentTime, lastSyncStatus: 'ok', lastSyncError: null }
		});
		return { outcome: 'synced', importedRows, duplicateRows };
	} catch (caught) {
		await prisma.bankConnection.update({
			where: { id: connection.id },
			data: {
				lastSyncAt: currentTime,
				lastSyncStatus: 'error',
				lastSyncError: toSafeSyncErrorSummary(caught),
				// 401/403 = the provider no longer honors this session: surface as error
				// (a re-authorization is required); anything else stays a transient failure.
				...(isAuthRejection(caught) ? { status: 'error' as const } : {})
			}
		});
		return { outcome: 'error' };
	}
}

/**
 * Deletes a connection. The buckets survive via `SetNull` and their transactions are untouched;
 * their NET WORTH link goes with the connection that earned it.
 *
 * ## Why the link is cleared here rather than left to `SetNull`
 *
 * `Account.bankConnectionId` is `SetNull` on purpose, because losing a connection must never delete
 * transactions. Nothing was ever written to clear the sibling `netWorthAccountId` beside it, so a
 * disconnected bucket went on pointing at a net worth account and `readNetWorthAccounts` went on
 * reporting `connected: true` from `_count.accounts`. That value is not stale: it is recomputed on
 * every load and was telling the truth about a link no code path cleared. Measured on 0.14.0
 * against a real engine, the row after the disconnect read
 * `bankConnectionId=null netWorthAccountId=set connected=true`.
 *
 * A bank link means "this net worth account is fed by a synced bucket", which is why
 * `linkBankAccountToNetWorth` refuses to create one for a bucket with no connection. Once the
 * connection is gone the claim is no longer true of anything, so it is withdrawn rather than left
 * for the reader to notice.
 *
 * ## Ordering, and why one transaction
 *
 * The buckets are found BY the connection, so they have to be updated before the row that
 * identifies them is deleted. Both statements share one interactive transaction: a delete that
 * succeeded while the clearing did not would leave exactly the state this function exists to
 * prevent, with nothing left to find the buckets by.
 *
 * ## What it deliberately does not touch
 *
 * A MANUAL or CSV bucket's link. Those are set from the /net-worth switch and from the import
 * path, carry no `providerAccountId`, and have nothing to do with any bank. The `where` names the
 * connection, so the blast radius is exactly the buckets that connection owned.
 *
 * A user who wants the link back after re-authorising re-links on /imports/bank-connections. That
 * is a real change: before, a reconnect through `resolveImportBucketAccount`'s relink silently
 * resumed balance sync into whatever the link had been.
 */
export async function deleteBankConnection(userId: string, connectionId: string): Promise<boolean> {
	return prisma.$transaction(async (tx) => {
		await tx.account.updateMany({
			where: { userId, bankConnectionId: connectionId, netWorthAccountId: { not: null } },
			data: { netWorthAccountId: null }
		});
		const deleted = await tx.bankConnection.deleteMany({
			where: { id: connectionId, userId }
		});
		return deleted.count > 0;
	});
}

function isAuthRejection(caught: unknown): boolean {
	return (
		caught instanceof EnableBankingApiError && (caught.status === 401 || caught.status === 403)
	);
}

/**
 * Machine summary only — never a raw provider message/body (a provider error can echo
 * request payloads). Our own Error messages are safe static strings but are still
 * reduced to a generic marker: lastSyncError is a diagnostic slot, not a log.
 */
function toSafeSyncErrorSummary(caught: unknown): string {
	if (caught instanceof EnableBankingApiError) {
		const code = caught.providerCode ? `:${caught.providerCode}` : '';
		return `http_${caught.status}${code}`.slice(0, LAST_SYNC_ERROR_MAX_LENGTH);
	}
	return 'sync_failed';
}
