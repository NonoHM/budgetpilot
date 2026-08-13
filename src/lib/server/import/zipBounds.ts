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
 * **8 MB is 2.5x the measured ceiling and 2.3x the arithmetic one.**
 *
 * WHAT THE BOUND COSTS AT ITS DEFAULT, and the correction that produced this paragraph, because the
 * first figure written here was wrong in the reassuring direction. Cost was first measured with a
 * `sharedStrings.xml` holding ONE enormous element, which gave 42 MB of RSS for 8 MB of XML. #254's
 * own fixture is repeated MARKUP, tens of thousands of small elements, and the same 8 MB then costs
 * **192 MB**. What the parser holds is a DOM and a DOM is priced per NODE, so the byte count does
 * not predict the memory, and the cheap shape is not the one a bound has to survive. Re-measured on
 * the expensive shape:
 *
 *    4 MB -> 113 MB     8 MB -> 192 MB    16 MB -> 310 MB
 *   24 MB -> 386 MB    32 MB -> 467 MB    48 MB -> 672 MB    64 MB -> 845 MB
 *
 * So the honest statement is 192 MB at the default, against 686 MB for #254's own 50 MB fixture and
 * multiple gigabytes at the 260 MB the upload cap admits. A real reduction, not a small residual.
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
/** Megabytes, because that is the unit an operator thinks in and the one the errors speak. */
export const XLSX_DEFAULT_MAX_UNCOMPRESSED_MB = 8;

/**
 * The value above which a configured bound is REFUSED at boot rather than clamped.
 *
 * WHY A CEILING AT ALL, WHEN THE OPERATOR OWNS THE MACHINE. A security limit an operator can raise
 * is a limit an operator can remove, and the realistic way this bound dies is not a decision to
 * disable it: it is one legitimate import failing, someone raising the number until the failure
 * stops, and the guard quietly becoming a suggestion. That is the `.trivyignore` reasoning one
 * layer over, and it produces the same rule: a convenience must never be able to weaken a gate. A
 * ceiling costs an operator with a genuinely enormous workbook a patch and a pull request, which is
 * the right amount of friction for removing a denial-of-service control.
 *
 * REFUSED, NOT CLAMPED, and the difference is the point. Clamping honours the limit and discards the
 * intent: the operator's import goes on failing, for a reason their own configuration says should
 * not apply, and nothing connects the two. `PASSWORD_HASH_COST` in `auth.ts` clamps exactly this way
 * today, so an operator setting 20 silently gets 15, and that precedent is why this one does not.
 *
 * WHERE THE NUMBER COMES FROM, and the first answer written here was withdrawn, which is worth more
 * than the number. It said 32 was the largest value whose worst case (467 MB of RSS) stayed inside
 * half a gigabyte, and that half a gigabyte was the line "because this project documents running on
 * a Raspberry Pi 4/5". **It documents no such thing.** The only mention of a Pi in `docs/` is
 * `getting-started.md` describing the multi-arch image, which is a statement about CPU ARCHITECTURE;
 * there is no memory floor stated anywhere in the docs, the Dockerfile or the compose files, and no
 * `NODE_OPTIONS` or `mem_limit` either. The constraint was inferred from a sentence about arm64 and
 * then cited as though it were sourced. A ceiling resting on an invented figure is a ceiling the
 * first person to question it correctly deletes.
 *
 * So it is re-derived from a property of the SHIPPED ARTIFACT, which is citable because it can be
 * re-measured on any machine. `readSheet` holds the thread: a 32 MB workbook takes **1054 ms** to
 * parse and the default 8 MB takes 340 ms, against 153 ms for a legitimate 3.2 MB one. 32 MB is the
 * largest measured value whose single-import parse stays at about one second. **An operator who
 * raises this to the ceiling is accepting a one-second parse**, three times the default's, and that
 * is what the boot warning exists to put in front of them.
 *
 * THE BOUND IS PER REQUEST AND THE OPERATOR OWNS THE AGGREGATE. Nothing here or anywhere else in the
 * application serialises imports: the route has no queue, no lock and no rate limiter. Measured, the
 * memory does NOT stack the way that invites you to assume, because nothing runs concurrently either:
 * two 32 MB imports peak at 587 MB against 547 MB for one, and total time is linear in the count,
 * which is the signature of serialisation rather than parallelism. What DOES stack is latency, and
 * it stacks badly: two simultaneous 32 MB imports hold the event loop for **1007 ms** at a stretch,
 * and during that second the process serves nobody, not a request and not a health check. Four take
 * 3851 ms. At the default the same figures are 290 ms for two and 502 ms for four.
 *
 * That is a per-process cost this per-request bound does not address, and the sentence below saying
 * it bounds memory rather than time is the one that turned out to matter. Tracked separately rather
 * than solved here, because a concurrency limit is a new control and not a cap.
 */
