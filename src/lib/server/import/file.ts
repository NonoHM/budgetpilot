import { readSheet } from 'read-excel-file/node';
import type { CellValue } from 'read-excel-file/node';
import type { ParsedCsvRow } from './types';
import { normalizeParsedRows, parseRows } from './utils/csv';
import { measureZipExpansion, resolveXlsxMaxUncompressedBytes, ZipBoundError } from './zipBounds';
import { exceedsCsvResourceCeiling } from './resourceBounds';

/**
 * The upload ceiling for a statement, and the ONLY declaration of it.
 *
 * It was declared three times: here, and again as a route-local `IMPORT_MAX_BYTES` in both
 * `/import` and `/import/columns`. All three read 256_000, so nothing was wrong and nothing could
 * have gone red. What that costs is a future edit: the two screens refuse the same upload with the
 * same message, so moving one and not the others makes them disagree about which files are legal
 * while still agreeing about what to say. `.env.example` documents the figure as "separate, and
 * not configurable", which was true of the documentation and false of the code, since the
 * documentation had one source and the code had three.
 *
 * Deliberately not an environment variable. `BODY_SIZE_LIMIT` bounds the request, and
 * `IMPORT_XLSX_MAX_UNCOMPRESSED_MB` bounds what a zip expands to; this bounds the file itself and
 * nothing has asked to tune it. Adding a variable would make a fourth thing an operator has to get
 * right for an upload to work.
 */
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

	if (format === 'csv') return assertWithinResourceCeiling(await readCsvImportFile(file));

	// The .xlsx extension alone isn't trustworthy (a client can name any file this way):
	// check the real ZIP file signature before handing the buffer to read-excel-file, whose
	// parser throws a raw, untranslated error on non-ZIP content (invalid signature: 0x...).
	// This refuses NON-ZIP content only. `PK\x03\x04` opens every ZIP-based format, so an
	// archive that is not a workbook passes here and is refused by `readSheetOrRefuse` below
	// (#595): this check prevents one class of 500, not both.
	if (!(await hasXlsxSignature(file))) {
		throw new ImportFileError(
			'Le fichier doit utiliser l’extension .csv ou .xlsx.',
			'bad_extension'
		);
	}
	return assertWithinResourceCeiling(await readXlsxImportFile(file));
}

/**
 * The RESOURCE CEILING, enforced here because here is where every door passes.
 *
 * `/import`, `/import/columns` and `/import/accounts` all obtain their rows from `readImportFile`
 * and from nowhere else, so refusing here means no oversized `ParsedCsvRow[]` exists anywhere in
 * the process for any consumer to read. That is the difference between capping a cost and removing
 * the possibility of it: there is no route that bypasses this, because there is nowhere to bypass.
 *
 * It is NOT the product limit. A file merely over `CSV_MAX_ROWS` or the configured column limit
 * passes here untouched and is refused by `parseImportRows` with the catalogue sentence a user can
 * act on. See `resourceBounds.ts` for why those are two rules rather than one.
 *
 * The parse above is bounded by the file's byte count (it allocates per cell the file actually
 * has); the CONSUMERS are not, because they build `columns x rows` matrices from the header width.
 * So the check belongs after the parse and before the return.
 */
function assertWithinResourceCeiling(result: ReadImportFileResult): ReadImportFileResult {
	const columns = result.rows.length === 0 ? 0 : result.rows[0].cells.length;
	const rows = Math.max(0, result.rows.length - 1);
	if (exceedsCsvResourceCeiling({ columns, rows })) {
		throw new ImportFileError(
			`Le fichier dépasse les dimensions traitables (${columns} colonnes, ${rows} lignes).`,
			'exceeds_resource_ceiling',
			{ size: columns * rows }
		);
	}
	return result;
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

/**
 * Every code `readImportFile` refuses with, as a list the type is built from, so a spec can
 * enumerate it: a code added here is covered by `importFileErrorLabel.spec.ts` without anyone
 * remembering to add it there.
 */
export const IMPORT_FILE_ERROR_CODES = [
	'too_large',
	'bad_extension',
	'empty',
	'expands_too_far',
	'exceeds_resource_ceiling',
	'unreadable_workbook'
] as const;

export type ImportFileErrorCode = (typeof IMPORT_FILE_ERROR_CODES)[number];

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

	// BEFORE `readSheet`, and the order is the whole fix (#254). The size cap above bounds the
	// COMPRESSED upload, which the parser never allocates; this bounds what the parser is actually
	// asked to hold. A guard that runs after the allocation that matters is not a guard for it.
	try {
		measureZipExpansion(buffer, resolveXlsxMaxUncompressedBytes());
	} catch (caught) {
		if (caught instanceof ZipBoundError) {
			// A malformed archive is reported as a bad file rather than as an oversized one, so the
			// user is told the thing that is actually true about their upload.
			if (caught.reason === 'malformed') {
				throw new ImportFileError('Le fichier .xlsx est illisible.', 'bad_extension');
			}
			throw new ImportFileError(
				`Le classeur se décompresse au-delà de la limite (${caught.measuredBytes} octets, maximum ${caught.maxBytes} octets).`,
				'expands_too_far',
				{ size: caught.measuredBytes, max: caught.maxBytes }
			);
		}
		throw caught;
	}

	const sheet = await readSheetOrRefuse(buffer);
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

/**
 * `readSheet`, with its failures made a refusal (#595).
 *
 * Reached only by a real ZIP archive that is within the expansion bound, so a throw from here means
 * the archive does not hold a workbook this parser can read: the part it names is missing
 * (`xl/_rels/workbook.xml.rels` for an archive of text files) or cannot be parsed. That is a fact
 * about the upload, and the user can act on it by exporting again, so it is an `ImportFileError`
 * with its own code rather than a raw `Error` the routes rethrow into a 500.
 *
 * The parser's message is NOT carried into the refusal. It names paths inside the archive, which is
 * noise to the reader and, for a crafted upload, text the uploader chose.
 */
async function readSheetOrRefuse(buffer: Buffer) {
	try {
		return await readSheet(buffer);
	} catch {
		throw new ImportFileError(
			'Le fichier .xlsx n’est pas un classeur lisible.',
			'unreadable_workbook'
		);
	}
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
