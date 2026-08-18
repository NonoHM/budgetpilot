import { isValidIsoDate } from '$lib/domain/transaction';
import type {
	CsvImportResult,
	CsvImportSummary,
	ParsedCsvRow,
	ResolvedCsvImportProfile
} from '../types';
import type { CsvRefusal, CsvRefusalFact, CsvRefusalScope } from '../refusals';
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
	if (isValidIsoDate(trimmed)) return trimmed;

	const isoDateTime = /^(\d{4}-\d{2}-\d{2})[ T]/.exec(trimmed);
	if (isoDateTime && isValidIsoDate(isoDateTime[1])) return isoDateTime[1];

	// `.` joins `/` and `-` as a separator, never as a new ORDERING. `dd.mm.yyyy` is the German,
	// Swiss and Austrian form and those are day-first without exception, while the month-first
	// convention this file already refuses to accommodate (see `CHASE` in realHeaders.fixture.ts)
	// is written with slashes. So the dot is strictly safer than the two separators beside it.
	// A blind session met a statement written this way and could only import it by replacing
	// twenty-five dots in a text editor. See `dottedDate.spec.ts`.
	const frenchDate = /^(\d{2})[/.-](\d{2})[/.-](\d{4})/.exec(trimmed);
	if (!frenchDate) return trimmed;

	const [, day, month, year] = frenchDate;
	return `${year}-${month}-${day}`;
}

export function normalizeFirstValidDate(...values: Array<string | undefined>): string {
	for (const value of values) {
		const normalized = normalizeDate(value ?? '');
		if (isValidIsoDate(normalized)) return normalized;
	}

	return normalizeDate(firstPresentValue(...values));
}

export function emptyResult(
	facts: CsvRefusalFact[],
	warnings: string[],
	profile: ResolvedCsvImportProfile = 'generic',
	totalRows = 0
): CsvImportResult {
	return {
		transactions: [],
		warnings,
		// header-not-recognized has nowhere to point but the header row, never the file as a
		// whole: the catalogue calls this out as the one exception to the { kind: 'file' } default.
		invalidRows: facts.map((fact) => ({
			scope: fact.code === 'header-not-recognized' ? { kind: 'header' } : { kind: 'file' },
			fact
		})),
		summary: buildSummary({
			profile,
			totalRows,
			validRows: 0,
			// Not `facts.length`. Every fact reaching here is scoped to the file or to the header, so
			// none of them is a row, and counting them as rows is what made a refused import report
			// « 8 lignes lues, 3 invalides » with five rows unaccounted for.
			invalidRows: 0,
			fileLevelRefusals: facts.length,
			duplicateRows: 0,
			totalDebitCents: 0,
			totalCreditCents: 0,
			dates: []
		})
	};
}

export function addRefusal(
	refusals: CsvRefusal[],
	scope: CsvRefusalScope,
	fact: CsvRefusalFact,
	field?: string
): void {
	refusals.push({ scope, fact, field });
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
	fileLevelRefusals: number;
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
		fileLevelRefusals: input.fileLevelRefusals,
		duplicateRows: input.duplicateRows,
		totalDebitCents: input.totalDebitCents,
		totalCreditCents: input.totalCreditCents,
		period: {
			from: sortedDates[0] ?? null,
			to: sortedDates.at(-1) ?? null
		}
	};
}

/**
 * Every spelling the FILE uses for one folded header name, distinct, in file order.
 *
 * The fold is what creates a duplicate, so the folded name is exactly the wrong thing to put in
 * the refusal: a file carrying `Libellé` and `libelle` is refused because two headers the user can
 * see are different are the same to us, and « Colonne dupliquée : libelle » sends them looking for
 * a string their file does not contain. `mapped.ts` learned this on `amount-split-across-columns`,
 * where quoting the folded form sent a user hunting for « zone 10 » in a file reading `Zone 10`.
 *
 * Distinct rather than one per column, because the ordinary case is two columns spelled the same
 * way and « Libellé, Libellé » says nothing the singular does not.
 */
export function duplicatedHeaderSpellings(
	rawCells: string[],
	folded: string[],
	foldedName: string
): string[] {
	const seen = new Set<string>();
	const spellings: string[] = [];
	folded.forEach((name, index) => {
		if (name !== foldedName) return;
		const original = (rawCells[index] ?? '').trim();
		if (seen.has(original)) return;
		seen.add(original);
		spellings.push(original);
	});
	return spellings;
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