export const XLSX_MAX_UNCOMPRESSED_CEILING_MB = 32;

/**
 * The largest expansion LibreOffice produced for a workbook still under the upload cap. Not a limit:
 * the figure a configured value is compared against, so that setting the bound BELOW what real
 * spreadsheet software emits is reported at boot rather than discovered as a failing import.
 */
export const LARGEST_MEASURED_LEGITIMATE_BYTES = 3_222_491;

export const XLSX_MAX_UNCOMPRESSED_ENV = 'IMPORT_XLSX_MAX_UNCOMPRESSED_MB';

const MEGABYTE = 1_000_000;

/**
 * Reads the configured bound, or throws. Read per call rather than cached at import, matching
 * `SESSION_TTL_DAYS` and `INVITATION_TTL_HOURS`, so the value stays configurable without a stateful
 * redeploy.
 *
 * It THROWS on a bad value where those neighbours fall back to their default, and the asymmetry is
 * deliberate: a fallback here would mean the bound in force is not the bound the operator
 * configured, which is the one thing a limit must never do quietly. `assertXlsxBoundConfigured` is
 * what turns this throw into a refusal to start, so in practice no request ever sees it.
 */
export function resolveXlsxMaxUncompressedBytes(): number {
	const raw = process.env[XLSX_MAX_UNCOMPRESSED_ENV];
	if (raw === undefined || raw.trim() === '') {
		return XLSX_DEFAULT_MAX_UNCOMPRESSED_MB * MEGABYTE;
	}

	const megabytes = Number(raw);
	if (!Number.isInteger(megabytes) || megabytes < 1) {
		throw new Error(
			`${XLSX_MAX_UNCOMPRESSED_ENV} must be a whole number of megabytes, at least 1 (got ${JSON.stringify(raw)}). It bounds how much XML an uploaded .xlsx may expand to. The default is ${XLSX_DEFAULT_MAX_UNCOMPRESSED_MB}.`
		);
	}

	if (megabytes > XLSX_MAX_UNCOMPRESSED_CEILING_MB) {
		throw new Error(
			`${XLSX_MAX_UNCOMPRESSED_ENV}=${megabytes} is above the hard ceiling of ${XLSX_MAX_UNCOMPRESSED_CEILING_MB}. This is a denial-of-service limit (#254): an .xlsx expanding to ${XLSX_MAX_UNCOMPRESSED_CEILING_MB} MB takes about a second to parse and holds the thread while it does, so raising it further lets one upload stall every other request for longer. The value is refused rather than clamped so that a bound you set is the bound that runs. The number and the measurements that chose it are in src/lib/server/import/zipBounds.ts.`
		);
	}

	return megabytes * MEGABYTE;
}

/**
 * Boot check, called from `hooks.server.ts`. Refuses to start on an out-of-range value, and reports
 * any departure from the default.
 *
 * The warning is the half that is easy to leave out and it is worth more than the refusal. Someone
 * who raised this bound to make a failing import go away will not remember doing so when an upload
 * kills the instance six months later, and nothing else in the running system states what the limit
 * is. A line naming the configured value AND the default puts that fact where a post-mortem starts.
 */
export function assertXlsxBoundConfigured(): void {
	const bytes = resolveXlsxMaxUncompressedBytes();
	const configuredMb = bytes / MEGABYTE;
	if (configuredMb === XLSX_DEFAULT_MAX_UNCOMPRESSED_MB) return;

	console.warn(
		`[budgetpilot] ${XLSX_MAX_UNCOMPRESSED_ENV}=${configuredMb} differs from the default of ${XLSX_DEFAULT_MAX_UNCOMPRESSED_MB}. It bounds how much XML an uploaded .xlsx may expand to, and it exists so that one upload cannot exhaust this machine's memory (#254).`
	);

	if (bytes > XLSX_DEFAULT_MAX_UNCOMPRESSED_MB * MEGABYTE) {
		console.warn(
			`[budgetpilot] ${XLSX_MAX_UNCOMPRESSED_ENV} is RAISED above the default, so one .xlsx upload may cost more than this instance was measured for. At the ${XLSX_MAX_UNCOMPRESSED_CEILING_MB} MB ceiling a single parse takes about 1s and holds the thread throughout, and two at once block it for about 1s at a stretch. The bound is per request: nothing serialises concurrent imports.`
		);
	} else if (bytes < LARGEST_MEASURED_LEGITIMATE_BYTES) {
		console.warn(
			`[budgetpilot] ${XLSX_MAX_UNCOMPRESSED_ENV} is LOWERED below ${LARGEST_MEASURED_LEGITIMATE_BYTES} bytes, the largest workbook LibreOffice produced that still passes the upload cap. Legitimate spreadsheet imports are likely to be refused.`
		);
	}
}

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
