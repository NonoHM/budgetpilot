import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { BALANCE_TYPE_PREFERENCE } from '$lib/domain/bankBalance';
import {
	aspspsResponseSchema,
	balancesResponseSchema,
	sessionStatusResponseSchema,
	transactionsResponseSchema
} from './schemas';
import { createEnableBankingJwt, getEnableBankingCredentials } from './jwt';
import { EnableBankingApiError, enableBankingRequest } from './http';

/**
 * Bank-sync step 4c: REAL Enable Banking sandbox validation (opt-in, real network —
 * see vitest.sandbox.config.ts; never part of the normal suite). Confirms the three
 * assumptions flagged "to verify against the real sandbox" in the connector's header:
 *
 *   1. the SessionStatus enum values beyond AUTHORIZED (Phase C);
 *   2. the exact GET /sessions/{id} shape — bare account uids assumed (Phase C);
 *   3. entry_reference presence/stability across fetches (Phase C);
 *
 * plus the Phase A preflight (credentials/JWT accepted, /aspsps shape), and (net worth
 * link chantier) the balances endpoint: GET /accounts/{id}/balances raw shape, which
 * balance_type codes the Mock ASPSP actually serves (vs. BALANCE_TYPE_PREFERENCE/D3), and
 * whether the current consent scope already covers it.
 *
 * Phase C needs an authorized session: run the consent flow once through the UI
 * (npm run dev → /imports/bank-connections) before it un-skips — it reads the latest
 * enablebanking BankConnection from the dev SQLite DB (read-only).
 *
 * Output discipline: this harness only ever logs SHAPES (keys + primitive types),
 * counts and non-sensitive scalars (status strings, bank names, countries, balance SIGN
 * — never the amount itself) — never amounts, labels, IBANs, ids, tokens or key material.
 */

// The dev DATABASE_URL ("file:./dev.db") has resolved to the project root in practice;
// prisma/dev.db is kept as a fallback in case the resolution anchor changes.
const DEV_DB_CANDIDATES = ['dev.db', 'prisma/dev.db'];

interface StoredConnection {
	id: string;
	providerSessionId: string;
	status: string;
}

function readLatestConnection(): StoredConnection | null {
	for (const path of DEV_DB_CANDIDATES) {
		if (!existsSync(path)) continue;
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const row = db
				.prepare(
					`SELECT id, providerSessionId, status FROM BankConnection
					 WHERE provider = 'enablebanking' AND providerSessionId IS NOT NULL
					 ORDER BY createdAt DESC LIMIT 1`
				)
				.get() as unknown as StoredConnection | undefined;
			if (row) return row;
		} catch {
			// Missing table (empty/other DB file): try the next candidate.
		} finally {
			db.close();
		}
	}
	return null;
}

interface StoredBucketAccount {
	providerAccountId: string;
	providerCashAccountType: string | null;
}

/**
 * Cross-references the sandbox's live account uids with whatever cash_account_type this
 * connection's buckets already captured at authorization time (persist.ts, D6) — the only
 * way this harness can attempt the "LOAN sign" check, since GET /sessions/{id} only returns
 * bare uids (cash_account_type isn't re-fetchable there). Empty if no bucket was ever linked
 * through the UI for this connection, or if a LOAN account was never among them.
 */
function readBucketCashAccountTypes(connectionId: string): Map<string, string | null> {
	const result = new Map<string, string | null>();
	for (const path of DEV_DB_CANDIDATES) {
		if (!existsSync(path)) continue;
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const rows = db
				.prepare(
					`SELECT providerAccountId, providerCashAccountType FROM Account
					 WHERE bankConnectionId = ? AND providerAccountId IS NOT NULL`
				)
				.all(connectionId) as unknown as StoredBucketAccount[];
			for (const row of rows) result.set(row.providerAccountId, row.providerCashAccountType);
			if (result.size > 0) return result;
		} catch {
			// Missing table/columns (older DB file): try the next candidate.
		} finally {
			db.close();
		}
	}
	return result;
}

/** Recursive type-skeleton of a JSON value — structure only, never data. */
function shapeOf(value: unknown): unknown {
	if (value === null) return 'null';
	if (Array.isArray(value)) {
		return value.length === 0 ? [] : [`${value.length} items`, shapeOf(value[0])];
	}
	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, shapeOf(entry)])
		);
	}
	return typeof value;
}

function logShape(label: string, value: unknown): void {
	console.log(`\n=== ${label} ===\n${JSON.stringify(shapeOf(value), null, 2)}`);
}

function isoDaysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// The sandbox Mock ASPSP serves a STATIC synthetic dataset (observed: 2020-2021 booking
// dates) — a recent window would come back empty, so Phase C queries a wide fixed range.
const SAMPLE_DATE_FROM = '2020-01-01';

const STATUSES_MAPPED_BY_CONNECTOR = ['AUTHORIZED', 'EXPIRED', 'REVOKED', 'CANCELLED', 'CLOSED'];

