import { MAPPING_ROLES, type MappingRole } from './mappingRoles';

/**
 * One remembered correspondance, reduced to what a settings row has to say about it.
 *
 * Pure, and separate from the store, because the interesting half is a presentation decision with
 * a correctness consequence: **a positional mapping has no column names to show.** Deciding that
 * inside the markup would put the app's riskiest mapping state behind an `{#if}` nobody can test
 * without rendering a page.
 */
export interface RememberedMappingSource {
	id: string;
	matchBy: string;
	dateColumn: string | null;
	labelColumn: string | null;
	amountColumn: string | null;
	categoryColumn: string | null;
	dateIndex: number | null;
	labelIndex: number | null;
	amountIndex: number | null;
	categoryIndex: number | null;
	columnCount: number;
	useCount: number;
	lastUsedAt: Date | null;
	createdAt: Date;
	importBatchCount: number;
}

export interface RememberedMappingView {
	id: string;
	/**
	 * `'name'` when the row can name its columns, `'position'` when it cannot.
	 *
	 * A stored `matchBy` this code does not recognise resolves to `'position'`, NOT to `'name'`.
	 * A malformed record must fall to the state that shows the WEAKER claim: `'name'` would print
	 * whatever happened to be in `dateColumn` as though it were verified, and those fields are null
	 * on a positional row, so the row would render four blanks and read as an empty correspondance.
	 */
	matchBy: 'name' | 'position';
	/** Role → the column it names. Empty for a positional mapping, which names nothing. */
	columns: Partial<Record<MappingRole, string>>;
	/** Role → the index it holds. Empty for a name-matched mapping. */
	indices: Partial<Record<MappingRole, number>>;
	columnCount: number;
	useCount: number;
	lastUsedAt: Date | null;
	createdAt: Date;
	/**
	 * How many imports still point at this correspondance.
	 *
	 * Rendered in the confirmation rather than the row, because it is the consequence of the
	 * deletion rather than a property of the mapping: those batches keep their transactions and
	 * lose the link that lets `/imports` reopen the columns.
	 */
	importBatchCount: number;
}

function columnOf(source: RememberedMappingSource, role: MappingRole): string | null {
	if (role === 'date') return source.dateColumn;
	if (role === 'label') return source.labelColumn;
	if (role === 'amount') return source.amountColumn;
	return source.categoryColumn;
}

function indexOf(source: RememberedMappingSource, role: MappingRole): number | null {
	if (role === 'date') return source.dateIndex;
	if (role === 'label') return source.labelIndex;
	if (role === 'amount') return source.amountIndex;
	return source.categoryIndex;
}

export function rememberedMappingView(source: RememberedMappingSource): RememberedMappingView {
	const matchBy = source.matchBy === 'name' ? 'name' : 'position';
	const columns: Partial<Record<MappingRole, string>> = {};
	const indices: Partial<Record<MappingRole, number>> = {};

	for (const role of MAPPING_ROLES) {
		if (matchBy === 'name') {
			const column = columnOf(source, role);
			// An EMPTY string is not a name. It is what a malformed row carries, and rendering it
			// would draw a role with a blank beside it that reads as a column called nothing.
			if (column !== null && column.trim() !== '') columns[role] = column;
			continue;
		}
		const index = indexOf(source, role);
		if (index !== null && Number.isInteger(index) && index >= 0) indices[role] = index;
	}

	return {
		id: source.id,
		matchBy,
		columns,
		indices,
		columnCount: source.columnCount,
		useCount: source.useCount,
		lastUsedAt: source.lastUsedAt,
		createdAt: source.createdAt,
		importBatchCount: source.importBatchCount
	};
}
