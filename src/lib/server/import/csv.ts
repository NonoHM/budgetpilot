import { resolveProfile } from './registry';
import type {
	CsvImportOptions,
	CsvImportProfile,
	CsvImportResult,
	CsvImportSummary,
	CsvInvalidRow,
	ImportedTransaction,
	ImportedTransactionMetadata,
	ImportedTransactionType,
	ParsedCsvRow,
	ResolvedCsvImportProfile
} from './types';
import { emptyResult, normalizeParsedRows, parseRows } from './utils/csv';
export { sanitizeImportedText } from './utils/safety';
export type {
	CsvImportOptions,
	CsvImportProfile,
	CsvImportResult,
	CsvImportSummary,
	CsvInvalidRow,
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
		return emptyResult([`CSV trop volumineux (${sizeBytes} octets)`], []);
	}

	return parseImportRows(parseRows(content), options);
}

export function parseCsvTransactionRows(
	rows: ParsedCsvRow[],
	options: CsvImportOptions = {}
): CsvImportResult {
	return parseImportRows(rows, options);
}

export function parseImportRows(
	rows: ParsedCsvRow[],
	options: CsvImportOptions = {}
): CsvImportResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
	const normalizedRows = normalizeParsedRows(rows);

	if (normalizedRows.length < 2) return emptyResult(['CSV vide ou sans données'], warnings);
	if (normalizedRows.length - 1 > maxRows)
		return emptyResult([`CSV limité à ${maxRows} lignes`], warnings);

	const requestedProfile = options.profile ?? 'auto';
	const parser = resolveProfile(normalizedRows[0].cells, requestedProfile);
	if (!parser) {
		const profileLabel = requestedProfile === 'auto' ? 'CSV' : profileErrorLabel(requestedProfile);
		return emptyResult(
			[`En-tête ${profileLabel} non reconnu`],
			warnings,
			resultProfile(requestedProfile)
		);
	}

	return parser.parse({
		rows: normalizedRows,
		errors,
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
