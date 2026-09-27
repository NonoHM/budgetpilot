/**
 * THE imported count a screen shows for an import: the rows filed under the batch NOW.
 *
 * One definition, read by every screen that names how many transactions an import brought in
 * (`/imports`, and the correction confirmation on `/import`), because a verdict recomputed from the
 * ledger cannot disagree with it, while a counter frozen in a column can (#660).
 *
 * ## Why not `ImportBatch.importedRows`
 *
 * The write step reads that counter back from the ledger since D3, and it still cannot be trusted
 * for display: a lost connection fails the counter write together with the row that died (the
 * `landedRows: null` branch of `persistImportedTransactions`), every batch damaged before D3 keeps
 * its `@default(0)`, and a restore copies the counter exactly as it was exported
 * (`backup/import.ts`). Each of those leaves « Importé 0 » over rows that are in the ledger.
 *
 * ## What the stored counter still means
 *
 * What the write step recorded when the import finished or stopped: a fact about that moment, kept
 * for the backup round trip and read by no screen. The count here is a verdict on the present, so
 * it moves when the user deletes one of the import's transactions by hand, which is what the history
 * should show: the rows this import holds.
 *
 * Selected with the batch (`IMPORTED_COUNT_SELECT`) rather than counted separately, so a list of
 * fifty imports costs one query, and the relation aggregate counts what `Transaction.importBatchId`
 * says, which is the same relation the import's delete removes.
 */
export const IMPORTED_COUNT_SELECT = { _count: { select: { transactions: true } } } as const;

export function importedCountOf(batch: { _count: { transactions: number } }): number {
	return batch._count.transactions;
}
