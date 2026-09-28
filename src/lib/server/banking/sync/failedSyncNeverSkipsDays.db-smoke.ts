import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env as privateEnv } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import { migrationsPathFor, resolveDatabaseProvider } from '$lib/server/database/provider';
import { MockBankConnector } from '$lib/server/banking/connectors/mock';
import type {
	AuthorizationCallbackInput,
	BankConnector,
	ConnectionContext,
	EstablishedConnection,
	FetchTransactionsRange
} from '$lib/server/banking/connectors/types';
import type { ImportedTransaction } from '$lib/server/import/types';
import { completeBankAuthorization, startBankAuthorization, syncBankConnection } from './service';

/**
 * #763: A FAILED BANK SYNC NEVER SKIPS THE DAYS IT DID NOT FETCH.
 *
 * The fetch window of a sync starts from a cursor on the connection. Before #763 that cursor was
 * `lastSyncAt`, and `lastSyncAt` was written by THREE paths of `syncBankConnection`: the throttle
 * claim (before anything is fetched), the success path, and the error path. Two of the three
 * advanced the window over days nothing had fetched, so a first sync that failed partway left the
 * rest of its 90-day lookback unfetched for good: the next sync started from the failed attempt
 * minus the seven-day overlap.
 *
 * ## The oracle is the application, not a constant
 *
 * Every expectation below is a CONTROL: a second user whose connection went through the same
 * syncs at the same instants with no failure injected. The two ledgers must be the same multiset.
 * No lookback length, overlap length or flow calendar is retyped here, so the test cannot agree
 * with the code by sharing a number with it (AGENTS.md, « The test and the thing under test must
 * not share a source »). A second user rather than a second connection because buckets resolve by
 * `(userId, source, providerAccountId)`: two connections of one user share their buckets.
 *
 * ## Why db-smoke
 *
 * The defect is in which rows exist after two syncs, and the dedupe key that must stop the
 * overlap from doubling them is enforced by a unique constraint. A fake decides both.
 *
 * ## The calibration in the same pass
 *
 * Each case first asserts the failing ledger is SHORT of the control after the failed sync alone.
 * Without that, an injected failure that never fired would leave the two ledgers equal and the
 * final assertion green for the wrong reason.
 *
 * ## What reddens the two sync cases (each break run separately, SQLite, PostgreSQL, MariaDB)
 *
 * - the error path writing the cursor: a failure moves the window vs. it leaves it;
 * - the throttle claim writing the cursor: moved before anything is persisted vs. after;
 * - the window reading `lastSyncAt`: anchored on the attempt vs. on the last complete sync.
 *
 * The lookback counted as `today - N` (an N + 1 day window) reddens every sync case here, because
 * the fake bank refuses a window longer than its history, as a real one does.
 *
 * A complete sync that stops writing the cursor stays GREEN here, and that is the fourth meaning
 * rather than a hole: every sync then fetches the whole lookback, and deduplication makes the
 * ledgers agree. `service.spec.ts` asserts the write itself. A cursor in the future is likewise
 * covered only there: no production path here writes one.
 */

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly. It refuses to fall back to the default local ' +
			'SQLite file.'
	);
}

if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const ORIGIN = 'http://localhost:4183';
const SYNC_ENV = {
	BANK_SYNC_ENABLED: 'true',
	BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: ORIGIN
} as unknown as NodeJS.ProcessEnv;

/**
 * The history a bank serves, in calendar days counted inclusively. A fact about the BANK, not a
 * copy of the app's lookback: Enable Banking refuses a longer window with 422
 * WRONG_TRANSACTIONS_PERIOD at banks capping PSD2 history at 90 days (securo-finance/securo#655).
 * If the app's default lookback ever exceeded it, this suite would redden, which is right: such a
 * bank would refuse that default.
 */
