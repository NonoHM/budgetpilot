import { inflateRawSync } from 'node:zlib';

/**
 * The uncompressed-size bound for `.xlsx` uploads: ASVS 5.0 `v5.0.0-5.2.3`, and the fix for #254.
 *
 * WHY A BYTE CAP ON THE UPLOAD IS NOT A BOUND ON WHAT THE UPLOAD COSTS. `.xlsx` is a ZIP of XML
 * documents, so the 256,000 bytes `readImportFile` admits are 256,000 bytes of DEFLATE output. #254
 * measured the ceiling on that: a `sharedStrings.xml` of one repeated byte compresses at about
 * 1020:1, so the cap admits roughly 260 MB of XML, and a 205,196-byte file drove the parser to
 * **760 MB RSS in 1.8 seconds with the parse SUCCEEDING**, so nothing anywhere reported anything.
 * On the class of machine this project documents (a NAS, a Pi, a small VPS) that is an
 * out-of-memory kill, and on a household instance it takes down every member rather than the
 * uploader alone.
 *
 * WHY THIS INFLATES INSTEAD OF READING THE DECLARED SIZES, which is the measurement that decided
 * the shape of this file rather than a preference. Every ZIP entry declares its uncompressed size,
 * in the local header and again in the central directory, so the obvious guard reads those and sums
 * them without decompressing anything. **It does not work, and it fails green.** Rewriting all
 * twelve size fields of #254's bomb to declare 1024 bytes each and running it through the real
 * parser produced `{"rows":1,"rssMb":798}`: `read-excel-file` does not consult the declared size, it
 * inflates the stream. A guard reading those fields would therefore bound what the attacker chose to
 * write down, refuse nothing, and report clean.
 *
 * So this walks the central directory for each entry's LOCATION, which an attacker cannot lie about
 * without breaking the file for the parser too, and inflates each entry against a shrinking budget.
 * The figure it returns is measured output, not a claim.
 *
 * HOW THE BOUND WAS CHOSEN, against real spreadsheet software rather than against a synthetic
 * builder, because the two disagree by a factor of two and the synthetic one is the optimistic half.
 * A hand-built workbook of 8000 statement rows compresses at 7.3:1; LibreOffice's own output for the
 * same 8000 rows compresses at 13.2:1, because it also writes styles, themes and relationship parts.
 * Measured at the cap:
 *
 *   - LibreOffice, 12000 rows, repetitive labels: 241,592 B on the wire, **3,222,491 B of XML**,
 *     13.3:1. 16000 rows no longer fits under the cap.
 *   - LibreOffice, 8000 rows, high-entropy labels: 229,605 B on the wire, 1,984,714 B of XML, 8.6:1.
 *
 * 3.22 MB is therefore the largest expansion a legitimate workbook can carry past the upload cap as
 * measured, and 13.4:1 against the full 256,000 bytes puts the arithmetic ceiling at about 3.43 MB.
 * **8 MB is 2.5x the measured ceiling and 2.3x the arithmetic one.** The residual cost at the bound
 * is 42 MB of RSS, against 760 MB unbounded.
 *
 * WHAT THIS DOES NOT PREVENT, stated because the neighbouring fix invites the assumption that it
 * does. It is a bound on ZIP decompression and on nothing else. It says nothing about #276, the
 * backup restore path, whose amplification happens inside `JSON.parse` with no compression involved.
 * It is not a defence against XML entity expansion either: that is closed separately, by
 * `@xmldom/xmldom` expanding no DTD entities at all, and is pinned in `xml-entities.spec.ts`. And it
 * bounds MEMORY rather than TIME: 8 MB of pathological XML is still 8 MB the parser must walk.
 *
 * COST ON A LEGITIMATE IMPORT: the entries are inflated twice, once here and once by the parser.
 * Measured at 2.6 ms for a 12000-row workbook, against the parse's own tens of milliseconds. Peak
 * transient allocation is the bound itself, since each entry is materialised to be counted.
 */
export const XLSX_MAX_UNCOMPRESSED_BYTES = 8_000_000;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
/** The maximum a ZIP comment can be, which is how far back the terminating record can sit. */
const MAX_COMMENT_BYTES = 0xffff;
/** Written into a 32-bit size or offset field when the real value needs ZIP64 to express it. */
const ZIP64_SENTINEL = 0xffffffff;

const STORED = 0;
const DEFLATED = 8;

export type ZipBoundFailure = 'malformed' | 'expands_too_far';

export class ZipBoundError extends Error {
	readonly reason: ZipBoundFailure;
	/** Bytes counted before the walk gave up. Absent when the archive never parsed. */
	readonly measuredBytes?: number;
	readonly maxBytes: number;

