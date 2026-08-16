import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import {
	assertXlsxBoundConfigured,
	LARGEST_MEASURED_LEGITIMATE_BYTES,
	measureZipExpansion,
	resolveXlsxMaxUncompressedBytes,
	XLSX_DEFAULT_MAX_UNCOMPRESSED_MB,
	XLSX_MAX_UNCOMPRESSED_CEILING_MB,
	XLSX_MAX_UNCOMPRESSED_ENV,
	ZipBoundError
} from './zipBounds';
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
 * reproducing the measurement verifies nothing. The bound raised to 400 MB so the guard admits it,
 * #254's own 205,196-byte fixture, through the real `readImportFile`:
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

/** What `resolveXlsxMaxUncompressedBytes` returns with nothing configured. */
const DEFAULT_BOUND = XLSX_DEFAULT_MAX_UNCOMPRESSED_MB * 1_000_000;

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
		expect(BOMB_BODY_BYTES).toBeGreaterThan(DEFAULT_BOUND);
		expect(BOMB_BODY_BYTES / bombWorkbook.byteLength).toBeGreaterThan(500);
	});
});

describe('the bound admits a legitimate workbook, measured absolutely', () => {
	it('reports the real expanded size of a benign workbook, and its entry count', () => {
		expect.assertions(3);

		const measured = measureZipExpansion(Buffer.from(benignWorkbook), DEFAULT_BOUND);

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
		expect(LARGEST_MEASURED_LEGITIMATE_BYTES).toBeLessThan(DEFAULT_BOUND);
		expect(DEFAULT_BOUND / LARGEST_MEASURED_LEGITIMATE_BYTES).toBeGreaterThan(2);
	});
});

/**
 * The two guards on the configurable bound.
 *
 * A security limit an operator can raise is a limit an operator can remove, and the realistic way
 * this one dies is not a decision to disable it: it is one import failing, someone raising the
 * number until it stops failing, and the guard becoming a suggestion nobody re-reads. So the ceiling
 * is asserted to REFUSE rather than to clamp, and the warning is asserted to NAME BOTH VALUES.
 *
 * Both halves are absence-shaped by default ("it did not start", "nothing was logged"), which is the
 * shape that passes for free. Each therefore carries its presence control first: the refusal test
 * asserts a value one below the ceiling is ACCEPTED before asserting one above it is refused, and
 * the warning tests capture `console.warn` and assert the default logs NOTHING before asserting a
 * departure logs something. Without those, a resolver that refused everything and a logger that
 * warned on every boot would both pass.
 */
