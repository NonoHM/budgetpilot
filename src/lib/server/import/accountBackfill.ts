import type { PrismaClient } from '../database/types.ts';
// Relative, `.ts`-suffixed imports, like `dedupeBackfill.ts` and `dedupeRecomputeBackfill.ts` next
// door: these modules are also importable by plain Node (no Vite, no `$lib` alias) so a backfill
// can be run and inspected outside the app.
import { LONG_TRANSACTION_OPTIONS } from '../dbTransaction.ts';
import { computeNameKey } from '../naming/nameKey.ts';

/**
 * The metadata migration that turns import buckets into named accounts.
 *
 * ## Why it writes no transaction row, and why that is the whole design
 *
 * MEASURED 2026-08-22 on a throwaway SQLite, through the real parse and persist:
 *
 *     [6m] stored key carries it: true
 *     [6m] keys rewritten by the metadata migration: 0
 *     [6m] CONTROL re-import into the same id: imported=0 duplicate=1
 *
 * The v3 deduplication key carries `Account.id` verbatim (`dedupeRecompute.ts`, `contentFieldsOf`
 * puts `encodeKeyField(row.accountId)` in field 6), and the bucket ALREADY IS an `Account` row with
 * a stable cuid. So promoting the row keeps every stored key valid and `runDedupeKeyRecompute` is
 * never called. Creating a new table with fresh ids would have made every stored key false,
 * because `accountId` is IN the key.
 *
 * The control leg above is why the zero means anything: a probe that cannot observe a preserved
 * perimeter reports the same zero as one that observes it and finds nothing.
 *
 * App code rather than SQL, like every other backfill here, because `prisma migrate deploy` wraps
 * NOTHING in a transaction on any engine.
 *
 * ## What it reports, and what it must never report
 *
 * Counts only. Never a name, an id or a key: a deduplication key contains the transaction's own
 * label, which is a merchant name and therefore personal financial data. ASVS 5.0.0 16.2.5.
 */

/** How many rows one pass claims. Also the unit the progress line reports against. */
export const ACCOUNT_BACKFILL_BATCH = 500;

/**
 * The institution a bucket's `source` names, when it names one at all.
 *
 * An INCLUSION set here, and it is the opposite choice from `isStatementAccount`'s exclusion set,
 * deliberately, because the failure directions are reversed. Forgetting a connector there HIDES a
 * real account, so the safe default is to include. Here, guessing an institution for a source this
 * function has never heard of would RENAME a user's account on a guess, and a wrong name is
 * invisible once written: it reads as something the user chose. The safe default is to leave it
 * alone. Same rule in both places, which is that the reversible failure is the one to prefer.
 */
export function institutionForSource(source: string): string | null {
	if (source === 'banque_populaire') return 'Banque Populaire';
	if (source === 'revolut') return 'Revolut';
	return null;
}

/**
 * The name to store. Unchanged whenever we have no proper noun for the source.
 *
 * The `csv` bucket keeps its stored name and the RENDERER substitutes a message. « Import CSV » is
 * a phrase rather than a proper noun, and a localised string does not live in a database column:
 * this repository has one expensive instance of that rule, where « Compte import CSV » was ALSO the
 * bucket lookup key, so translating it would have orphaned every transaction in an English user's
 * first bucket. Same move `importProfileLabel` already makes: rendering only, never storage.
 */
export function displayNameForSource(source: string, current: string): string {
	return institutionForSource(source) ?? current;
}

/** The sources this backfill has a proper noun for, and therefore the only ones it renames. */
const NAMEABLE_SOURCES = ['banque_populaire', 'revolut'];

export interface StatementAccountBackfillOptions {
	prisma: PrismaClient;
	/** Test seam for the resume case; production uses the constant above. */
	batchSize?: number;
	onProgress?: (message: string) => void;
}

export interface StatementAccountBackfillResult {
	/** Accounts given an `institution`, and a `name` where the rename was free. */
	accountsNamed: number;
	/** Import batches filed into the account their own transactions already name. */
	batchesFiled: number;
}

function accountsPendingWhere() {
	return { source: { in: NAMEABLE_SOURCES }, institution: null };
}

/**
 * Batches with no account, EXCLUDING those that cannot be filed.
 *
 * A batch whose transactions have all been deleted has nothing to read an account from, and it
 * would otherwise keep this predicate true for ever: the boot gate would run a pass that writes
 * nothing on every start. Requiring at least one transaction is what makes the walk converge, and
 * it leaves the unfillable batch honestly null rather than filing it into an invented account.
 */