describe('Phase A — preflight (no consent needed)', () => {
	it('credentials are configured (.env)', () => {
		const credentials = getEnableBankingCredentials();
		expect(
			credentials,
			'Set ENABLE_BANKING_APP_ID and ENABLE_BANKING_PRIVATE_KEY(_PATH) in .env'
		).not.toBeNull();
		expect(process.env.BANK_SYNC_ENABLED, 'Set BANK_SYNC_ENABLED=true in .env').toBe('true');
	});

	it('the configured private key signs a well-formed JWT', async () => {
		const credentials = getEnableBankingCredentials();
		expect(credentials).not.toBeNull();
		const token = await createEnableBankingJwt(credentials!);
		expect(token.split('.')).toHaveLength(3);
	});

	it('the API accepts the app JWT (GET /application)', async () => {
		try {
			const raw = await enableBankingRequest({ path: '/application' });
			logShape('GET /application', raw);
			expect(raw).toBeTypeOf('object');
		} catch (caught) {
			// Tolerate a missing endpoint, never an auth rejection.
			if (caught instanceof EnableBankingApiError && caught.status === 404) {
				console.log('GET /application: 404 (endpoint absent) — JWT check falls to /aspsps');
				expect(caught.status).toBe(404);
				return;
			}
			throw caught;
		}
	});

	it('GET /aspsps matches our Zod schema (sandbox bank list)', async () => {
		const raw = await enableBankingRequest({ path: '/aspsps' });
		logShape('GET /aspsps (first item)', raw);
		const parsed = aspspsResponseSchema.parse(raw);
		expect(parsed.aspsps.length).toBeGreaterThan(0);
		const countries = [...new Set(parsed.aspsps.map((aspsp) => aspsp.country))].sort();
		console.log(
			`ASPSPs: ${parsed.aspsps.length} — countries: ${countries.join(', ')} — sample names: ${parsed.aspsps
				.slice(0, 5)
				.map((aspsp) => aspsp.name)
				.join(', ')}`
		);
	});
});

const connection = readLatestConnection();

