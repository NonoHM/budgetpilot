import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { measureZipExpansion, XLSX_MAX_UNCOMPRESSED_BYTES, ZipBoundError } from './zipBounds';
import { ImportFileError, readImportFile } from './file';

/**
 * The uncompressed-size bound for `.xlsx` uploads (#254, ASVS 5.0 `v5.0.0-5.2.3`).
 *
 * WHAT WOULD MAKE THIS FILE GREEN WITHOUT THE GUARD EXISTING, since that is the only question worth
 * asking of a refusal test. "The bomb was refused" is satisfied by:
 *
 *   - the bound refusing it, which is the property claimed;
 *   - the ZIP-signature gate refusing it, because the fixture is not really a ZIP;
 *   - the 256,000-byte upload cap refusing it, because the fixture was built too large;
 *   - `read-excel-file` refusing it for a reason of its own, having already spent the memory;
 *   - the parse throwing for an unrelated reason with nothing having been measured.
 *
 * So every refusal below asserts the REASON and the MEASURED FIGURE, never that a refusal happened,
 * and the fixtures are asserted to pass the cap and carry the ZIP signature before the refusal is
 * believed. Four of those five alternatives report exactly what a working guard reports.
 *
 * THE CONTROL THAT SEPARATES THIS GUARD FROM THE ONE THAT DOES NOT WORK. Every ZIP entry declares
 * its uncompressed size twice, and the cheap guard sums those declarations without decompressing
 * anything. Measured against the real parser, that guard is vacuous: rewriting all twelve size
 * fields of #254's bomb to say 1024 bytes still produced `{"rows":1,"rssMb":798}`, because
 * `read-excel-file` inflates the stream and never consults the field. `the declared sizes are not
 * what is measured` below is the test that goes red if anyone ever replaces the inflate with a
 * cheaper read of those fields, and it is the only test here that would.
 *
 * THE POSITIVE CONTROL IS ABSOLUTE, NOT RELATIVE. A guard that refused everything would satisfy
 * every refusal in this file. So a legitimate workbook is measured and its expansion asserted as a
 * figure, not merely as "it was admitted".
 *
 * BREAK-CHECK, and it reproduces the FIGURE rather than merely going red, because going red without
 * reproducing the measurement verifies nothing. `XLSX_MAX_UNCOMPRESSED_BYTES` raised to 400 MB so
 * the guard admits it, #254's own 205,196-byte fixture, through the real `readImportFile`:
 *
 *   bound raised    205,196 B   parsed    1669 ms   rss 112 MB -> 798 MB
 *   bound in place  205,196 B   refused      4 ms   rss 112 MB -> 121 MB
 *
 * 798 MB against the 760 MB the issue recorded and the 785 MB this repository's amplification
 * harness reproduces: the same defect, re-measured on this machine.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WB_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
</sheetData>
</worksheet>`;

/** The second column keeps the fixture off the CSV-disguised-as-xlsx branch. */
const SECOND_COLUMN = 'colonne deux';

