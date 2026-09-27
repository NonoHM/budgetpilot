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
 * A complete sync that stops writing the cursor stays GREEN here, and that is the fourth meaning
 * rather than a hole: every sync then fetches the whole lookback, and deduplication makes the
 * ledgers agree. `service.spec.ts` asserts the write itself.
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

/** The account the injected failure targets: the SECOND bucket, so the first one lands. */
const FAILING_ACCOUNT = 'mock-savings';

/**
 * The mock connector as the sync path meets a real provider: Enable Banking returns the accounts
 * on the authorisation itself, and `completeBankAuthorization` creates the buckets from that list
 * only. The failure switch stands in for a provider error on one account partway through a sync.
 */
class FailableMockConnector extends MockBankConnector implements BankConnector {
	failNextFetchOf: string | null = null;
	fetchCalls = 0;

	override async completeAuthorization(
		input: AuthorizationCallbackInput
	): Promise<EstablishedConnection> {
		const established = await super.completeAuthorization(input);
		const accounts = await this.listAccounts(established satisfies ConnectionContext);
		return { ...established, accounts };
	}

	override async fetchTransactions(
		connection: ConnectionContext,
		accountId: string,
		range: FetchTransactionsRange
	): Promise<ImportedTransaction[]> {
		this.fetchCalls += 1;
		if (this.failNextFetchOf === accountId) {
			this.failNextFetchOf = null;
			throw new Error('injected provider failure');
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

/** The two production steps a person goes through: start the consent, come back from the bank. */
async function connect(userId: string, connector: FailableMockConnector): Promise<string> {
	const options = { env: SYNC_ENV, getConnector: () => connector };
	const started = await startBankAuthorization(
		{
			userId,
			provider: 'mock',
			aspspName: 'Banque Fictive Démo',
			aspspCountry: 'FR',
			origin: ORIGIN
		},
		options
	);
	const state = new URL(started.authorizationUrl).searchParams.get('state');
	if (!state) throw new Error('the mock authorisation URL carried no state');
	const completed = await completeBankAuthorization(
		{ userId, params: { state, code: 'db-smoke-code' } },
		options
	);
	expect(completed.accountCount).toBeGreaterThan(1);
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

function countFor(lines: string[], providerAccountId: string): number {
	return lines.filter((line) => line.startsWith(`${providerAccountId}|`)).length;
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
		failing.failNextFetchOf = FAILING_ACCOUNT;
		expect(await sync(failingUser, failingConnection, failing, firstAt)).toEqual({
			outcome: 'error'
		});

		const control = new FailableMockConnector();
		const controlConnection = await connect(controlUser, control);
		expect((await sync(controlUser, controlConnection, control, firstAt)).outcome).toBe('synced');

		// Calibration: the failure fired, and it left the failing ledger short on exactly the
		// account it targeted.
		const expected = await ledger(controlUser);
		const afterFailure = await ledger(failingUser);
		expect(countFor(expected, FAILING_ACCOUNT)).toBeGreaterThan(0);
		expect(countFor(afterFailure, FAILING_ACCOUNT)).toBe(0);
		expect(countFor(afterFailure, 'mock-checking')).toBe(countFor(expected, 'mock-checking'));

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

		// Fails on the FIRST account fetched, so nothing of that run lands anywhere.
		failing.failNextFetchOf = 'mock-checking';
		expect((await sync(failingUser, failingConnection, failing, failedAt)).outcome).toBe('error');
		expect((await sync(controlUser, controlConnection, control, failedAt)).outcome).toBe('synced');

		// Calibration: the control gained rows at `failedAt` and the failing ledger did not.
		const afterFailure = await ledger(failingUser);
		const controlAfterFailure = await ledger(controlUser);
		expect(controlAfterFailure.length).toBeGreaterThan(afterFailure.length);

		expect((await sync(failingUser, failingConnection, failing, thirdAt)).outcome).toBe('synced');
		expect((await sync(controlUser, controlConnection, control, thirdAt)).outcome).toBe('synced');

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
	it('copies lastSyncAt after a success, leaves NULL after a failure or an unfinished attempt, and never overwrites a cursor', async () => {
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
		const seed = async (lastSyncStatus: string | null, lastCompleteSyncAt: Date | null) => {
			const row = await prisma.bankConnection.create({
				data: {
					userId: failingUser,
					provider: 'mock',
					status: 'active',
					lastSyncAt: attempt,
					lastSyncStatus,
					lastCompleteSyncAt
				},
				select: { id: true }
			});
			return row.id;
		};
		const succeeded = await seed('ok', null);
		const failed = await seed('error', null);
		const neverFinished = await seed(null, null);
		const alreadySeeded = await seed('ok', earlier);

		await prisma.$executeRawUnsafe(statement);

		const rows = await prisma.bankConnection.findMany({
			where: { userId: failingUser },
			select: { id: true, lastCompleteSyncAt: true }
		});
		const cursorOf = (id: string) =>
			rows.find((row) => row.id === id)?.lastCompleteSyncAt?.toISOString() ?? null;
		expect(rows).toHaveLength(4);
		expect({
			succeeded: cursorOf(succeeded),
			failed: cursorOf(failed),
			neverFinished: cursorOf(neverFinished),
			alreadySeeded: cursorOf(alreadySeeded)
		}).toEqual({
			succeeded: attempt.toISOString(),
			failed: null,
			neverFinished: null,
			alreadySeeded: earlier.toISOString()
		});
	});
});