describe.runIf(connection !== null)('Phase C — post-consent (needs one authorized session)', () => {
	const sessionId = connection?.providerSessionId ?? '';

	it('GET /sessions/{id}: raw shape, schema parse, status value', async () => {
		const raw = await enableBankingRequest({
			path: `/sessions/${encodeURIComponent(sessionId)}`
		});
		logShape('GET /sessions/{id}', raw);
		const parsed = sessionStatusResponseSchema.parse(raw);
		console.log(
			`Session status: "${parsed.status}" (connector maps: ${STATUSES_MAPPED_BY_CONNECTOR.join('/')}; unknown => error). ` +
				`accounts field: array of ${typeof (parsed.accounts ?? [])[0]} — connector assumes bare uid strings.`
		);
		expect(parsed.status.length).toBeGreaterThan(0);
		// The stored-status transition logic relies on these observed values.
		if (!STATUSES_MAPPED_BY_CONNECTOR.includes(parsed.status)) {
			console.warn(
				`!! Status "${parsed.status}" is NOT in the connector's map — it would be treated as 'error'. Extend SESSION_STATUS_MAP if legitimate.`
			);
		}
		expect(
			parsed.accounts === null || parsed.accounts === undefined || Array.isArray(parsed.accounts)
		).toBe(true);
	});

	it('transactions: raw shape, BOOK/PDNG split, entry_reference presence', async () => {
		const accountUid = await firstAccountUid(sessionId);
		const raw = await enableBankingRequest({
			path: `/accounts/${encodeURIComponent(accountUid)}/transactions`,
			query: { date_from: SAMPLE_DATE_FROM, date_to: isoDaysAgo(0) }
		});
		logShape('GET /accounts/{id}/transactions (first item)', raw);
		const parsed = transactionsResponseSchema.parse(raw);
		const statuses = countBy(parsed.transactions.map((t) => t.status ?? 'ABSENT'));
		const withRef = parsed.transactions.filter((t) => t.entry_reference?.trim()).length;
		console.log(
			`Transactions (wide range): ${parsed.transactions.length} — statuses: ${JSON.stringify(statuses)} — with entry_reference: ${withRef}/${parsed.transactions.length} — continuation_key: ${parsed.continuation_key ? 'present' : 'absent'}`
		);
		expect(parsed.transactions.length).toBeGreaterThanOrEqual(0);
	});

	it('entry_reference is stable across two consecutive fetches', async () => {
		const accountUid = await firstAccountUid(sessionId);
		const fetchRefs = async () => {
			const raw = await enableBankingRequest({
				path: `/accounts/${encodeURIComponent(accountUid)}/transactions`,
				query: { date_from: SAMPLE_DATE_FROM, date_to: isoDaysAgo(0) }
			});
			return transactionsResponseSchema
				.parse(raw)
				.transactions.map((t) => t.entry_reference?.trim() ?? '')
				.sort();
		};
		const first = await fetchRefs();
		const second = await fetchRefs();
		console.log(
			`entry_reference stability: fetch1=${first.length} rows, fetch2=${second.length} rows, identical=${JSON.stringify(first) === JSON.stringify(second)}`
		);
		// Instability here would poison provider-key dedup — the connector would then
		// need to rely on its content-fingerprint fallback for this ASPSP.
		expect(second).toEqual(first);
	});

	it('balances: raw shape, schema parse, which balance_type codes the sandbox serves', async () => {
		const accountUids = await allAccountUids(sessionId);
		const cashAccountTypes = readBucketCashAccountTypes(connection?.id ?? '');

		const balanceTypesByAccount: Record<number, string[]> = {};
		const signsByAccount: Record<number, string[]> = {};
		let loggedShape = false;

		for (let i = 0; i < accountUids.length; i += 1) {
			const raw = await enableBankingRequest({
				path: `/accounts/${encodeURIComponent(accountUids[i])}/balances`
			});
			if (!loggedShape) {
				logShape('GET /accounts/{id}/balances (first account)', raw);
				loggedShape = true;
			}
			const parsed = balancesResponseSchema.parse(raw);
			balanceTypesByAccount[i] = parsed.balances.map((balance) => balance.balance_type);
			// Sign only — never the amount itself (output discipline).
			signsByAccount[i] = parsed.balances.map((balance) => {
				const amount = Number.parseFloat(balance.balance_amount.amount);
				if (Number.isNaN(amount)) return 'unparseable';
				return amount < 0 ? 'negative' : amount > 0 ? 'positive' : 'zero';
			});
		}

		console.log(
			`Balance types served per account (index): ${JSON.stringify(balanceTypesByAccount)}`
		);
		console.log(
			`Balance signs per account (index, never the amount): ${JSON.stringify(signsByAccount)}`
		);

		const servedTypes = [...new Set(Object.values(balanceTypesByAccount).flat())];
		console.log(
			`Distinct balance_type values observed: ${servedTypes.join(', ') || '(none)'} — connector preference order (D3): ${BALANCE_TYPE_PREFERENCE.join(' > ')}`
		);
		const unexpected = servedTypes.filter(
			(type) => !(BALANCE_TYPE_PREFERENCE as readonly string[]).includes(type)
		);
		if (unexpected.length > 0) {
			console.warn(
				`!! Balance types outside the connector's known preference list: ${unexpected.join(', ')} — selectPreferredBalance() falls back to the first entry for these; confirm this is acceptable or extend BALANCE_TYPE_PREFERENCE.`
			);
		}

		// LOAN sign cross-reference: only possible for accounts already linked through the
		// UI (providerCashAccountType captured at authorization time — see persist.ts/D6).
		// Empty most of the time; this is best-effort, not a hard requirement of this test.
		if (cashAccountTypes.size > 0) {
			for (let i = 0; i < accountUids.length; i += 1) {
				const cashAccountType = cashAccountTypes.get(accountUids[i]);
				if (cashAccountType === 'LOAN') {
					console.log(
						`LOAN account found (index ${i}) — signs observed: ${JSON.stringify(signsByAccount[i])}. ` +
							'Compare against the connector doc comment\'s "sign convention assumed, unconfirmed" note.'
					);
				}
			}
		} else {
			console.log(
				'No bucket with a captured providerCashAccountType for this connection — cannot cross-reference a LOAN account sign here. ' +
					'Link a bank-sync bucket through the UI first if this ASPSP exposes a loan account.'
			);
		}

		expect(accountUids.length).toBeGreaterThan(0);
	});

	it('consent scope covers /balances (no permission error)', async () => {
		const accountUid = await firstAccountUid(sessionId);
		try {
			await enableBankingRequest({
				path: `/accounts/${encodeURIComponent(accountUid)}/balances`
			});
			console.log('Balances endpoint reachable under the current consent — no extra scope needed.');
		} catch (caught) {
			if (
				caught instanceof EnableBankingApiError &&
				(caught.status === 401 || caught.status === 403)
			) {
				console.warn(
					`!! Balances endpoint rejected (status ${caught.status}) — the consent request (POST /auth's access object, connectors/enablebanking.ts's createConnection) may need an explicit "balances" access scope alongside the current one.`
				);
			}
			throw caught;
		}
	});
});

if (connection === null) {
	console.log(
		'Phase C skipped: no authorized enablebanking connection in prisma/dev.db. ' +
			'Run the consent flow once via the UI (npm run dev -> /imports/bank-connections), then re-run.'
	);
}

async function firstAccountUid(sessionId: string): Promise<string> {
	const uids = await allAccountUids(sessionId);
	const uid = uids[0];
	if (!uid) throw new Error('Session has no accounts to fetch transactions from');
	return uid;
}

async function allAccountUids(sessionId: string): Promise<string[]> {
	const raw = await enableBankingRequest({
		path: `/sessions/${encodeURIComponent(sessionId)}`
	});
	const parsed = sessionStatusResponseSchema.parse(raw);
	return parsed.accounts ?? [];
}

function countBy(values: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}
