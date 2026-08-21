import { randomUUID } from 'node:crypto';
import { constantTimeEquals } from '$lib/server/banking/constantTime';
import { normalizeForMatch } from '$lib/domain/normalize';
import { filterBalancesByCurrency, selectPreferredBalance } from '$lib/domain/bankBalance';
import type { ImportedTransaction, ImportedTransactionType } from '$lib/server/import/types';
import { parseMoney, DEFAULT_CURRENCY, isValidCurrencyCode } from '$lib/domain/money';
import {
	buildDeduplicationGroupKey,
	buildDeduplicationKey,
	hashFingerprint,
	sanitizeImportedText,
	UNCLASSIFIED_CATEGORY
} from '$lib/server/import/utils/safety';
import { createOccurrenceCounter } from '$lib/server/import/occurrence';
import {
	EnableBankingApiError,
	enableBankingRequest,
	type EnableBankingHttpOptions
} from '$lib/server/banking/enablebanking/http';
import {
	aspspsResponseSchema,
	balancesResponseSchema,
	createSessionResponseSchema,
	sessionStatusResponseSchema,
	startAuthorizationResponseSchema,
	transactionsResponseSchema,
	type EnableBankingAccountResource,
	type EnableBankingTransaction
} from '$lib/server/banking/enablebanking/schemas';
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

/** Consent length requested from the ASPSP — most banks cap around 180 days anyway. */
const CONSENT_REQUEST_DAYS = 180;
/** Defensive cap on transaction pagination; exceeded = loud failure, never silent truncation. */
const MAX_TRANSACTION_PAGES = 100;

/**
 * Session statuses observed in the Enable Banking docs. AUTHORIZED is the only one
 * documented exhaustively; the rest of the mapping is conservative (unknown => error)
 * and must be confirmed against the real sandbox in step 4c.
 */
const SESSION_STATUS_MAP: Record<string, BankConnectionLifecycleStatus> = {
	AUTHORIZED: 'active',
	EXPIRED: 'expired',
	REVOKED: 'revoked',
	CANCELLED: 'revoked',
	CLOSED: 'revoked'
};

/**
 * Real Enable Banking implementation of the BankConnector contract.
 *
 * Auth model: every API call is signed with the app-level JWT derived from env
 * (see enablebanking/jwt.ts) — the provider session holds NO per-connection secret,
 * which is why completeAuthorization returns credentialsEncrypted: null (documented
 * deliberately: there is nothing to encrypt; the session id alone is useless without
 * the app private key, which never leaves env).
 *
 * Transaction date choice (deliberate, documented): booking_date — the date the
 * transaction is booked on the account, which is what bank statements and the CSV
 * exports we already import use (e.g. Banque Populaire's "Date de comptabilisation").
 * value_date is the interest/value date and can differ (weekends, card settlement lag),
 * so using it would silently shift displayed dates relative to CSV imports of the same
 * account. Fallback chain for ASPSPs omitting booking_date: value_date, then
 * transaction_date. Only status BOOK transactions are imported: pending (PDNG) entries
 * can mutate or disappear, which would poison content-fingerprint deduplication.
 *
 * Step-4c sandbox validation results (real API, Mock ASPSP, 2026-07-19 — see
 * enablebanking/enablebanking.sandbox-validation.ts):
 * - SessionStatus: only AUTHORIZED observable live (a sandbox session can't be driven
 *   into the other states); the conservative unknown→error mapping stays as designed.
 * - GET /sessions/{id}: `accounts` IS bare uid strings, as assumed — plus an
 *   `accounts_data` array ({uid, identification_hash(es)}) that carries NO display
 *   names, confirming the capture-names-at-POST-/sessions strategy is required.
 * - entry_reference: present on 100/100 rows and byte-identical across two
 *   consecutive fetches — the provider-key dedup path is safe for this ASPSP;
 *   transaction_id was null throughout, so it could not have served instead.
 * - Pagination: continuation_key present at 100 rows/page, as implemented.
 * - The sandbox dataset is STATIC (booking dates 2020-2021): a first sync's 90-day
 *   lookback legitimately imports 0 rows there — not a defect of this connector.
 */
export class EnableBankingConnector implements BankConnector {
	readonly id = 'enablebanking';
	readonly displayName = 'Enable Banking';

	constructor(private readonly httpOptions: EnableBankingHttpOptions = {}) {}

	async listBanks(country: string): Promise<BankAspsp[]> {
		const raw = await enableBankingRequest(
			{ path: '/aspsps', query: { country } },
			this.httpOptions
		);
		const parsed = aspspsResponseSchema.parse(raw);
		return parsed.aspsps.map((aspsp) => ({ name: aspsp.name, country: aspsp.country }));
	}

