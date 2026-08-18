import * as m from '$lib/paraglide/messages';
import type { ImportInvalidRowDetail } from '$lib/domain/importSummary';
import type { parseCsvTransactionRows } from './csv';
import { anonymizeImportCell } from './persist';

// Re-exported so callers that build the details can name their element type from one import.
export type { ImportInvalidRowDetail };

/** The rejected rows a summary shows in full. The remainder are counted, not listed. */
export const INVALID_ROW_DETAIL_LIMIT = 20;

/**
 * The rejected rows, shaped for the summary panel.
 *
 * ## Why this is shared rather than private to one route
 *
 * It was private to `/import` while `/import/columns` returned a summary without it. So the one
 * import path where the user had just chosen the columns by hand was also the only one that could
 * not say which rows those choices rejected — a partial import reported as a bare number, on the
 * run that also memorises the mapping. « The same summary every route shows » is a property of the
 * payload rather than of the panel that draws it, so the payload is built in one place. See #338.
 */
export function buildInvalidRowDetails(
	previewRowsByLine: Record<number, string[]>,
	result: ReturnType<typeof parseCsvTransactionRows>
): ImportInvalidRowDetail[] {
	return result.invalidRows.slice(0, INVALID_ROW_DETAIL_LIMIT).map((row, index) => ({
		key: index,
		scope: row.scope,
		fact: row.fact,
		field: row.field,
		profile: result.summary.profile,
		// Only a row scoped refusal has a row to preview. A header or file scoped one gets an
		// empty preview rather than `anonymizeCsvRowPreview([])`, which returns « ligne vide »
		// and would assert the file had an empty line there. Before #291 these carried invented
		// lines and so pulled a real transaction's cells into a complaint about the header.
		preview:
			row.scope.kind === 'row'
				? anonymizeCsvRowPreview(previewRowsByLine[row.scope.line] ?? [])
				: ''
	}));
}

/**
 * How many refusals the list above dropped, counted from the LIST it was sliced from.
 *
 * It used to be computed from `summary.invalidRows`, which is now a count of refused ROWS while
 * this list holds every refusal including the ones scoped to the file. Two populations, one
 * subtraction: on a file refused for three missing roles the summary counter is zero and the
 * remainder would have gone negative before the clamp hid it.
 */
export function getHiddenInvalidRowsCount(refusalCount: number): number {
	return Math.max(0, refusalCount - INVALID_ROW_DETAIL_LIMIT);
}

function anonymizeCsvRowPreview(cells: string[]): string {
	const preview = cells
		.map((cell) => anonymizeImportCell(cell))
		.filter(Boolean)
		.slice(0, 8)
		.join(' | ');

	// Through the catalogue, not as a literal. This string is rendered straight into the invalid
	// rows table, so a hardcoded French one is the same defect the refusal contract removes from
	// the parsers, one layer out: an English user was shown French. The French output is
	// unchanged, byte for byte.
	return preview || m.import_invalid_preview_empty();
}