function workbookCarrying(firstCell: string): Uint8Array {
	const shared = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>${firstCell}</t></si><si><t>${SECOND_COLUMN}</t></si></sst>`;
	return zipSync(
		{
			'[Content_Types].xml': strToU8(CONTENT_TYPES),
			'_rels/.rels': strToU8(RELS),
			'xl/workbook.xml': strToU8(WORKBOOK),
			'xl/_rels/workbook.xml.rels': strToU8(WB_RELS),
			'xl/worksheets/sheet1.xml': strToU8(SHEET),
			'xl/sharedStrings.xml': strToU8(shared)
		},
		{ level: 6 }
	);
}

/**
 * #254's payload shape: a shared string of one repeated byte, which is what deflate encodes most
 * cheaply. 12 MB is deliberately above the 8 MB bound and far below the 260 MB the upload cap
 * actually admits, so the fixture builds in milliseconds while still being the real attack.
 */
const BOMB_BODY_BYTES = 12_000_000;
const bombWorkbook = workbookCarrying('A'.repeat(BOMB_BODY_BYTES));
const benignWorkbook = workbookCarrying('CARTE 12/03 CARREFOUR MARKET 000123 FACTURE 4512');

function asUpload(bytes: Uint8Array, name = 'releve.xlsx'): File {
	return new File([bytes as BlobPart], name, {
		type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	});
}

/** Rewrite every declared uncompressed size, in both the local headers and the central directory. */
function forgeDeclaredSizes(archive: Uint8Array, declared: number): Buffer {
	const out = Buffer.from(archive);
	let patched = 0;
	for (let i = 0; i + 4 <= out.length; i += 1) {
		const signature = out.readUInt32LE(i);
		if (signature === 0x04034b50) {
			out.writeUInt32LE(declared, i + 22);
			patched += 1;
		} else if (signature === 0x02014b50) {
			out.writeUInt32LE(declared, i + 24);
			patched += 1;
		}
	}
	if (patched === 0) throw new Error('forge found no size fields: the fixture changed shape');
	return out;
}

describe('control: the fixtures reach the guard rather than being stopped before it', () => {
	it('both fixtures carry the ZIP signature and sit under the 256,000-byte upload cap', () => {
		expect.assertions(4);

		for (const workbook of [bombWorkbook, benignWorkbook]) {
			expect(Array.from(workbook.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
			expect(workbook.byteLength).toBeLessThan(256_000);
		}
	});

	it('the bomb is small on the wire and large when opened, which is the whole defect', () => {
		expect.assertions(3);

		// The ratio is the claim. A fixture that were merely large would be caught by the upload cap
		// and would prove nothing about this guard.
		expect(bombWorkbook.byteLength).toBeLessThan(50_000);
		expect(BOMB_BODY_BYTES).toBeGreaterThan(XLSX_MAX_UNCOMPRESSED_BYTES);
		expect(BOMB_BODY_BYTES / bombWorkbook.byteLength).toBeGreaterThan(500);
	});
});

describe('the bound admits a legitimate workbook, measured absolutely', () => {
	it('reports the real expanded size of a benign workbook, and its entry count', () => {
		expect.assertions(3);

		const measured = measureZipExpansion(Buffer.from(benignWorkbook), XLSX_MAX_UNCOMPRESSED_BYTES);

		// Absolute figures, because a guard that measured nothing would also "not refuse". The six
		// parts are the six a minimal workbook needs; the byte total is what they really inflate to.
		expect(measured.entryCount).toBe(6);
		expect(measured.uncompressedBytes).toBeGreaterThan(1_000);
		expect(measured.uncompressedBytes).toBe(
			CONTENT_TYPES.length +
				RELS.length +
				WORKBOOK.length +
				WB_RELS.length +
				SHEET.length +
				sharedStringsLengthFor('CARTE 12/03 CARREFOUR MARKET 000123 FACTURE 4512')
		);
	});

	it('a real 12000-row workbook is well inside the bound, per the LibreOffice measurement', () => {
		expect.assertions(2);

		// Not a fixture: the figure LibreOffice produced for 12000 statement rows at 241,592 bytes on
		// the wire, which is the largest such workbook the upload cap admits. The bound has to clear
		// it, and this is the assertion that goes red if anyone tightens the bound below reality.
		const LARGEST_MEASURED_LEGITIMATE = 3_222_491;
		expect(LARGEST_MEASURED_LEGITIMATE).toBeLessThan(XLSX_MAX_UNCOMPRESSED_BYTES);
		expect(XLSX_MAX_UNCOMPRESSED_BYTES / LARGEST_MEASURED_LEGITIMATE).toBeGreaterThan(2);
	});
});

describe('v5.0.0-5.2.3: an archive is bounded by what it expands to', () => {
	it('refuses the bomb for expanding too far, naming the limit it crossed', () => {
		expect.assertions(4);

		let caught: unknown;
		try {
			measureZipExpansion(Buffer.from(bombWorkbook), XLSX_MAX_UNCOMPRESSED_BYTES);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ZipBoundError);
		// The REASON, not that a refusal happened. `malformed` is the other way this call can throw,
		// and it would mean the walk broke rather than the bound firing.
		expect((caught as ZipBoundError).reason).toBe('expands_too_far');
		expect((caught as ZipBoundError).maxBytes).toBe(XLSX_MAX_UNCOMPRESSED_BYTES);
		expect((caught as ZipBoundError).measuredBytes).toBe(XLSX_MAX_UNCOMPRESSED_BYTES);
	});

	it('the declared sizes are not what is measured', () => {
		expect.assertions(2);

		// THE CONTROL FOR THE GUARD THAT DOES NOT WORK. This archive says every entry is 1024 bytes.
		// A guard summing the declarations sees 6 KB and admits it; the real parser inflates the
		// stream anyway and spends 798 MB, measured. Only an inflating guard refuses this.
		const forged = forgeDeclaredSizes(bombWorkbook, 1024);
		expect(forged.readUInt32LE(22)).toBe(1024);

		expect(() => measureZipExpansion(forged, XLSX_MAX_UNCOMPRESSED_BYTES)).toThrow(
			expect.objectContaining({ reason: 'expands_too_far' })
		);
	});

	it('bounds a STORED entry too, which no inflate call would ever see', () => {
		expect.assertions(2);

		// Method 0 is legal in a `.xlsx` and passes through zlib untouched, so a guard written only
		// around `inflateRawSync` would let an uncompressed 20 MB member straight through. It costs
		// the attacker the upload cap, so it is a weaker attack, and it is still a hole.
		const stored = zipSync({ 'xl/sharedStrings.xml': strToU8('A'.repeat(200_000)) }, { level: 0 });
		expect(() => measureZipExpansion(Buffer.from(stored), 100_000)).toThrow(
			expect.objectContaining({ reason: 'expands_too_far' })
		);
		expect(measureZipExpansion(Buffer.from(stored), 1_000_000).uncompressedBytes).toBe(200_000);
	});
});

describe('the walk survives archives real software produces', () => {
	it('reads sizes that only the central directory carries, as a streamed writer leaves them', () => {
		expect.assertions(3);

		// A writer that cannot seek (anything piping to stdout) emits a data descriptor and leaves
		// the LOCAL header's sizes at zero. Measured against the `zip` CLI in both modes and against
		// python's zipfile, all of which this walk handles; here the shape is reproduced directly so
		// the property is pinned rather than depending on a tool being installed.
		const archive = Buffer.from(workbookCarrying('donnees'));
		const localSizeBefore = archive.readUInt32LE(22);
		archive.writeUInt32LE(0, 18); // compressed size, local header
		archive.writeUInt32LE(0, 22); // uncompressed size, local header

		expect(localSizeBefore).toBeGreaterThan(0);
		expect(archive.readUInt32LE(22)).toBe(0);
		// Unchanged: the walk takes its sizes from the central directory, where a streamed writer
		// does fill them in.
		expect(measureZipExpansion(archive, XLSX_MAX_UNCOMPRESSED_BYTES).entryCount).toBe(6);
	});

	it('refuses an archive whose structure does not walk, and says so as malformed', () => {
		expect.assertions(2);

		expect(() =>
			measureZipExpansion(Buffer.from('PK\x03\x04 and then nothing'), 1_000_000)
		).toThrow(expect.objectContaining({ reason: 'malformed' }));
		// Truncation is the common accidental case, and it must not be reported as an oversized file.
		const truncated = Buffer.from(bombWorkbook).subarray(0, 200);
		expect(() => measureZipExpansion(truncated, XLSX_MAX_UNCOMPRESSED_BYTES)).toThrow(
			expect.objectContaining({ reason: 'malformed' })
		);
	});

	it('refuses a compression method it cannot measure rather than skipping it', () => {
		expect.assertions(1);

		// A method the walk does not understand is an entry whose expansion it cannot bound, and
		// counting it as zero would be the silent hole. Method 9 (enhanced deflate) is the realistic
		// one; nothing in the `.xlsx` ecosystem writes it, which is why refusing costs nothing.
		const archive = Buffer.from(workbookCarrying('donnees'));
		for (let i = 0; i + 4 <= archive.length; i += 1) {
			if (archive.readUInt32LE(i) === 0x02014b50) archive.writeUInt16LE(9, i + 10);
		}
		expect(() => measureZipExpansion(archive, XLSX_MAX_UNCOMPRESSED_BYTES)).toThrow(
			expect.objectContaining({ reason: 'malformed' })
		);
	});
});

describe('the import path refuses the bomb with the reason a user is shown', () => {
	it('readImportFile reports expands_too_far, not bad_extension and not empty', async () => {
		expect.assertions(4);

		let caught: unknown;
		try {
			await readImportFile(asUpload(bombWorkbook));
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ImportFileError);
		// The reason is the only part of a refusal the user ever sees, and the three neighbouring
		// codes all produce a refusal that reads as correct while sending them to the wrong place.
		expect((caught as ImportFileError).code).toBe('expands_too_far');
		expect((caught as ImportFileError).params?.max).toBe(XLSX_MAX_UNCOMPRESSED_BYTES);
		expect((caught as ImportFileError).params?.size).toBe(XLSX_MAX_UNCOMPRESSED_BYTES);
	});

	it('and still parses a legitimate workbook end to end', async () => {
		expect.assertions(2);

		// The positive half of the same path: without it, a guard that refused every `.xlsx` would
		// pass every other test in this file.
		const result = await readImportFile(asUpload(benignWorkbook));
		expect(result.format).toBe('xlsx');
		expect(result.rows[0]?.cells[0]).toBe('CARTE 12/03 CARREFOUR MARKET 000123 FACTURE 4512');
	});
});

describe('control: the measurement is of real output, not of the input', () => {
	it('a highly compressible entry is counted at its expanded size', () => {
		expect.assertions(2);

		// Directly: 1 MB of one byte deflates to under 2 KB. A guard counting compressed bytes would
		// see the 2 KB and be wrong by three orders of magnitude, which is exactly #254.
		const payload = deflateRawSync(Buffer.alloc(1_000_000, 0x41));
		expect(payload.length).toBeLessThan(2_000);

		const archive = Buffer.from(zipSync({ 'x.xml': new Uint8Array(1_000_000).fill(0x41) }));
		expect(measureZipExpansion(archive, 2_000_000).uncompressedBytes).toBe(1_000_000);
	});
});

function sharedStringsLengthFor(firstCell: string): number {
	return `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>${firstCell}</t></si><si><t>${SECOND_COLUMN}</t></si></sst>`
		.length;
}