	async createConnection(input: CreateConnectionInput): Promise<PendingAuthorization> {
		if (!input.aspsp) {
			throw new Error('Missing ASPSP selection');
		}
		const state = randomUUID();
		const now = this.now();
		const validUntil = new Date(now.getTime() + CONSENT_REQUEST_DAYS * 24 * 60 * 60 * 1000);
		const raw = await enableBankingRequest(
			{
				method: 'POST',
				path: '/auth',
				body: {
					access: { valid_until: validUntil.toISOString() },
					aspsp: { name: input.aspsp.name, country: input.aspsp.country },
					state,
					redirect_url: input.redirectUrl,
					psu_type: 'personal'
				}
			},
			this.httpOptions
		);
		const parsed = startAuthorizationResponseSchema.parse(raw);
		return { authorizationUrl: parsed.url, state };
	}

	async completeAuthorization(input: AuthorizationCallbackInput): Promise<EstablishedConnection> {
		const callbackState = input.params.state;
		if (!callbackState || !constantTimeEquals(callbackState, input.expectedState)) {
			throw new Error('Authorization state mismatch');
		}
		const code = input.params.code;
		if (!code) {
			throw new Error('Missing authorization code');
		}
		const raw = await enableBankingRequest(
			{ method: 'POST', path: '/sessions', body: { code } },
			this.httpOptions
		);
		const parsed = createSessionResponseSchema.parse(raw);
		return {
			providerSessionId: parsed.session_id,
			// Deliberately null: Enable Banking auth is app-level (env-held private key),
			// the session carries no per-connection secret to encrypt at rest.
			credentialsEncrypted: null,
			consentExpiresAt: parseProviderDate(parsed.access?.valid_until),
			accounts: (parsed.accounts ?? []).map(toConnectorAccount)
		};
	}

	async listAccounts(connection: ConnectionContext): Promise<BankConnectorAccount[]> {
		const sessionId = this.requireSession(connection);
		const raw = await enableBankingRequest(
			{ path: `/sessions/${encodeURIComponent(sessionId)}` },
			this.httpOptions
		);
		const parsed = sessionStatusResponseSchema.parse(raw);
		// Bare uids only at this endpoint — names/currencies were captured at
		// authorization time (EstablishedConnection.accounts) and live in step-4b's
		// persistence; this fallback keeps the contract honest without inventing names.
		return (parsed.accounts ?? []).map((uid, index) => ({
			id: uid,
			name: `Compte ${index + 1}`,
			currency: 'EUR'
		}));
	}

	async fetchTransactions(
		connection: ConnectionContext,
		accountId: string,
		range: FetchTransactionsRange
	): Promise<ImportedTransaction[]> {
		this.requireSession(connection);
		this.assertConsentNotExpired(connection);
		if (range.from > range.to) {
			throw new Error('Invalid date range');
		}

		const transactions: ImportedTransaction[] = [];
		let continuationKey: string | undefined;
		// One counter per fetch, created OUTSIDE the pagination loop so a group spanning two
		// pages keeps counting rather than restarting. See occurrence.ts.
		const nextOccurrence = createOccurrenceCounter();
		for (let page = 0; ; page += 1) {
			if (page >= MAX_TRANSACTION_PAGES) {
				throw new Error('Enable Banking pagination exceeded the defensive page cap');
			}
			const raw = await enableBankingRequest(
				{
					path: `/accounts/${encodeURIComponent(accountId)}/transactions`,
					query: { date_from: range.from, date_to: range.to, continuation_key: continuationKey }
				},
				this.httpOptions
			);
			const parsed = transactionsResponseSchema.parse(raw);
			for (const transaction of parsed.transactions) {
				const mapped = mapTransaction(transaction, accountId, nextOccurrence);
				if (mapped) transactions.push(mapped);
			}
			if (!parsed.continuation_key) break;
			continuationKey = parsed.continuation_key;
		}
		return transactions;
	}

	async getConnectionStatus(connection: ConnectionContext): Promise<BankConnectionLifecycleStatus> {
		if (!connection.providerSessionId) return 'revoked';
		if (
			connection.consentExpiresAt &&
			connection.consentExpiresAt.getTime() <= this.now().getTime()
		) {
			return 'expired';
		}
		try {
			const raw = await enableBankingRequest(
				{ path: `/sessions/${encodeURIComponent(connection.providerSessionId)}` },
				this.httpOptions
			);
			const parsed = sessionStatusResponseSchema.parse(raw);
			return SESSION_STATUS_MAP[parsed.status] ?? 'error';
		} catch (caught) {
			if (caught instanceof EnableBankingApiError && caught.status === 404) return 'revoked';
			return 'error';
		}
	}

