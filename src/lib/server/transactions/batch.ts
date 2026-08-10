import { prisma } from '$lib/server/db';
import type { Prisma } from '../database/types.ts';

/**
 * Bounds how many parent rows one `findMany` may fetch when its `select` can carry a to-many
 * relation (currently only `splits`, via EFFECTIVE_CATEGORY_SELECT — see nature.ts). Prisma
 * resolves a to-many with a SECOND query carrying one host parameter per parent row
 * (`WHERE transactionId IN (?, ?, …)`), and SQLite refuses a query once its parameter count is
 * exceeded.
 *
 * MEASURED, not assumed: against this schema, on SQLite, `findMany` with EFFECTIVE_CATEGORY_SELECT
 * passes at `take=997` and fails at `take=998` with
 * `PrismaClientKnownRequestError: ... The query parameter limit supported by your database is
 * exceeded.` (see parameterLimit.db-smoke.ts, which reproduces both sides of that boundary). The identical
 * select minus `splits` never failed up to `take=2000` — the cap only exists because of the
 * to-many join.
 *
 * 500 is chosen with margin under the measured 997/998 boundary — a different SQLite build could
 * plausibly ship a lower SQLITE_MAX_VARIABLE_NUMBER than this one's — and is trivially safe on the
 * other two providers: PostgreSQL allows 32 767 host parameters per query and MariaDB 65 535, so a
 * batch this size costs those two engines nothing but an extra round trip they can easily afford.
 * This is a single conservative constant rather than a per-provider one for that reason: SQLite is
 * the only engine where the number is load-bearing, and 500 clears its boundary by roughly 2x.
 */
const DEFAULT_BATCH_SIZE = 500;

export interface ForEachTransactionBatchOptions {
	batchSize?: number;
	/** Direction for BOTH orderBy keys (date, then id). Default 'desc' matches every pre-existing
	 *  caller of this function; pass 'asc' only when a caller's own contract requires it. */
	order?: 'asc' | 'desc';
}

/**
 * Cursor-paginated scan over prisma.transaction rows matching `where`, for callers that need
 * JS-side evaluation (rule matching, label search) which cannot be expressed in SQL — avoids
 * loading the full per-user history into memory at once (see CLAUDE.md technical debt:
 * rawForClassify without take). Ordered by (date, id), both in the same direction, so the cursor
 * is stable across batches even when many rows share the same date.
 *
 * `onBatch` is called once per batch; return `false` from it to stop early.
 *
 * The batch size is also the bound described at DEFAULT_BATCH_SIZE above: every caller of this
 * function shares that cap, whether or not its own `select` currently carries `splits`, so a
 * `select` gaining that relation later is protected without anyone having to remember to lower a
 * batch size at the new call site.
 *
 * The 4th argument accepts a bare `number` as well as `ForEachTransactionBatchOptions`, purely so
 * every pre-existing caller passing a raw batch size keeps compiling unchanged; new callers that
 * also need `order` pass the options form.
 *
 * THE MEMORY CLAIM IN THE FIRST PARAGRAPH IS ABOUT THIS FUNCTION AND NOT ABOUT
 * `collectAllTransactions` BELOW, which accumulates the whole result set by design. A reader who
 * follows that helper's "see its docstring" pointer up here must not take the memory bound with
 * them: what the helper inherits is the QUERY WIDTH bound, and nothing else. The three reads
 * converted to it hold exactly what they held before.
 */
export async function forEachTransactionBatch<Select extends Prisma.TransactionSelect>(
	where: Prisma.TransactionWhereInput,
	select: Select,
	onBatch: (rows: Array<Prisma.TransactionGetPayload<{ select: Select }>>) => void | false,
	options: number | ForEachTransactionBatchOptions = {}
): Promise<void> {
	const { batchSize = DEFAULT_BATCH_SIZE, order = 'desc' } =
		typeof options === 'number' ? { batchSize: options, order: undefined } : options;
	let cursor: { date: Date; id: string } | undefined;

	for (;;) {
		const rows = await prisma.transaction.findMany({
			where,
			select: { ...select, date: true, id: true } as Select,
			orderBy: [{ date: order }, { id: order }],
			take: batchSize,
			...(cursor
				? {
						cursor: { id: cursor.id },
						skip: 1
					}
				: {})
		});

		if (rows.length === 0) return;

		const result = onBatch(rows as Array<Prisma.TransactionGetPayload<{ select: Select }>>);
		if (result === false) return;

		if (rows.length < batchSize) return;
		// `date` is carried for readability at the assignment and is deliberately NOT passed to
		// Prisma: `cursor: { id }` names a ROW, and Prisma reads that row's own ordering values back
		// out of it, so restating the date would be a second source of truth for the same position.
		// Written down because the pair reads like a compound cursor and is not one, and the obvious
		// "fix" is to start passing both.
		const last = rows[rows.length - 1] as { date: Date; id: string };
		cursor = { date: last.date, id: last.id };
	}
}

/**
 * Collects every `where`-matching row into one array, for callers that need the whole set
 * materialized (a CSV dump, a per-category aggregate over a date range) rather than a callback
 * per batch. Never issues a query wider than forEachTransactionBatch's own cap — see its
 * docstring — so a `select` spreading EFFECTIVE_CATEGORY_SELECT is safe here regardless of how
 * many rows `where` matches.
 */
export async function collectAllTransactions<Select extends Prisma.TransactionSelect>(
	where: Prisma.TransactionWhereInput,
	select: Select,
	options: ForEachTransactionBatchOptions = {}
): Promise<Array<Prisma.TransactionGetPayload<{ select: Select }>>> {
	const rows: Array<Prisma.TransactionGetPayload<{ select: Select }>> = [];
	await forEachTransactionBatch(
		where,
		select,
		(batch) => {
			rows.push(...batch);
		},
		options
	);
	return rows;
}