describe('the bound is configurable, and the configuration cannot remove it', () => {
	function withEnv<T>(value: string | undefined, run: () => T): T {
		const previous = process.env[XLSX_MAX_UNCOMPRESSED_ENV];
		if (value === undefined) delete process.env[XLSX_MAX_UNCOMPRESSED_ENV];
		else process.env[XLSX_MAX_UNCOMPRESSED_ENV] = value;
		try {
			return run();
		} finally {
			if (previous === undefined) delete process.env[XLSX_MAX_UNCOMPRESSED_ENV];
			else process.env[XLSX_MAX_UNCOMPRESSED_ENV] = previous;
		}
	}

	function captureWarnings(run: () => void): string[] {
		const lines: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
		try {
			run();
		} finally {
			console.warn = original;
		}
		return lines;
	}

	it('is OPTIONAL: an absent or blank value is the default, never a refusal to start', () => {
		expect.assertions(4);

		// DELIBERATELY UNLIKE `BOOTSTRAP_TOKEN` AND `TOTP_ENCRYPTION_KEY`, which are required and
		// crash the boot when missing. Those guard secrets that have no safe default. This one has a
		// measured default that is correct for every instance, so requiring it would break every
		// existing deployment on upgrade to buy nothing at all.
		//
		// The distinction is worth a test rather than a comment, because the refusal path added
		// alongside it is exactly the kind of thing a later edit generalises to "refuse when unset".
		expect(() => withEnv(undefined, assertXlsxBoundConfigured)).not.toThrow();
		expect(() => withEnv('', assertXlsxBoundConfigured)).not.toThrow();
		expect(() => withEnv('   ', assertXlsxBoundConfigured)).not.toThrow();
		expect(withEnv('  ', resolveXlsxMaxUncompressedBytes)).toBe(DEFAULT_BOUND);
	});

	it('unset means the measured default, and a value under the ceiling is honoured', () => {
		expect.assertions(3);

		// The presence half. An operator who sets a legal value must get that value, or the variable
		// is decoration and every refusal below is satisfied by a resolver that refuses everything.
		expect(withEnv(undefined, resolveXlsxMaxUncompressedBytes)).toBe(DEFAULT_BOUND);
		expect(withEnv('16', resolveXlsxMaxUncompressedBytes)).toBe(16_000_000);
		expect(withEnv(String(XLSX_MAX_UNCOMPRESSED_CEILING_MB), resolveXlsxMaxUncompressedBytes)).toBe(
			XLSX_MAX_UNCOMPRESSED_CEILING_MB * 1_000_000
		);
	});

	it('refuses a value above the hard ceiling instead of clamping it', () => {
		expect.assertions(3);

		// REFUSED, not clamped, and the assertion is on the throw rather than on the returned number
		// precisely because a clamp returns a perfectly reasonable number. `PASSWORD_HASH_COST` in
		// auth.ts clamps, so an operator setting 20 gets 15 and is never told; this must not.
		expect(() => withEnv('33', resolveXlsxMaxUncompressedBytes)).toThrow(
			/above the hard ceiling of 32/
		);
		expect(() => withEnv('4096', resolveXlsxMaxUncompressedBytes)).toThrow(
			new RegExp(XLSX_MAX_UNCOMPRESSED_ENV)
		);
		// And the boot check is what turns that into a refusal to start rather than a 500 on the
		// first import, which is the only reason no request ever sees the throw above.
		expect(() => withEnv('4096', assertXlsxBoundConfigured)).toThrow(/hard ceiling/);
	});

	it('refuses a value that is not a whole number of megabytes, rather than falling back', () => {
		expect.assertions(4);

		// A fallback would mean the bound in force is not the bound configured. That is survivable
		// for SESSION_TTL_DAYS and is not survivable here, because the operator would go on believing
		// their value applied.
		for (const bad of ['0', '-1', 'huit', '8.5']) {
			expect(() => withEnv(bad, resolveXlsxMaxUncompressedBytes)).toThrow(/whole number/);
		}
	});

	it('says nothing at boot on the default, and names both values on any departure', () => {
		expect.assertions(5);

		// The presence control first: a logger that warned unconditionally would satisfy every
		// assertion below, and an operator who reads a warning on a default install stops reading
		// warnings.
		expect(withEnv(undefined, () => captureWarnings(assertXlsxBoundConfigured))).toEqual([]);
		expect(
			withEnv(String(XLSX_DEFAULT_MAX_UNCOMPRESSED_MB), () =>
				captureWarnings(assertXlsxBoundConfigured)
			)
		).toEqual([]);

		const raised = withEnv('24', () => captureWarnings(assertXlsxBoundConfigured));
		// BOTH values, because a warning naming only the configured one leaves the reader unable to
		// tell whether it was raised or lowered, which is the whole question in a post-mortem.
		expect(raised.join('\n')).toContain('=24');
		expect(raised.join('\n')).toContain(`default of ${XLSX_DEFAULT_MAX_UNCOMPRESSED_MB}`);
		expect(raised.join('\n')).toContain('RAISED');
	});

	it('warns when the bound is set below what real spreadsheet software emits', () => {
		expect.assertions(2);

		// The other direction, which is not a security risk and is a support incident: at 2 MB every
		// LibreOffice export of any size is refused, and the message a user gets says nothing about
		// configuration. Cheap to say at boot, expensive to diagnose later.
		const lowered = withEnv('2', () => captureWarnings(assertXlsxBoundConfigured));
		expect(lowered.join('\n')).toContain('LOWERED');
		expect(lowered.join('\n')).toContain(String(LARGEST_MEASURED_LEGITIMATE_BYTES));
	});

	it('the boot check is actually wired into the init hook', () => {
		expect.assertions(4);

		// WITHOUT THIS THE CEILING IS DECORATION. Every other test here calls the resolver or the
		// asserter directly, so all of them pass on a build where boot never invokes it, and a
		// ceiling that never runs at boot refuses nothing: an operator's out-of-range value would
		// simply throw on their first import instead, months later, as a 500.
		//
		// The wiring is now two links — init calls the boot collector, the collector calls this —
		// so both are asserted. Still a source scan rather than an import of the collector: that
		// pulls in the Prisma client through bootstrapToken and rateLimit, which costs seconds in
		// the full parallel run for a fact that is textual. Structural, therefore a proxy, so it
		// is calibrated below rather than trusted.
		const hooks = readFileSync(new URL('../../../hooks.server.ts', import.meta.url), 'utf8');
		const collector = readFileSync(
			new URL('../env/assertConfigured.ts', import.meta.url),
			'utf8'
		);
		const callsBootCheck = (source: string) => /\bassertXlsxBoundConfigured\b/.test(source);

		expect(collector).toContain("from '$lib/server/import/zipBounds'");
		expect(callsBootCheck(collector)).toBe(true);
		expect(/await assertEnvironmentConfigured\(\)/.test(hooks)).toBe(true);
		// The calibration: the same predicate must report FALSE on a source that does not name it,
		// or "it is wired" is a statement about a regex that matches anything.
		expect(callsBootCheck('export const CHECKS = [somethingElse];')).toBe(false);
	});

	it('the configured value is what the import path actually enforces', () => {
		expect.assertions(2);

		// The wiring, which the tests above cannot see: they all call the resolver directly. Without
		// this, `readImportFile` could go on using a hardcoded constant and every one of them passes.
		const measured = withEnv('4', () =>
			measureZipExpansion(Buffer.from(benignWorkbook), resolveXlsxMaxUncompressedBytes())
		);
		expect(measured.uncompressedBytes).toBeLessThan(4_000_000);

		let caught: unknown;
		withEnv('4', () => {
			try {
				measureZipExpansion(Buffer.from(bombWorkbook), resolveXlsxMaxUncompressedBytes());
			} catch (error) {
				caught = error;
			}
		});
		expect((caught as ZipBoundError).maxBytes).toBe(4_000_000);
	});
});