	/**
	 * GET /accounts/{id}/balances → one FetchedAccountBalance, or null when nothing usable
	 * survives currency filtering/parsing (a normal outcome, not an error — see the
	 * contract's doc comment). Sign: parsed via parseSignedDecimalAmountCents (NOT the
	 * transaction parser — see its doc comment), so a negative provider amount (e.g. an
	 * overdrawn account or a LOAN balance expressed as negative) is preserved. Whether a
	 * LOAN account's amount is actually negative in practice is unconfirmed beyond the Mock
	 * ASPSP sandbox (see enablebanking.sandbox-validation.ts) — the parsing itself is no
	 * longer the source of ambiguity, only the provider's own convention is.
	 */
	async fetchAccountBalance(
		connection: ConnectionContext,
		accountId: string,
		accountCurrency: string
	): Promise<FetchedAccountBalance | null> {
		this.requireSession(connection);
		const raw = await enableBankingRequest(
			{ path: `/accounts/${encodeURIComponent(accountId)}/balances` },
			this.httpOptions
		);
		const parsed = balancesResponseSchema.parse(raw);

		const candidates = parsed.balances
			.map((balance) => {
				// NOT parseDecimalAmountCents: that parser is transaction-specific and always
				// returns an absolute magnitude, because transactions reconstruct their sign
				// separately from credit_debit_indicator. A balance amount carries its own
				// sign directly in the string (e.g. an overdrawn/negative balance) — using the
				// absolute parser here would silently strip it (security-reviewed finding).
				const amountCents = parseSignedDecimalAmountCents(balance.balance_amount.amount);
				if (amountCents === null) return null;
				return {
					balanceType: balance.balance_type,
					amountCents,
					currency: balance.balance_amount.currency,
					asOfRaw: balance.reference_date ?? balance.last_change_date_time ?? null
				};
			})
			.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

		const selected = selectPreferredBalance(filterBalancesByCurrency(candidates, accountCurrency));
		if (!selected) return null;

		return {
			balanceCents: selected.amountCents,
			currency: selected.currency,
			balanceType: selected.balanceType,
			asOf: parseProviderDate(selected.asOfRaw)
		};
	}

	private requireSession(connection: ConnectionContext): string {
		if (!connection.providerSessionId) {
			throw new Error('Connection has no provider session');
		}
		return connection.providerSessionId;
	}

	private assertConsentNotExpired(connection: ConnectionContext): void {
		if (
			connection.consentExpiresAt &&
			connection.consentExpiresAt.getTime() <= this.now().getTime()
		) {
			throw new Error('Connection consent has expired');
		}
	}

	private now(): Date {
		return this.httpOptions.now?.() ?? new Date();
	}
}

function toConnectorAccount(account: EnableBankingAccountResource): BankConnectorAccount {
	const explicitName = sanitizeImportedText(account.name ?? account.product ?? '');
	return {
		id: account.uid,
		// IBAN fallback is masked to its last 4 characters (security review L2): a full
		// IBAN must never become a displayed/persisted account name.
		name: explicitName || maskIbanTail(account.account_id?.iban) || 'Compte bancaire',
		currency: normalizeProviderCurrency(account.currency),
		cashAccountType: account.cash_account_type ?? null,
		hasCreditLimit: account.credit_limit != null
	};
}

/**
 * A provider's currency code, normalised to the one shape the rest of the application accepts.
 *
 * This is a trust boundary and it had nothing on it. The value went straight onto
 * `Account.currency`, a NOT NULL column with no validation, and the failure it produces is
 * asymmetric in the direction that hurts most: the BACKUP boundary does enforce ISO 4217's
 * grammar, so a malformed code stored from here would come back as
 * "must be a three-letter ISO 4217 code" when the user tried to restore THEIR OWN export. The only
 * repair would be hand-editing JSON.
 *
 * Uppercased before checking rather than refused outright, because lowercase is the realistic
 * provider deviation and `EUR` is what `eur` means. Anything still malformed falls back to the
 * application default: a bucket denominated in a code no formatter can render is worse than a
 * bucket denominated in the wrong one, because the wrong one is visible and correctable and the
 * unrenderable one takes the screen down.
 */
function normalizeProviderCurrency(currency: string | null | undefined): string {
	const normalized = currency?.trim().toUpperCase() ?? '';
	return isValidCurrencyCode(normalized) ? normalized : DEFAULT_CURRENCY;
}