const BANK_HISTORY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The mock connector with three switches a real bank has and the mock does not:
 *
 * - a failure partway through a sync, by POSITION (the Nth fetch after arming), never by account
 *   name: the sync reads its buckets with no `orderBy`, and PostgreSQL returned them in the other
 *   order from SQLite in a full suite run;
 * - a history cap: a window longer than `BANK_HISTORY_DAYS` is refused, with the reason;
 * - which accounts the consent covers, so a renewal can add one.
 */
class FailableMockConnector extends MockBankConnector implements BankConnector {
	private fetchesUntilFailure: number | null = null;
	/** Provider account ids the next consent covers; null is every account the mock has. */
	offeredAccounts: string[] | null = null;

	failFetch(position: number): void {
		this.fetchesUntilFailure = position;
	}

	override async completeAuthorization(
		input: AuthorizationCallbackInput
	): Promise<EstablishedConnection> {
		const established = await super.completeAuthorization(input);
		const offered = this.offeredAccounts;
		return offered
			? {
					...established,
					accounts: (established.accounts ?? []).filter((account) => offered.includes(account.id))
				}
			: established;
	}

	override async fetchTransactions(
		connection: ConnectionContext,
		accountId: string,
		range: FetchTransactionsRange
	): Promise<ImportedTransaction[]> {
		const days = (Date.parse(range.to) - Date.parse(range.from)) / DAY_MS + 1;
		if (days > BANK_HISTORY_DAYS) throw new Error('WRONG_TRANSACTIONS_PERIOD');
		if (this.fetchesUntilFailure !== null) {
			this.fetchesUntilFailure -= 1;
			if (this.fetchesUntilFailure === 0) {
				this.fetchesUntilFailure = null;
				throw new Error('injected provider failure');
			}
		}
		return super.fetchTransactions(connection, accountId, range);
	}
}

