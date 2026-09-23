import { resolveCsvMaxColumns } from './columnBounds';

/**
 * The RESOURCE CEILING, which is a different rule from the product limit beside it.
 *
 * ## Two rules, not one rule with two sentences
 *
 * `resolveCsvMaxColumns()` and `CSV_MAX_ROWS` are a PRODUCT limit: user-facing, actionable, and
 * rendered through the message catalogue as « CSV limited to {max} rows ». A user meets it, and
 * can do something about it.
 *
 * This is a RESOURCE ceiling. No real file reaches it. Its refusal exists so that an oversized
 * array is never allocated, not to explain anything to anybody, which is why it stays a generic
 * `ImportFileError` and is deliberately NOT ported into the catalogue. Two definitions of one rule
 * is the defect this repository refuses; two rules with two sentences is correct.
 *
 * What the two share is an ORDER, and that order is the thing that can break: if the ceiling ever
 * sank to or below the product limit, it would start refusing files the product says are legal and
 * the user would meet the wrong sentence for a legal file. So the ceiling is DERIVED from the limit
 * rather than written as a second number, which makes the ordering true by construction, and
 * `resourceBounds.spec.ts` asserts it anyway at both configurable extremes.
 *
 * ## Why two ceilings and not one
 *
 * MEASURED 2026-09-11, in process, against the real `detectSplitAmountPair`:
 *
 * - The consumers that walk every cell are LINEAR in `columns x rows`, so a CELL ceiling bounds
 *   them. At 5e8 cells the cost was 32,876 ms and +1,575 MB of heap.
 * - The pair walk is QUADRATIC in columns at a fixed cell count, so a cell ceiling alone leaves it
 *   unbounded: holding cells at the byte-imposed 170,666, the walk runs ~76 ms at 512 columns and
 *   ~19,000 ms at 128,000 columns. Columns therefore need a bound of their own.
 *
 * A file's byte count does not bound either usefully: 206,000 bytes of sparse CSV buys 3e8 cells.
 */
/**
 * The product limit on data rows: user-facing, actionable, and the number the friendly
 * `too-many-rows` refusal names. It lives HERE beside the ceiling rather than in `csv.ts`, because
 * the ceiling is derived from it and the two are only correct in relation to each other. One module
 * owns both numbers and the order between them.
 */
export const CSV_MAX_ROWS = 1_000;

export const CSV_RESOURCE_CEILING_MULTIPLE = 10;

/** An order of magnitude above whatever column limit is configured. */
export function resolveCsvColumnResourceCeiling(): number {
	return resolveCsvMaxColumns() * CSV_RESOURCE_CEILING_MULTIPLE;
}

/** An order of magnitude above the largest cell count the product limits allow. */
export function resolveCsvCellResourceCeiling(): number {
	return resolveCsvMaxColumns() * CSV_MAX_ROWS * CSV_RESOURCE_CEILING_MULTIPLE;
}

/**
 * Whether these dimensions are past the ceiling, checked BEFORE the rows reach any consumer.
 *
 * Both dimensions are attacker chosen, so both are inspected. A guard only protects what it
 * inspects, and this session exists because three caps fired and the expensive work ran anyway.
 */
export function exceedsCsvResourceCeiling(dimensions: { columns: number; rows: number }): boolean {
	if (dimensions.columns > resolveCsvColumnResourceCeiling()) return true;
	return dimensions.columns * dimensions.rows > resolveCsvCellResourceCeiling();
}

/**
 * Whether these dimensions are past the PRODUCT limit, which is the user-facing rule.
 *
 * `parseImportRows` does not call this: it needs to know WHICH bound was exceeded so it can emit
 * the matching refusal fact, and it counts rows against the user's own `hasHeaderRow` answer. What
 * this gives the doors that never reach the parser is the same two NUMBERS rather than a second
 * spelling of them. `/import/accounts` reads a file and never parses transactions, so without this
 * it had no product limit at all.
 */
export function exceedsCsvProductLimit(dimensions: { columns: number; rows: number }): boolean {
	return dimensions.columns > resolveCsvMaxColumns() || dimensions.rows > CSV_MAX_ROWS;
}
