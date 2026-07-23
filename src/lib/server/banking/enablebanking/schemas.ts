import { z } from 'zod';

/**
 * Zod schemas for the Enable Banking API responses we consume — validated parsing,
 * never manual property access on untrusted JSON (same convention as the Ollama
 * structured output). Unknown extra fields are stripped, absent optional fields are
 * tolerated: ASPSP payloads vary and step 4c (real sandbox validation) will confirm
 * the exact shapes flagged in the connector's doc comments.
 */

const amountSchema = z.object({
	currency: z.string(),
	/** Decimal string (e.g. "12.34") per the API — parsed to cents by the connector. */
	amount: z.string()
});

const partySchema = z.object({ name: z.string().nullish() });

/** Full account resource as returned by POST /sessions (authorization completion). */
export const accountResourceSchema = z.object({
	uid: z.string(),
	name: z.string().nullish(),
	currency: z.string().nullish(),
	product: z.string().nullish(),
	account_id: z.object({ iban: z.string().nullish() }).nullish(),
	/** ISO 20022 CashAccountType (CACC/SVGS/CARD/LOAN/CASH/OTHR) — feeds the net worth
	 *  account type suggestion (domain/netWorth.ts's suggestNetWorthAccountType), never
	 *  authoritative. */
	cash_account_type: z.string().nullish(),
	/** Presence (not amount) breaks the CARD checking-vs-credit ambiguity in the mapping
	 *  above; the amount itself is never persisted or displayed. */
	credit_limit: amountSchema.nullish()
});

/** GET /aspsps — the provider-supplied bank list (bank selection is never free-text). */
export const aspspsResponseSchema = z.object({
	aspsps: z.array(
		z.object({
			name: z.string(),
			country: z.string(),
			/** Some ASPSPs are listed but marked beta/unstable; kept optional and unused for now. */
			beta: z.boolean().nullish()
		})
	)
});

export const startAuthorizationResponseSchema = z.object({
	url: z.string(),
	authorization_id: z.string().nullish()
});

export const createSessionResponseSchema = z.object({
	session_id: z.string(),
	accounts: z.array(accountResourceSchema).nullish(),
	access: z.object({ valid_until: z.string().nullish() }).nullish()
});

/** GET /sessions/{id} — accounts come back as bare uids here, not full resources. */
export const sessionStatusResponseSchema = z.object({
	status: z.string(),
	accounts: z.array(z.string()).nullish(),
	access: z.object({ valid_until: z.string().nullish() }).nullish()
});

/** One entry of GET /accounts/{id}/balances — several balance_type entries per account. */
export const balanceResourceSchema = z.object({
	name: z.string().nullish(),
	balance_amount: amountSchema,
	/** ISO 20022 BalanceStatus code (e.g. CLBD/ITBD/XPCD/CLAV/ITAV/...) — see D3 preference
	 *  order in domain/bankBalance.ts's selectPreferredBalance(). */
	balance_type: z.string(),
	reference_date: z.string().nullish(),
	last_change_date_time: z.string().nullish()
});

export const balancesResponseSchema = z.object({
	balances: z.array(balanceResourceSchema)
});

export type EnableBankingBalance = z.infer<typeof balanceResourceSchema>;

export const transactionSchema = z.object({
	entry_reference: z.string().nullish(),
	booking_date: z.string().nullish(),
	value_date: z.string().nullish(),
	transaction_date: z.string().nullish(),
	status: z.string().nullish(),
	credit_debit_indicator: z.string(),
	transaction_amount: amountSchema,
	remittance_information: z.array(z.string()).nullish(),
	creditor: partySchema.nullish(),
	debtor: partySchema.nullish(),
	bank_transaction_code: z.object({ description: z.string().nullish() }).nullish()
});

export const transactionsResponseSchema = z.object({
	transactions: z.array(transactionSchema),
	continuation_key: z.string().nullish()
});

export type EnableBankingTransaction = z.infer<typeof transactionSchema>;
export type EnableBankingAccountResource = z.infer<typeof accountResourceSchema>;