beforeAll(() => {
	// The mock encrypts its credentials. The db-smoke env stub is empty on purpose, so the key is
	// an explicit fixture here and nowhere else. Not a secret: it protects nothing outside this run.
	privateEnv.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

async function makeUser(tag: string): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `sync-cursor-${tag}-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	return user.id;
}

/**
 * The two production steps a person goes through: start the consent, come back from the bank.
 * With `renewConnectionId`, the renewal the connection card offers, on the same connection.
 */
async function authorize(
	userId: string,
	connector: FailableMockConnector,
	renewConnectionId?: string
): Promise<{ connectionId: string; accountCount: number }> {
	const options = { env: SYNC_ENV, getConnector: () => connector };
	const started = await startBankAuthorization(
		{
			userId,
			provider: 'mock',
			aspspName: 'Banque Fictive Démo',
			aspspCountry: 'FR',
			origin: ORIGIN,
			renewConnectionId
		},
		options
	);
	const state = new URL(started.authorizationUrl).searchParams.get('state');
	if (!state) throw new Error('the mock authorisation URL carried no state');
	return completeBankAuthorization({ userId, params: { state, code: 'db-smoke-code' } }, options);
}

async function connect(userId: string, connector: FailableMockConnector): Promise<string> {
	const completed = await authorize(userId, connector);
	expect(completed.accountCount).toBeGreaterThan(0);
	return completed.connectionId;
}

async function sync(userId: string, connectionId: string, connector: BankConnector, at: Date) {
	return syncBankConnection(
		{ userId, connectionId },
		{ env: SYNC_ENV, now: () => at, getConnector: () => connector }
	);
}

/** One line per stored row, sorted: a multiset that a doubled row changes. */
async function ledger(userId: string): Promise<string[]> {
	const rows = await prisma.transaction.findMany({
		where: { userId },
		select: {
			date: true,
			label: true,
			amountCents: true,
			account: { select: { providerAccountId: true } }
		}
	});
	return rows
		.map(
			(row) =>
				`${row.account?.providerAccountId}|${row.date.toISOString().slice(0, 10)}|${row.label}|${row.amountCents}`
		)
		.sort();
}

/** Rows per provider account, in the order of `accounts`. */
function countsPerAccount(lines: string[], accounts: string[]): number[] {
	return accounts.map((account) => lines.filter((line) => line.startsWith(`${account}|`)).length);
}

function accountsOf(lines: string[]): string[] {
	return [...new Set(lines.map((line) => line.split('|')[0]))].sort();
}

let failingUser: string;
let controlUser: string;

beforeEach(async () => {
	failingUser = await makeUser('failing');
	controlUser = await makeUser('control');
});

describe('#763: a failed bank sync never skips the days it did not fetch', () => {
	it('a FIRST sync failing on its second account is made whole by the next successful sync, with no duplicate', async () => {
		// Two instants on one calendar day and more than the six-hour throttle apart, so the claim
		// does not refuse the second sync and both runs ask the bank for the same `to` day.
		const firstAt = new Date('2026-07-19T08:00:00.000Z');
		const secondAt = new Date('2026-07-19T15:00:00.000Z');

		const failing = new FailableMockConnector();
		const failingConnection = await connect(failingUser, failing);
		// The second fetch fails: the first account lands, the second does not.
		failing.failFetch(2);
		expect(await sync(failingUser, failingConnection, failing, firstAt)).toEqual({
			outcome: 'error'
		});

		const control = new FailableMockConnector();
		const controlConnection = await connect(controlUser, control);
		expect((await sync(controlUser, controlConnection, control, firstAt)).outcome).toBe('synced');

		// Calibration: the failure fired partway. Of the two accounts, exactly one is complete and
		// the other is empty, whichever order the engine returned the buckets in.
		const expected = await ledger(controlUser);
		const accounts = accountsOf(expected);
		expect(accounts).toHaveLength(2);
		const full = countsPerAccount(expected, accounts);
		expect(full.every((count) => count > 0)).toBe(true);
		const partial = countsPerAccount(await ledger(failingUser), accounts);
		expect([
			[full[0], 0],
			[0, full[1]]
		]).toContainEqual(partial);

		expect((await sync(failingUser, failingConnection, failing, secondAt)).outcome).toBe('synced');
		expect((await sync(controlUser, controlConnection, control, secondAt)).outcome).toBe('synced');

		// Every day of the window, each row once: the same multiset as a run that never failed.
		expect(await ledger(failingUser)).toEqual(await ledger(controlUser));
	});

	it('a LATER sync failing on every account is made whole by the next successful sync, with no duplicate', async () => {
		// A successful first sync, a failed one three weeks later, a successful one ten days after
		// that. The failed run spans flow days the seven-day overlap of the third run cannot reach.
		const firstAt = new Date('2026-07-19T08:00:00.000Z');
		const failedAt = new Date('2026-08-10T08:00:00.000Z');
		const thirdAt = new Date('2026-08-20T08:00:00.000Z');

		const failing = new FailableMockConnector();
		const failingConnection = await connect(failingUser, failing);
		const control = new FailableMockConnector();
		const controlConnection = await connect(controlUser, control);

		expect((await sync(failingUser, failingConnection, failing, firstAt)).outcome).toBe('synced');
		expect((await sync(controlUser, controlConnection, control, firstAt)).outcome).toBe('synced');

		// Fails on the FIRST fetch, so nothing of that run lands anywhere.
		const beforeFailure = await ledger(failingUser);
		failing.failFetch(1);
		expect((await sync(failingUser, failingConnection, failing, failedAt)).outcome).toBe('error');
		expect((await sync(controlUser, controlConnection, control, failedAt)).outcome).toBe('synced');

		// Calibration: the failed run wrote nothing, and the control gained rows at `failedAt`.
		const afterFailure = await ledger(failingUser);
		expect(afterFailure).toEqual(beforeFailure);
		expect((await ledger(controlUser)).length).toBeGreaterThan(afterFailure.length);

		expect((await sync(failingUser, failingConnection, failing, thirdAt)).outcome).toBe('synced');
		expect((await sync(controlUser, controlConnection, control, thirdAt)).outcome).toBe('synced');

		expect(await ledger(failingUser)).toEqual(await ledger(controlUser));
	});

	/**
	 * A cursor older than the bank's history: a consent renewed late, a restore, or a sync that
	 * failed for weeks. Reddened by removing the lower clamp (the window reaches back past the bank's
	 * history and every sync is refused, so the outcome is `error` forever) vs. clamped (`synced`).
	 */
	it('a cursor older than the bank serves still syncs, and brings every day the bank still has', async () => {
		const longAgo = new Date('2026-04-01T08:00:00.000Z');
		const now = new Date('2026-07-19T08:00:00.000Z');

		const stale = new FailableMockConnector();
		const staleConnection = await connect(failingUser, stale);
		expect((await sync(failingUser, staleConnection, stale, longAgo)).outcome).toBe('synced');

		// Calibration: the fake refuses the unclamped window, with the bank's reason.
		const unclamped = {
			from: new Date(longAgo.getTime() - 7 * DAY_MS).toISOString().slice(0, 10),
			to: now.toISOString().slice(0, 10)
		};
		const context = await prisma.bankConnection.findFirstOrThrow({
			where: { id: staleConnection, userId: failingUser },
			select: { providerSessionId: true, credentialsEncrypted: true, consentExpiresAt: true }
		});
		await expect(stale.fetchTransactions(context, 'mock-checking', unclamped)).rejects.toThrow(
			'WRONG_TRANSACTIONS_PERIOD'
		);

		expect((await sync(failingUser, staleConnection, stale, now)).outcome).toBe('synced');

		// The oracle: a connection made today, whose first sync asks for everything the bank has.
		const fresh = new FailableMockConnector();
		const freshConnection = await connect(controlUser, fresh);
		expect((await sync(controlUser, freshConnection, fresh, now)).outcome).toBe('synced');
		const expected = await ledger(controlUser);
		const actual = await ledger(failingUser);
		expect(expected.length).toBeGreaterThan(0);
		expect(expected.filter((line) => !actual.includes(line))).toEqual([]);
		expect(new Set(actual).size).toBe(actual.length);
	});

	/**
	 * #769: an account the consent covers only from a renewal on. Renewal keeps the connection, and
	 * so its cursor; before the reset, the new account's first fetch started at the cursor minus the
	 * overlap and its older history was never asked for. Reddened by removing the reset in
	 * `completeBankAuthorization` (the new account gets the overlap only) vs. kept (the lookback).
	 */
	it('an account added at renewal gets the same history as an account there from the start, with no duplicate', async () => {
		// One calendar day, more than six hours apart: the renewal sits between the two syncs.
		const firstAt = new Date('2026-07-19T08:00:00.000Z');
		const secondAt = new Date('2026-07-19T15:00:00.000Z');

		const renewed = new FailableMockConnector();
		renewed.offeredAccounts = ['mock-checking'];
		const renewedConnection = await connect(failingUser, renewed);
		expect((await sync(failingUser, renewedConnection, renewed, firstAt)).outcome).toBe('synced');

		renewed.offeredAccounts = null;
		const renewal = await authorize(failingUser, renewed, renewedConnection);
		expect(renewal.connectionId).toBe(renewedConnection);

		const control = new FailableMockConnector();
		const controlConnection = await connect(controlUser, control);
		expect((await sync(controlUser, controlConnection, control, firstAt)).outcome).toBe('synced');

		// Calibration: the renewal added an account the failing ledger has no row for yet.
		const accounts = accountsOf(await ledger(controlUser));
		expect(accounts).toHaveLength(2);
		expect(accountsOf(await ledger(failingUser))).toHaveLength(1);

		expect((await sync(failingUser, renewedConnection, renewed, secondAt)).outcome).toBe('synced');
		expect((await sync(controlUser, controlConnection, control, secondAt)).outcome).toBe('synced');

		expect(await ledger(failingUser)).toEqual(await ledger(controlUser));
	});
});

/**
 * The backfill that seeds the cursor on an existing install, run as the file this engine ships.
 *
 * `migrate deploy` has already applied it to this database, over no rows. So the statement is read
 * off disk and run again over rows shaped like the states a pre-#763 install can hold, which is the
 * only way to see it act on something. It only fills a NULL, and the row holding a cursor already
 * is what proves that.
 *
 * Reddened on each engine's own file by copying after a failure too (a failed attempt stored as a
 * complete sync vs. no cursor) and by dropping the NULL guard (a cursor overwritten vs. kept).
 */
describe('#763: the backfill seeds the cursor only where the last sync succeeded', () => {
	it('copies lastSyncAt where the status reads ok, leaves NULL after a failure or a first claim that never finished, and never overwrites a cursor', async () => {
		const provider = resolveDatabaseProvider(process.env);
		const file = resolve(
			process.cwd(),
			migrationsPathFor(provider),
			'20260927120100_bank_sync_cursor_backfill/migration.sql'
		);
		const statement = readFileSync(file, 'utf8')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.trim();
		// Calibration: one statement, and it is the UPDATE, so a comment-only read cannot pass.
		expect(statement.match(/;/g)?.length).toBe(1);
		expect(statement.startsWith('UPDATE')).toBe(true);

		const attempt = new Date('2026-07-19T08:00:00.000Z');
		const earlier = new Date('2026-07-01T08:00:00.000Z');
		const claimed = new Date('2026-07-20T08:00:00.000Z');
		const seed = async (
			lastSyncAt: Date,
			lastSyncStatus: string | null,
			lastCompleteSyncAt: Date | null
		) => {
			const row = await prisma.bankConnection.create({
				data: {
					userId: failingUser,
					provider: 'mock',
					status: 'active',
					lastSyncAt,
					lastSyncStatus,
					lastCompleteSyncAt
				},
				select: { id: true }
			});
			return row.id;
		};
		const succeeded = await seed(attempt, 'ok', null);
		const failed = await seed(attempt, 'error', null);
		// A FIRST sync whose throttle claim was written and whose outcome never was: the process died
		// between the two, so the status is still the NULL a new connection starts with.
		const firstClaimOnly = await seed(attempt, null, null);
		// A sync that succeeded, then a later claim that died before its outcome. The status still
		// reads the earlier 'ok' and `lastSyncAt` holds the dead claim's instant. This row cannot be
		// told apart from `succeeded`, so the backfill copies the claim's instant: the declared limit
		// in the migration's own comment, pinned here so a change to it is seen.
		const claimOnlyAfterSuccess = await seed(claimed, 'ok', null);
		const alreadySeeded = await seed(attempt, 'ok', earlier);

		await prisma.$executeRawUnsafe(statement);

		const rows = await prisma.bankConnection.findMany({
			where: { userId: failingUser },
			select: { id: true, lastCompleteSyncAt: true }
		});
		const cursorOf = (id: string) =>
			rows.find((row) => row.id === id)?.lastCompleteSyncAt?.toISOString() ?? null;
		expect(rows).toHaveLength(5);
		expect({
			succeeded: cursorOf(succeeded),
			failed: cursorOf(failed),
			firstClaimOnly: cursorOf(firstClaimOnly),
			claimOnlyAfterSuccess: cursorOf(claimOnlyAfterSuccess),
			alreadySeeded: cursorOf(alreadySeeded)
		}).toEqual({
			succeeded: attempt.toISOString(),
			failed: null,
			firstClaimOnly: null,
			claimOnlyAfterSuccess: claimed.toISOString(),
			alreadySeeded: earlier.toISOString()
		});
	});
});
