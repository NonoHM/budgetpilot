import { resolveProfile } from './registry';
import { parseMappedRows } from './profiles/mapped';
import type {
	CsvImportOptions,
	CsvImportProfile,
	CsvImportResult,
	CsvImportSummary,
	ImportedTransaction,
	ImportedTransactionMetadata,
	ImportedTransactionType,
	ParsedCsvRow,
	ResolvedCsvImportProfile
} from './types';
import { emptyResult, normalizeParsedRows, parseRows } from './utils/csv';
import { resolveCsvMaxColumns } from './columnBounds';
export { sanitizeImportedText } from './utils/safety';
export type {
	CsvImportOptions,
	CsvImportProfile,
	CsvImportResult,
	CsvImportSummary,
	ImportedTransaction,
	ImportedTransactionMetadata,
	ImportedTransactionType
};

const DEFAULT_MAX_BYTES = 256_000;
const DEFAULT_MAX_ROWS = 1_000;

export function parseCsvTransactions(
	content: string,
	options: CsvImportOptions = {}
): CsvImportResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const sizeBytes = new TextEncoder().encode(content).length;

	if (sizeBytes > maxBytes) {
		return emptyResult([{ code: 'file-too-large', bytes: sizeBytes }], []);
	}

	return parseImportRows(parseRows(content), options);
}

export function parseCsvTransactionRows(
	rows: ParsedCsvRow[],
	options: CsvImportOptions = {}
): CsvImportResult {
	return parseImportRows(rows, options);
}

/**
 * The header cells a parse of these rows will actually see.
 *
 * Exported so the route can fingerprint the SAME bytes the parser resolves against. Reading
 * `rows[0].cells` directly is one BOM away from a fingerprint that never matches the mapping it
 * just wrote, and the symptom would be "it forgets my designation", with nothing to point at.
 */
export function importHeaderCells(rows: ParsedCsvRow[]): string[] {
	const normalized = normalizeParsedRows(rows);
	return normalized.length === 0 ? [] : normalized[0].cells;
}

export function parseImportRows(
	rows: ParsedCsvRow[],
	options: CsvImportOptions = {}
): CsvImportResult {
	const warnings: string[] = [];
	const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
	const normalizedRows = normalizeParsedRows(rows);

	if (normalizedRows.length < 2) return emptyResult([{ code: 'file-empty' }], warnings);
	if (normalizedRows.length - 1 > maxRows)
		return emptyResult([{ code: 'too-many-rows', max: maxRows }], warnings);

	// Beside the row cap and BEFORE profile resolution: the column count is a property of the
	// file, so the answer must not depend on which profile happened to match. See
	// columnBounds.ts for why the parser does not need this and the designation screen does.
	const maxColumns = options.maxColumns ?? resolveCsvMaxColumns();
	if (normalizedRows[0].cells.length > maxColumns)
		return emptyResult([{ code: 'too-many-columns', max: maxColumns }], warnings);

	const requestedProfile = options.profile ?? 'auto';

	// Routed here rather than through `csvProfileParsers`, because this profile is chosen by a row
	// in the database rather than by the header line. Keeping it out of the registry is what makes
	// "a mapping is never auto-detected" structural: registered after `generic`, whose match
	// returns true for everything, it would be unreachable today and reachable the day somebody
	// reorders that list, with nothing able to tell the difference. See `profiles/mapped.ts`.
	if (requestedProfile === 'mapped') {
		return parseMappedRows({
			rows: normalizedRows,
			warnings,
			sourceName: options.sourceName,
			categorizationRules: options.categorizationRules ?? [],
			columnMapping: options.columnMapping
		});
	}

	const parser = resolveProfile(normalizedRows[0].cells, requestedProfile);
	if (!parser) {
		const profileLabel = requestedProfile === 'auto' ? 'CSV' : profileErrorLabel(requestedProfile);
		return emptyResult(
			[{ code: 'header-not-recognized', profile: profileLabel }],
			warnings,
			resultProfile(requestedProfile)
		);
	}

	return parser.parse({
		rows: normalizedRows,
		warnings,
		sourceName: options.sourceName,
		categorizationRules: options.categorizationRules ?? []
	});
}

function profileErrorLabel(profile: CsvImportProfile): string {
	if (profile === 'banque-populaire') return 'Banque Populaire';
	if (profile === 'revolut') return 'Revolut';
	return 'CSV';
}

function resultProfile(profile: CsvImportProfile): ResolvedCsvImportProfile {
	return profile === 'auto' ? 'generic' : profile;
}