describe('v5.0.0-5.2.3: an archive is bounded by what it expands to', () => {
	it('refuses the bomb for expanding too far, naming the limit it crossed', () => {
		expect.assertions(4);

		let caught: unknown;
		try {
			measureZipExpansion(Buffer.from(bombWorkbook), DEFAULT_BOUND);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ZipBoundError);
		// The REASON, not that a refusal happened. `malformed` is the other way this call can throw,
		// and it would mean the walk broke rather than the bound firing.
		expect((caught as ZipBoundError).reason).toBe('expands_too_far');
		expect((caught as ZipBoundError).maxBytes).toBe(DEFAULT_BOUND);
		expect((caught as ZipBoundError).measuredBytes).toBe(DEFAULT_BOUND);
	});

	it('the declared sizes are not what is measured', () => {
		expect.assertions(2);

		// THE CONTROL FOR THE GUARD THAT DOES NOT WORK. This archive says every entry is 1024 bytes.
		// A guard summing the declarations sees 6 KB and admits it; the real parser inflates the
		// stream anyway and spends 798 MB, measured. Only an inflating guard refuses this.
		const forged = forgeDeclaredSizes(bombWorkbook, 1024);
		expect(forged.readUInt32LE(22)).toBe(1024);

		expect(() => measureZipExpansion(forged, DEFAULT_BOUND)).toThrow(
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
		expect(measureZipExpansion(archive, DEFAULT_BOUND).entryCount).toBe(6);
	});

	it('refuses an archive whose structure does not walk, and says so as malformed', () => {
		expect.assertions(2);

		expect(() =>
			measureZipExpansion(Buffer.from('PK\x03\x04 and then nothing'), 1_000_000)
		).toThrow(expect.objectContaining({ reason: 'malformed' }));
		// Truncation is the common accidental case, and it must not be reported as an oversized file.
		const truncated = Buffer.from(bombWorkbook).subarray(0, 200);
		expect(() => measureZipExpansion(truncated, DEFAULT_BOUND)).toThrow(
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
		expect(() => measureZipExpansion(archive, DEFAULT_BOUND)).toThrow(
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
		expect((caught as ImportFileError).params?.max).toBe(DEFAULT_BOUND);
		expect((caught as ImportFileError).params?.size).toBe(DEFAULT_BOUND);
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
