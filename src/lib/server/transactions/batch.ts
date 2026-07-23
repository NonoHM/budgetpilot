import { prisma } from '$lib/server/db';
import type { Prisma } from '@prisma/client';

const DEFAULT_BATCH_SIZE = 1000;

/**
 * Cursor-paginated scan over prisma.transaction rows matching `where`, for callers that need
 * JS-side evaluation (rule matching, label search) which cannot be expressed in SQL — avoids
 * loading the full per-user history into memory at once (see CLAUDE.md technical debt:
 * rawForClassify without take). Ordered by (date desc, id desc) so the cursor is stable across
 * batches even when many rows share the same date.
 *
 * `onBatch` is called once per batch; return `false` from it to stop early.
 */
export async function forEachTransactionBatch<Select extends Prisma.TransactionSelect>(
	where: Prisma.TransactionWhereInput,
	select: Select,
	onBatch: (rows: Array<Prisma.TransactionGetPayload<{ select: Select }>>) => void | false,
	batchSize: number = DEFAULT_BATCH_SIZE
): Promise<void> {
	let cursor: { date: Date; id: string } | undefined;

	for (;;) {
		const rows = await prisma.transaction.findMany({
			where,
			select: { ...select, date: true, id: true } as Select,
			orderBy: [{ date: 'desc' }, { id: 'desc' }],
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
		const last = rows[rows.length - 1] as { date: Date; id: string };
		cursor = { date: last.date, id: last.id };
	}
}
