import { importColumnCells } from './columnDateState';
import { currencyOfCell, isCurrencyCodeCell } from './currencyDeclaration';
import type { ColumnMappingInput } from './mapping/model';
import type { ParsedCsvRow } from './types';

/**
 * #1213: WHICH COLUMNS OF A HEADERLESS FILE READ AS A CURRENCY, by index, in file order.
 *
 * Owner ruling of 2026-11-04: a column whose every non-empty value is an ISO 4217 code EXHIBITS a
 * currency, so the screen asks rather than filing the rows under the account's currency. The file
 * then shows the ambiguity without proving the answer (AGENTS.md, « a property that changes how
 * values are read »: ask). At least one non-empty value, so a blank column exhibits nothing.
 *
 * The one detector: `columnProposals` prefills the Currency role from it and `/import/columns` asks
 * from it, so the screen and the door cannot disagree about which column is a currency.
 *
 * Line 1 is data, always: a file with a header row declares its currency by name.
 */
export function currencyCodeColumns(rows: ParsedCsvRow[]): number[] {
	return importColumnCells(rows, false).flatMap((cells, index) => {
		// Blank as the declaration reads blank (`currencyOfCell`), invisible characters included: a
		// zero-width space counted as filled hid the column, and its rows were stored in the account's
		// currency (#1213 code pass A, finding 2).
		const filled = cells.filter((cell) => currencyOfCell(cell) !== null);
		return filled.length > 0 && filled.every(isCurrencyCodeCell) ? [index] : [];
	});
}

/**
 * The member's answer to « which column is the currency », as posted (`currencyIndex`).
 *
 * - `designated`: a decimal index of this file, held by no other role. That column is the file's
 *   declaration, read exactly as a `currency` header is.
 * - `declined`: the literal `none`, posted only by « No currency column ». The account's currency
 *   applies, because the member said so.
 * - `absent`: nothing posted, or an empty field. Nobody answered, so a detected column is asked.
 * - `invalid`: anything else. Refused, never coerced (ASVS v5.0.0-2.2.1).
 */
export type CurrencyAnswer =
	| { kind: 'designated'; index: number }
	| { kind: 'declined' }
	| { kind: 'absent' }
	| { kind: 'invalid' };

export function readCurrencyAnswer(
	raw: FormDataEntryValue | null,
	mapping: Pick<
		ColumnMappingInput,
		'dateIndex' | 'labelIndex' | 'amountIndex' | 'categoryIndex' | 'columnCount'
	>
): CurrencyAnswer {
	if (raw === null || raw === '') return { kind: 'absent' };
	if (raw === 'none') return { kind: 'declined' };
	// Same grammar as `parseIndex` in `designation.ts`: decimal digits only, so `3abc`, `-1`, `0x3`
	// and ` 3` are refused rather than read.
	if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return { kind: 'invalid' };
	const index = Number(raw);
	if (!Number.isSafeInteger(index) || index >= mapping.columnCount) return { kind: 'invalid' };
	const held = [mapping.dateIndex, mapping.labelIndex, mapping.amountIndex, mapping.categoryIndex];
	return held.includes(index) ? { kind: 'invalid' } : { kind: 'designated', index };
}