function batchesPendingWhere() {
	return { accountId: null, transactions: { some: {} } };
}

/** Gate for the boot path: is there anything to do at all? */
export async function hasPendingStatementAccounts(prisma: PrismaClient): Promise<boolean> {
	const account = await prisma.account.findFirst({
		where: accountsPendingWhere(),
		select: { id: true }
	});
	if (account !== null) return true;
	const batch = await prisma.importBatch.findFirst({
		where: batchesPendingWhere(),
		select: { id: true }
	});
	return batch !== null;
}

export async function runStatementAccountBackfill(
	options: StatementAccountBackfillOptions
): Promise<StatementAccountBackfillResult> {
	const { prisma, onProgress } = options;
	const batchSize = options.batchSize ?? ACCOUNT_BACKFILL_BATCH;
	let accountsNamed = 0;
	let batchesFiled = 0;

	// PASS 1: name the buckets whose source is a bank we can name.
	//
	// No cursor, for the reason `dedupeBackfill.ts` already states: a row leaves the pending set
	// the moment this loop writes it, so re-asking for the first N pending rows is correct
	// precisely because the set shrinks by exactly what each pass writes.
	for (;;) {
		const accounts = await prisma.account.findMany({
			where: accountsPendingWhere(),
			select: { id: true, userId: true, name: true, source: true },
			orderBy: { id: 'asc' },
			take: batchSize
		});
		if (accounts.length === 0) break;

		await prisma.$transaction(async (tx) => {
			for (const account of accounts) {
				const institution = institutionForSource(account.source);
				const desired = displayNameForSource(account.source, account.name);

				// The rename is only free if the name is not already taken under
				// `@@unique([userId, name, source])`. It can be taken: nothing stops a user from
				// having created an account called « Banque Populaire » by hand. Setting the
				// institution and LEAVING THE NAME is the honest outcome there, because the
				// alternative is either a crash at boot or a name this backfill invented to
				// dodge a collision.
				const taken =
					desired === account.name
						? null
						: await tx.account.findFirst({
								where: {
									userId: account.userId,
									name: desired,
									source: account.source,
									NOT: { id: account.id }
								},
								select: { id: true }
							});

				const name = taken === null ? desired : account.name;
				await tx.account.update({
					where: { id: account.id },
					data: { institution, name, nameKey: computeNameKey(name) }
				});
				accountsNamed += 1;
			}
		}, LONG_TRANSACTION_OPTIONS);

		// Asserted on the EFFECT rather than on the intent: counting the updates this pass issued
		// would count what it asked for, and a write that did not apply asks exactly the same.
		const stillPending = await prisma.account.count({
			where: { ...accountsPendingWhere(), id: { in: accounts.map((account) => account.id) } }
		});
		if (stillPending > 0) {
			throw new Error(
				`[statement-accounts] backfill stalled: ${stillPending} account(s) could not be named`
			);
		}

		// COUNTS ONLY. Never a name: an account name is the user's own words for their bank.
		onProgress?.(`${accountsNamed} account(s) named`);
	}

	// PASS 2: file each batch into the account its own transactions already name.
	for (;;) {
		const batches = await prisma.importBatch.findMany({
			where: batchesPendingWhere(),
			select: { id: true, transactions: { select: { accountId: true }, take: 1 } },
			orderBy: { id: 'asc' },
			take: batchSize
		});
		if (batches.length === 0) break;

		await prisma.$transaction(async (tx) => {
			for (const batch of batches) {
				const accountId = batch.transactions[0]?.accountId;
				if (accountId === undefined) continue;
				await tx.importBatch.update({ where: { id: batch.id }, data: { accountId } });
				batchesFiled += 1;
			}
		}, LONG_TRANSACTION_OPTIONS);

		const stillPending = await prisma.importBatch.count({
			where: { ...batchesPendingWhere(), id: { in: batches.map((batch) => batch.id) } }
		});
		if (stillPending > 0) {
			throw new Error(
				`[statement-accounts] backfill stalled: ${stillPending} batch(es) could not be filed`
			);
		}

		onProgress?.(`${batchesFiled} batch(es) filed`);
	}

	return { accountsNamed, batchesFiled };
}
