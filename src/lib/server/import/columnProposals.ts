import { EMPTY_ASSIGNMENT, type ColumnProposals } from '$lib/domain/columnDesignation';
import type { MappingRole } from '$lib/domain/mappingRoles';
import { columnDateState, importColumnCells } from './columnDateState';
import {
	REQUIRED_COLUMN_ALIASES,
	REQUIRED_ROLES,
	type RequiredRole
} from './profiles/columnAliases';
import type { ParsedCsvRow } from './types';
import { foldComparableHeader } from './utils/encoding';
import { isDateCellUnderEitherReading, normalizeParsedRows } from './utils/csv';
import { parseAmountCents } from './utils/money';

/**
 * « Valeurs analysables »: EVERY non-empty cell parses for the role, and one exists. Stricter than
 * `columnDateState`'s `proven-shape`, which one date satisfies: a designation the member may confirm
 * unread has to hold for the whole column, so a trailer line in it stops the designation.
 *
 * A date column must also settle its own order: `ambiguous` (every cell reads both ways) is not
 * « l'univoque », and a seeded one reached the submit with the reading question never asked, which
 * the server read day-first in silence until #1200 made it refuse. Proposed instead, so opening it
 * asks (#352).
 */
const SETTLED_DATE_STATES: readonly string[] = ['proven-day', 'proven-month', 'proven-shape'];
const settles: Record<RequiredRole, (values: readonly string[]) => boolean> = {
	date: (values) => SETTLED_DATE_STATES.includes(columnDateState(values)),
	label: () => true,
	amount: () => true
};
const parses: Record<RequiredRole, (values: readonly string[]) => boolean> = {
	date: (values) => values.every((value) => isDateCellUnderEitherReading(value)),
	label: () => true,
	amount: (values) => values.every((value) => parseAmountCents(value) !== null)
};

/**
 * Arbitration B3 (#352, plate « nom sans ambiguïté et valeurs analysables »): a role is designated
 * only where its header names exactly ONE column whose values parse; two named columns are both
 * proposed and neither designated; a value shape alone proposes for date and amount, never for the
 * label, which every text column would satisfy. Header names count only when line 1 is headers.
 *
 * Columns are counted by INDEX, not by alias: `resolveRequiredColumns` counts aliases, so two
 * columns both headed `Montant` are one alias there and two equal columns here.
 *
 * Pure function of `(rows, hasHeaderRow)`, like every other designation row fact.
 */
export function columnProposals(rows: ParsedCsvRow[], hasHeaderRow: boolean): ColumnProposals {
	const columns = importColumnCells(rows, hasHeaderRow).map((cells) =>
		cells.filter((cell) => cell.trim() !== '')
	);
	const headers = hasHeaderRow
		? (normalizeParsedRows(rows)[0]?.cells ?? []).map((header) => foldComparableHeader(header))
		: [];

	const designated: Record<MappingRole, number | null> = { ...EMPTY_ASSIGNMENT };
	const candidates: Record<MappingRole, number[]> = {
		date: [],
		label: [],
		amount: [],
		category: []
	};

	for (const role of REQUIRED_ROLES) {
		const aliases: readonly string[] = REQUIRED_COLUMN_ALIASES[role];
		const valid = (index: number) => columns[index].length > 0 && parses[role](columns[index]);
		const named = headers.flatMap((header, index) => (aliases.includes(header) ? [index] : []));

		if (named.length === 1 && valid(named[0]) && settles[role](columns[named[0]]))
			designated[role] = named[0];
		candidates[role] =
			named.length > 0 || role === 'label'
				? named
				: columns.flatMap((_, index) => (valid(index) ? [index] : []));
	}

	return { designated, candidates };
}