function maskIbanTail(iban: string | null | undefined): string | null {
	const trimmed = iban?.trim();
	if (!trimmed) return null;
	return `Compte ****${trimmed.slice(-4)}`;
}

/** Maps one provider transaction; returns null for entries we deliberately skip (non-BOOK). */
function mapTransaction(
	transaction: EnableBankingTransaction,
	accountId: string,
	nextOccurrence: (groupKey: string) => number
): ImportedTransaction | null {
	if (transaction.status && transaction.status !== 'BOOK') return null;

	const indicator = transaction.credit_debit_indicator;
	if (indicator !== 'CRDT' && indicator !== 'DBIT') {
		throw new Error('Enable Banking transaction has an unknown credit/debit indicator');
	}
	const type: ImportedTransactionType = indicator === 'CRDT' ? 'income' : 'expense';

	const absAmountCents = parseDecimalAmountCents(transaction.transaction_amount.amount);
	if (absAmountCents === null || absAmountCents === 0) {
		throw new Error('Enable Banking transaction has an unparseable amount');
	}
	const amountCents = type === 'income' ? absAmountCents : -absAmountCents;

	const date =
		transaction.booking_date ?? transaction.value_date ?? transaction.transaction_date ?? null;
	if (!date) {
		throw new Error('Enable Banking transaction has no usable date');
	}

	const remittance = (transaction.remittance_information ?? []).join(' ').trim();
	const counterparty = type === 'expense' ? transaction.creditor?.name : transaction.debtor?.name;
	const label = sanitizeImportedText(remittance || counterparty || '') || 'OPERATION BANCAIRE';

	// Built here rather than inside the branch below so `date` keeps the narrowing the guard
	// above gave it: TypeScript drops it inside a nested function, and a closure was the first
	// shape tried. The ternary is lazy, so the counter is still consumed only on the fallback
	// branch, and a provider emitting entry_reference never advances an ordinal it will not use.
	//
	// `category` left the key in v2: it was the constant UNCLASSIFIED_CATEGORY here, so it never
	// distinguished anything.
	const fallbackGroup = {
		date,
		label: normalizeForMatch(label),
		amountCents: absAmountCents,
		type
	};

	const entryReference = transaction.entry_reference?.trim() ?? '';
	// Provider entry_reference is the stable per-account dedup anchor; the content
	// fingerprint (normalized label) only backs up ASPSPs that omit it.
	const deduplicationKey = entryReference
		? `enablebanking:${accountId}:${entryReference}`
		: buildDeduplicationKey({
				...fallbackGroup,
				occurrence: nextOccurrence(buildDeduplicationGroupKey(fallbackGroup)),
				accountScope: `enablebanking:${accountId}`
			});

	return {
		id: `eb-${hashFingerprint(deduplicationKey)}`,
		date,
		label,
		amountCents,
		// Never a pre-filled category: categorization belongs exclusively to the rules
		// pipeline (same constraint as the mock connector and CSV profiles).
		category: UNCLASSIFIED_CATEGORY,
		source: 'enablebanking',
		metadata: {
			reference: entryReference,
			notes: label,
			type,
			bankOperationType: transaction.bank_transaction_code?.description ?? undefined,
			deduplicationKey
		}
	};
}

/** Parses a provider datetime string into a Date; null when absent or unparseable. */
function parseProviderDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parses the API's decimal string amounts ("12.34") into absolute cents; null on bad input.
 *
 * The grammar lives in `domain/money.ts` rather than in a regex here, which is what stops this
 * file's idea of an acceptable amount drifting from the four CSV profiles'. One deliberate
 * widening comes with that: the shared grammar also accepts inner whitespace and a comma decimal
 * separator, which this regex refused. The refusal was not a protection, it was an ABORT (see
 * `fetchAccountTransactions`), so accepting more here can only turn a failed fetch into a parsed
 * amount. What is still refused is the case that matters: more fraction digits than the exponent.
 */
function parseDecimalAmountCents(value: string): number | null {
	const parsed = parseMoney(value, { requireSafeInteger: true });
	return parsed === null ? null : Math.abs(parsed.minorUnits);
}

/**
 * Same decimal grammar as parseDecimalAmountCents, but SIGNED — a balance amount carries its
 * own sign directly (unlike a transaction amount, whose sign is reconstructed separately from
 * credit_debit_indicator by mapTransaction). Deliberately a distinct function rather than an
 * "absolute" flag on the transaction parser: the two call sites must never accidentally swap
 * signedness again (see fetchAccountBalance's doc comment / security review finding).
 */
function parseSignedDecimalAmountCents(value: string): number | null {
	return parseMoney(value, { requireSafeInteger: true })?.minorUnits ?? null;
}
