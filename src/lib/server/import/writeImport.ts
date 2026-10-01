import { describeErrorForLog } from '$lib/server/errors';
import { DeclaredCurrencyMismatchError, type DeclaredCurrencyMismatch } from './declaredCurrency';
import {
	createImportBatchRow,
	deleteEmptyImportBatch,
	ImportWriteError,
	persistImportedTransactions,
	type CreateImportBatchInput,
	type PersistImportedTransactionsResult
} from './persist';
import type { ImportedTransaction } from './types';

/**
 * What a screen may say about a failed write, and nothing more (#662).
 *
 * The four members are four DIFFERENT pieces of advice, which is why they are not one « the import
 * failed ». The write is not one transaction (`persistImportedTransactions` records why), so a
 * failure can leave rows in the ledger, and the advice for « nothing landed » (try again) is wrong
 * for « some landed » (delete the import first, or the retry files the rest beside a partial
 * batch). `maybe-saved` is the member for not knowing, and it is where anything unrecognised goes:
 * a classifier that defaulted to « nothing » would claim what nobody checked.
 *
 * `partly-saved` carries the batch's `createdAt` as an ISO instant: the sentence names WHICH import
 * to delete by the timestamp `/imports` names it by (`CONTEXT.md`, « Import »), and it is formatted
 * where it is rendered, by the history's own function, so the two read identically in the reader's
 * time zone. Never a formatted string from here.
 */
export type ImportWriteRefusal =
	| { kind: 'currency'; fact: DeclaredCurrencyMismatch }
	| { kind: 'nothing-saved' }
	| { kind: 'partly-saved'; landedRows: number; createdAt: string }
	| { kind: 'maybe-saved' };

export type ImportWriteOutcome =
	| { ok: true; batchId: string; persisted: PersistImportedTransactionsResult }
	| { ok: false; failure: ImportWriteRefusal };

/**
 * Maps what the write step threw to what may be said about it. Pure, and total. `batchCreatedAt`
 * is the batch the rows were filed under, named by a partial failure.
 */
export function classifyWriteFailure(caught: unknown, batchCreatedAt: Date): ImportWriteRefusal {
	if (caught instanceof DeclaredCurrencyMismatchError)
		return { kind: 'currency', fact: caught.fact };
	if (caught instanceof ImportWriteError) {
		if (caught.failure.kind === 'not-found') return { kind: 'nothing-saved' };
		const { landedRows } = caught.failure;
		if (landedRows === null) return { kind: 'maybe-saved' };
		return landedRows === 0
			? { kind: 'nothing-saved' }
			: { kind: 'partly-saved', landedRows, createdAt: batchCreatedAt.toISOString() };
	}
	return { kind: 'maybe-saved' };
}

/**
 * The write step of both import routes: the batch, then its rows. One function because `/import`
 * and `/import/columns` performed the same two calls with no catch around either, and a translation
 * written twice is the one that drifts (#662).
 *
 * It RETURNS a failure rather than throwing one, so a route cannot forget to catch it: the type of
 * the result makes the failure branch something the caller has to read before it can reach
 * `batchId`. ASVS v5.0.0-16.5.3: nothing after a failure proceeds as if the import had happened,
 * because the success fields do not exist on that branch.
 */
export async function writeImport(input: {
	batch: CreateImportBatchInput;
	transactions: ImportedTransaction[];
	parseDuplicateRows: number;
}): Promise<ImportWriteOutcome> {
	let batchId: string;
	let batchCreatedAt: Date;
	try {
		({ id: batchId, createdAt: batchCreatedAt } = await createImportBatchRow(input.batch));
	} catch (caught) {
		// Before the batch exists no row can be filed under it, so « nothing » is known here even
		// for an error this module does not recognise. It is the only place that holds.
		logWriteFailure(caught, 'batch');
		return { ok: false, failure: { kind: 'nothing-saved' } };
	}

	try {
		const persisted = await persistImportedTransactions({
			userId: input.batch.userId,
			accountId: input.batch.accountId,
			importBatchId: batchId,
			source: input.batch.source,
			transactions: input.transactions,
			parseDuplicateRows: input.parseDuplicateRows
		});
		return { ok: true, batchId, persisted };
	} catch (caught) {
		const failure = classifyWriteFailure(caught, batchCreatedAt);
		// The currency backstop is a refusal the route states in full, not a fault to report.
		if (failure.kind !== 'currency') logWriteFailure(caught, 'rows');
		// NOTHING LANDED, KNOWN: the batch holds no rows, so it goes. Left in place it reads
		// « Importé 0 » in `/imports`, one more each time the user follows « Réessayez ». Not for
		// `partly-saved` (it holds rows, and deleting them is the user's decision the sentence names)
		// nor for `maybe-saved` (nobody knows what it holds). Best effort: a database that just failed
		// the write may fail this too, and the batch then honestly shows what it holds, which is 0.
		if (failure.kind === 'nothing-saved' || failure.kind === 'currency') {
			try {
				await deleteEmptyImportBatch(input.batch.userId, batchId);
			} catch (cleanup) {
				logWriteFailure(cleanup, 'cleanup');
			}
		}
		return { ok: false, failure };
	}
}

/**
 * An operator's only trace of a failed import, now that the throw no longer reaches SvelteKit's
 * default handler, which printed the whole error.
 *
 * NAMES AND CODES ONLY, never a message. A Prisma message can quote the arguments of the failed
 * call, which on this path are a user's transactions, and AGENTS.md forbids logging banking data.
 * The name and a short code (`P2003`, a SQLSTATE) are what an operator looks up; neither can carry
 * a label or an amount.
 * The rule itself is `describeErrorForLog` in server/errors.ts, shared with the error hook and the
 * last-resort handler (#816); this was its first copy.
 */
function logWriteFailure(caught: unknown, stage: 'batch' | 'rows' | 'cleanup'): void {
	const failure = caught instanceof ImportWriteError ? caught.failure : null;
	const cause = caught instanceof ImportWriteError ? caught.cause : caught;
	console.error(
		`[import] write step failed at ${stage}: ${describeErrorForLog(caught)}` +
			(failure?.kind === 'failed' ? ` landedRows=${failure.landedRows ?? 'unknown'}` : '') +
			(cause !== caught ? ` cause=${describeErrorForLog(cause)}` : '')
	);
}