	constructor(reason: ZipBoundFailure, message: string, maxBytes: number, measuredBytes?: number) {
		super(message);
		this.name = 'ZipBoundError';
		this.reason = reason;
		this.maxBytes = maxBytes;
		this.measuredBytes = measuredBytes;
	}
}

export interface ZipExpansion {
	/** Total bytes the archive's entries actually inflate to. Measured, never declared. */
	uncompressedBytes: number;
	entryCount: number;
}

/**
 * Inflates every entry of `archive` against a total budget of `maxBytes` and returns what it
 * measured, throwing `ZipBoundError` as soon as the budget is crossed or the archive does not walk.
 *
 * Refusing a malformed archive is deliberate rather than incidental: this runs on an untrusted
 * upload, and an archive whose central directory does not agree with its local headers is not one
 * whose expansion can be bounded. `read-excel-file` would have to be trusted to reach the same
 * conclusion, and #254 is precisely a case where it did not.
 */
export function measureZipExpansion(archive: Buffer, maxBytes: number): ZipExpansion {
	const fail = (message: string, measured?: number): never => {
		throw new ZipBoundError('malformed', message, maxBytes, measured);
	};

	const eocd = findEndOfCentralDirectory(archive);
	if (eocd < 0) return fail('no end-of-central-directory record');

	const entryCount = archive.readUInt16LE(eocd + 10);
	let cursor = archive.readUInt32LE(eocd + 16);
	if (cursor === ZIP64_SENTINEL) return fail('zip64 central directory');

	let total = 0;
	for (let index = 0; index < entryCount; index += 1) {
		if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY) {
			return fail(`central directory entry ${index} does not parse`, total);
		}

		const method = archive.readUInt16LE(cursor + 10);
		const compressedSize = archive.readUInt32LE(cursor + 20);
		const nameLength = archive.readUInt16LE(cursor + 28);
		const extraLength = archive.readUInt16LE(cursor + 30);
		const commentLength = archive.readUInt16LE(cursor + 32);
		const localOffset = archive.readUInt32LE(cursor + 42);

		// Neither sentinel can appear legitimately in a file small enough to pass the upload cap:
		// they are written only when the real value exceeds 32 bits.
		if (compressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
			return fail(`entry ${index} declares zip64 sizes`, total);
		}

		if (
			localOffset + 30 > archive.length ||
			archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER
		) {
			return fail(`local header for entry ${index} does not parse`, total);
		}

		// The local header's own name and extra lengths, not the central directory's: the two are
		// allowed to differ, and it is the local ones that position this entry's data.
		const dataStart =
			localOffset +
			30 +
			archive.readUInt16LE(localOffset + 26) +
			archive.readUInt16LE(localOffset + 28);
		if (dataStart + compressedSize > archive.length) {
			return fail(`entry ${index} runs past the end of the archive`, total);
		}

		const budget = maxBytes - total;
		if (budget <= 0) {
			// Only reachable when a previous entry landed exactly on the bound. Refusing here means
			// the effective limit is one byte tighter for an archive with trailing entries, which is
			// immaterial at 8 MB and keeps the boundary from depending on zlib's behaviour at zero.
			throw new ZipBoundError(
				'expands_too_far',
				`archive reaches the ${maxBytes} byte limit with ${entryCount - index} entries left`,
				maxBytes,
				total
			);
		}

		const data = archive.subarray(dataStart, dataStart + compressedSize);
		if (method === STORED) {
			if (data.length > budget) {
				throw new ZipBoundError(
					'expands_too_far',
					`stored entry ${index} alone exceeds the ${maxBytes} byte limit`,
					maxBytes,
					total + data.length
				);
			}
			total += data.length;
		} else if (method === DEFLATED) {
			try {
				total += inflateRawSync(data, { maxOutputLength: budget }).length;
			} catch (caught) {
				if ((caught as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
					throw new ZipBoundError(
						'expands_too_far',
						`archive expands past the ${maxBytes} byte limit`,
						maxBytes,
						maxBytes
					);
				}
				return fail(`entry ${index} does not inflate`, total);
			}
		} else {
			return fail(`entry ${index} uses unsupported compression method ${method}`, total);
		}

		cursor += 46 + nameLength + extraLength + commentLength;
	}

	return { uncompressedBytes: total, entryCount };
}

/**
 * The terminating record is found by scanning backwards, because it is the only record whose
 * position is not written down anywhere: a trailing comment of up to 65535 bytes may follow it.
 */
function findEndOfCentralDirectory(archive: Buffer): number {
	const earliest = Math.max(0, archive.length - 22 - MAX_COMMENT_BYTES);
	for (let index = archive.length - 22; index >= earliest; index -= 1) {
		if (archive.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) return index;
	}
	return -1;
}
