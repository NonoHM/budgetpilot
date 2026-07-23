import { isValidIsoDate } from '$lib/domain/transaction';
import type {
	CsvImportResult,
	CsvImportSummary,
	CsvInvalidRow,
	ParsedCsvRow,
	ResolvedCsvImportProfile
} from '../types';
import { normalizeHeaderName, normalizeMojibakeText } from './encoding';

export function parseRows(content: string): ParsedCsvRow[] {
	const separator = detectSeparator(content);
	const rows: ParsedCsvRow[] = [];
	let field = '';
	let row: string[] = [];
	let inQuotes = false;
	let line = 1;
	let rowStartLine = 1;

	for (let index = 0; index < content.length; index += 1) {
		const char = content[index];
		const next = content[index + 1];

		if (char === '"' && inQuotes && next === '"') {
			field += '"';
			index += 1;
			continue;
		}

		if (char === '"') {
			inQuotes = !inQuotes;
			continue;
		}

		if (char === separator && !inQuotes) {
			row.push(field);
			field = '';
			continue;
		}

		if ((char === '\n' || char === '\r') && !inQuotes) {
			if (char === '\r' && next === '\n') index += 1;
			row.push(field);
			if (row.some((cell) => cell.trim() !== '')) rows.push({ cells: row, line: rowStartLine });
			field = '';
			row = [];
			line += 1;
			rowStartLine = line;
			continue;
		}

		if (char === '\n' || char === '\r') {
			line += 1;
		}
		field += char;
	}

	row.push(field);
	if (row.some((cell) => cell.trim() !== '')) rows.push({ cells: row, line: rowStartLine });
	return rows;
}

export function normalizeParsedRows(rows: ParsedCsvRow[]): ParsedCsvRow[] {
	return rows.map((row, rowIndex) => ({
		line: row.line,
		cells: row.cells.map((cell) => normalizeImportCell(cell, rowIndex === 0))
	}));
}

export function normalizeDate(value: string): string {
	const trimmed = value.trim();
	if (isSafeIsoDate(trimmed)) return trimmed;

	const isoDateTime = /^(\d{4}-\d{2}-\d{2})[ T]/.exec(trimmed);
	if (isoDateTime && isSafeIsoDate(isoDateTime[1])) return isoDateTime[1];

	const frenchDate = /^(\d{2})[/-](\d{2})[/-](\d{4})/.exec(trimmed);
	if (!frenchDate) return trimmed;

	const [, day, month, year] = frenchDate;
	return `${year}-${month}-${day}`;
}

export function normalizeFirstValidDate(...values: Array<string | undefined>): string {
	for (const value of values) {
		const normalized = normalizeDate(value ?? '');
		if (isSafeIsoDate(normalized)) return normalized;
	}

	return normalizeDate(firstPresentValue(...values));
}

export function isSafeIsoDate(value: string): boolean {
	try {
		return isValidIsoDate(value);
	} catch {
		return false;
	}
}

export function emptyResult(
	errors: string[],
	warnings: string[],
	profile: ResolvedCsvImportProfile = 'generic',
	totalRows = 0
): CsvImportResult {
	return {
		transactions: [],
		errors,
		warnings,
		invalidRows: errors.map((reason, index) => ({ line: index + 1, reason })),
		summary: buildSummary({
			profile,
			totalRows,
			validRows: 0,
			invalidRows: errors.length,
			duplicateRows: 0,
			totalDebitCents: 0,
			totalCreditCents: 0,
			dates: []
		})
	};
}

export function addInvalidRow(
	errors: string[],
	invalidRows: CsvInvalidRow[],
	line: number,
	reason: string,
	field?: string
): void {
	errors.push(`Ligne ${line}: ${reason}`);
	invalidRows.push({ line, reason, field });
}

export function resolveValidationField(errors: string[]): string | undefined {
	if (errors.some((error) => error.includes('date'))) return 'date';
	if (errors.some((error) => error.includes('montant'))) return 'amount';
	if (errors.some((error) => error.includes('libellé'))) return 'label';
	if (errors.some((error) => error.includes('catégorie'))) return 'category';
	if (errors.some((error) => error.includes('type'))) return 'type';
	return undefined;
}

export function isIgnorableBankingRow(row: string[]): boolean {
	const joined = row.join(' ').trim().toLowerCase();
	if (!joined) return true;
	return /^(solde|total|sous-total|note|informations?|export|page)\b/.test(joined);
}

export function buildSummary(input: {
	profile: ResolvedCsvImportProfile;
	totalRows: number;
	validRows: number;
	invalidRows: number;
	duplicateRows: number;
	totalDebitCents: number;
	totalCreditCents: number;
	dates: string[];
}): CsvImportSummary {
	const sortedDates = [...input.dates].sort();
	return {
		profile: input.profile,
		totalRows: input.totalRows,
		validRows: input.validRows,
		invalidRows: input.invalidRows,
		duplicateRows: input.duplicateRows,
		totalDebitCents: input.totalDebitCents,
		totalCreditCents: input.totalCreditCents,
		period: {
			from: sortedDates[0] ?? null,
			to: sortedDates.at(-1) ?? null
		}
	};
}

export function getDuplicateHeaders(headers: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const header of headers) {
		if (seen.has(header)) duplicates.add(header);
		seen.add(header);
	}
	return [...duplicates];
}

export function toRecord(headers: string[], row: string[]): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((header, index) => {
		record[header] = row[index] ?? '';
	});
	return record;
}

export function normalizeHeaderCells(headers: string[]): string[] {
	const normalized = headers.map((header) => normalizeHeaderName(header));
	while (normalized[normalized.length - 1] === '') normalized.pop();
	return normalized;
}

function detectSeparator(content: string): string {
	const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
	const candidates = [',', ';', '\t'];
	return candidates.reduce((best, candidate) =>
		countOccurrences(firstLine, candidate) > countOccurrences(firstLine, best) ? candidate : best
	);
}

function countOccurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function firstPresentValue(...values: Array<string | undefined>): string {
	return values.find((value) => value?.trim())?.trim() ?? '';
}

function normalizeImportCell(value: string, isHeader: boolean): string {
	const withoutBom = value.replace(/^\uFEFF/, '');
	if (!isHeader && looksLikeAmount(withoutBom)) return withoutBom;
	return normalizeMojibakeText(withoutBom);
}

function looksLikeAmount(value: string): boolean {
	const trimmed = value.trim();
	return /^[+-]?\s*\d[\d\s.,]*$/.test(trimmed);
}
