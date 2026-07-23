import { readSheet } from 'read-excel-file/node';
import type { CellValue } from 'read-excel-file/node';
import type { ParsedCsvRow } from './types';
import { normalizeParsedRows, parseRows } from './utils/csv';

export const IMPORT_FILE_MAX_BYTES = 256_000;

export type ImportFileFormat = 'csv' | 'xlsx';

export interface ReadImportFileResult {
	format: ImportFileFormat;
	kind: ImportFileFormat;
	rows: ParsedCsvRow[];
	sourceLines: string[];
	previewRowsByLine: Record<number, string[]>;
}

export async function readImportFile(
	file: File,
	options: { maxBytes?: number } = {}
): Promise<ReadImportFileResult> {
	const maxBytes = options.maxBytes ?? IMPORT_FILE_MAX_BYTES;
	if (file.size > maxBytes) {
		throw new ImportFileError(
			`Fichier trop volumineux (${file.size} octets, maximum ${maxBytes} octets).`,
			'too_large',
			{ size: file.size, max: maxBytes }
		);
	}

	const format = getImportFileFormat(file.name);
	if (!format) {
		throw new ImportFileError(
			'Le fichier doit utiliser l’extension .csv ou .xlsx.',
			'bad_extension'
		);
	}

	if (format === 'csv') return readCsvImportFile(file);

	// The .xlsx extension alone isn't trustworthy (a client can name any file this way):
	// check the real ZIP file signature before handing the buffer to read-excel-file, whose
	// parser throws a raw, untranslated error on non-ZIP content (invalid signature: 0x...)
	// that would otherwise bubble up as an unhandled 500 instead of a clean, translated error.
	if (!(await hasXlsxSignature(file))) {
		throw new ImportFileError(
			'Le fichier doit utiliser l’extension .csv ou .xlsx.',
			'bad_extension'
		);
	}
	return readXlsxImportFile(file);
}

// Local file header signature "PK\x03\x04" shared by every ZIP-based Office format
// (.xlsx included). Real .xlsx files produced by Excel/LibreOffice/Google Sheets always
// start with it; a file merely renamed to .xlsx (plain text, image, ...) never does.
const XLSX_ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

async function hasXlsxSignature(file: File): Promise<boolean> {
	const header = new Uint8Array(await file.slice(0, XLSX_ZIP_SIGNATURE.length).arrayBuffer());
	return XLSX_ZIP_SIGNATURE.every((byte, index) => header[index] === byte);
}

export function getImportFileFormat(fileName: string): ImportFileFormat | null {
	const normalized = fileName.toLowerCase();
	if (normalized.endsWith('.csv')) return 'csv';
	if (normalized.endsWith('.xlsx')) return 'xlsx';
	return null;
}

export function isSupportedImportFile(fileName: string): boolean {
	return getImportFileFormat(fileName) !== null;
}

export type ImportFileErrorCode = 'too_large' | 'bad_extension' | 'empty';

export class ImportFileError extends Error {
	/** Stable code for translation on the route side; the French message stays for logs/tests. */
	code: ImportFileErrorCode;
	params?: { size?: number; max?: number };

	constructor(
		message: string,
		code: ImportFileErrorCode,
		params?: { size?: number; max?: number }
	) {
		super(message);
		this.name = 'ImportFileError';
		this.code = code;
		this.params = params;
	}
}

async function readCsvImportFile(file: File): Promise<ReadImportFileResult> {
	const content = await file.text();
	if (!content.trim()) throw new ImportFileError('The statement file is empty.', 'empty');
	const rows = parseRows(content);
	const normalizedRows = normalizeParsedRows(rows);

	return {
		format: 'csv',
		kind: 'csv',
		rows: normalizedRows,
		sourceLines: content.replace(/^\uFEFF/, '').split(/\r?\n/),
		previewRowsByLine: buildPreviewRowsByLine(normalizedRows)
	};
}

async function readXlsxImportFile(file: File): Promise<ReadImportFileResult> {
	const buffer = Buffer.from(await file.arrayBuffer());
	const sheet = await readSheet(buffer);
	const rows = sheet
		.map((row, index) => ({ cells: row.map((cell) => formatCellValue(cell)), line: index + 1 }))
		.filter((row) => row.cells.some((cell) => cell.trim() !== ''));

	if (rows.length === 0) throw new ImportFileError('The statement file is empty.', 'empty');
	if (isCsvDisguisedAsXlsx(rows)) {
		const content = rows.map((row) => row.cells[0]).join('\n');
		const parsedRows = parseRows(content);
		const normalizedRows = normalizeParsedRows(parsedRows);
		return {
			format: 'xlsx',
			kind: 'xlsx',
			rows: normalizedRows,
			sourceLines: content.split(/\r?\n/),
			previewRowsByLine: buildPreviewRowsByLine(normalizedRows)
		};
	}

	const normalizedRows = normalizeParsedRows(rows);
	return {
		format: 'xlsx',
		kind: 'xlsx',
		rows: normalizedRows,
		sourceLines: rows.map((row) => row.cells.join(';')),
		previewRowsByLine: buildPreviewRowsByLine(normalizedRows)
	};
}

function formatCellValue(value: CellValue | null): string {
	if (value === null || value === undefined) return '';
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return String(value);
}

function isCsvDisguisedAsXlsx(rows: ParsedCsvRow[]): boolean {
	return (
		rows.every((row) => row.cells.length <= 1) &&
		rows.some((row) => /[;,\t]/.test(row.cells[0] ?? ''))
	);
}

function buildPreviewRowsByLine(rows: ParsedCsvRow[]): Record<number, string[]> {
	return Object.fromEntries(rows.map((row) => [row.line, row.cells]));
}
