import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { IMPORT_FILE_MAX_BYTES, readImportFile } from './file';

/**
 * XML entity handling in the `.xlsx` import path: check 9 of the Phase 5 automation inventory,
 * covering `v5.0.0-1.5.1` (external entity resolution is disabled) and the parser half of
 * `v5.0.0-5.2.2` (uploaded files are validated before being handed to a parser).
 *
 * `.xlsx` is a ZIP of XML documents, so the import feature has an XML parser in it whether anyone
 * thinks of it that way or not. `read-excel-file@9.2.0` parses through `@xmldom/xmldom@0.9.10`, and
 * the property this file pins is xmldom's: it expands no DTD entities at all. Nothing in this
 * repository chose that, configured it, or would notice it changing. **The regression this exists
 * for is an XML-parser swap**, which arrives as a `chore(deps)` bump or as a switch to a faster
 * spreadsheet library, and which no other test in this repository would feel.
 *
 * WHY AN XXE TEST IS THE ONE WHOSE GREEN IS ALMOST ALWAYS VACUOUS, and what each control here
 * separates. "The canary file's contents do not appear in the parsed output" is satisfied by:
 *
 *   - a parser that refused the entity, which is the property being claimed;
 *   - a parser that refused the whole FILE, because the fixture is not a valid `.xlsx`;
 *   - a file that never reached the parser, because the ZIP-signature gate bounced it;
 *   - a canary file that was never written, so there was nothing to leak;
 *   - a parse that threw for an unrelated reason and left `output` undefined.
 *
 * Four of those five are harness failures and every one of them reports the answer we want. So the
 * absences below are surrounded by three positive controls, each closing one of them, and each
 * asserted BEFORE the absence rather than alongside it:
 *
 *   1. THE BENIGN CONTROL PARSES. A structurally identical workbook, differing only in that its
 *      shared string is a plain literal, must come back with that literal in the parsed rows. This
 *      is the control the #184 pass carried and it is the load-bearing one: it proves this builder
 *      produces a workbook `read-excel-file` genuinely reads, so a refusal is about the entity.
 *   2. THE PAYLOAD REACHES THE PARSER. Both hostile fixtures are asserted to carry the ZIP local
 *      header and to sit under `IMPORT_FILE_MAX_BYTES`, so neither is bounced by
 *      `hasXlsxSignature` or by the size cap before `read-excel-file` ever sees it.
 *   3. THE CANARY IS READABLE. The secret is read back off disk by this process, so "it did not
 *      appear in the output" is a statement about the parser rather than about an empty file.
 *
 * AND THE ASSERTIONS ARE ON THE MEASURED OUTCOME, NOT ON THE ABSENCE OF A DISASTER. The cell is
 * asserted to hold the literal `&xxe;`, and the bomb's cell to hold the literal `&e9;`, four
 * characters. "Nothing exploded" and "no secret appeared" are both what a parser that never ran
 * reports; "the cell contains the unexpanded reference" is only what an entity-refusing parser
 * reports.
 *
 * THAT LAST PARAGRAPH IS MEASURED RATHER THAN ARGUED, and it is the result worth carrying out of
 * this file. Two edits applied together: the import path made to return no rows at all, and the two
 * hostile tests reduced to their absence assertions, which is the shape they would have had without
 * the measured-outcome rule. **Both went GREEN.** A parser that produced nothing reported no leak
 * and no expansion, exactly as a correct one does. With `toBe('&xxe;')` and `toBe('&e9;')` in place
 * the same break turns both red. The positive assertion is not a stylistic preference here; it is
 * the entire difference between the test and a formality.
 *
 * THE BREAK MATRIX, seven breaks against six tests, read per test. Baseline 6/6.
 *
 *  - `the canary is never written`: only the canary control red. The XXE test stays GREEN, because
 *    an absent secret cannot appear in the output. This is the vacuous pass the third control
 *    exists for, and it is the one an XXE test falls into by default.
 *  - `the fixture is not a workbook`, `nothing reaches the parser` (the ZIP signature tightened so
 *    every real ZIP is refused), `the parser returns no rows`: the benign control, the leak control
 *    and BOTH hostile tests red. The signature and canary controls stay green, correctly: they read
 *    bytes and a file, not a parse.
 *  - `the parser expands the entity` and `the parser expands the bomb`, each fixture carrying what
 *    expansion would have produced: one red each, on its own test, nowhere else.
 *  - `the leak detector reads nothing`: the benign control and the leak control red, and the XXE
 *    test GREEN, because its remaining assertion does not go through the detector. The leak control
 *    is the only thing that sees a blinded search, which is why it is a test and not a comment.
 *
 * ONE THING THIS DOES NOT COVER, stated because the neighbouring fact makes it easy to assume.
 * #254 measured 50 MB of XML deflating to 205,196 bytes, under the 256,000-byte cap, driving the
 * parser to 760 MB RSS with the parse SUCCEEDING. That is decompression amplification and it has
 * nothing to do with entities: it needs no DTD, and refusing entities does not mitigate it. The
 * bomb fixture here is the ENTITY family only.
 */

/** Deliberately unmistakable, and long enough that a partial read would still match. */
const CANARY_CONTENTS = 'XXE-CANARY-3f81ba-DO-NOT-LEAK-THIS-LINE';
const CONTROL_VALUE = 'CONTROL-CANARY-VALUE';
/** The second column exists to keep the fixture off the CSV-disguised-as-xlsx path. */
const SECOND_COLUMN = 'colonne deux';

let workdir = '';
let canaryPath = '';

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

/** Two columns, both shared strings: index 0 is the payload, index 1 keeps the row off the CSV path. */
const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
</sheetData>
</worksheet>`;

function sharedStrings(doctype: string, payload: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
${doctype}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
<si><t>${payload}</t></si>
<si><t>${SECOND_COLUMN}</t></si>
</sst>`;
}

function buildWorkbook(shared: string): Uint8Array {
	return zipSync({
		'[Content_Types].xml': strToU8(CONTENT_TYPES),
		'_rels/.rels': strToU8(RELS),
		'xl/workbook.xml': strToU8(WORKBOOK),
		'xl/_rels/workbook.xml.rels': strToU8(WB_RELS),
		'xl/worksheets/sheet1.xml': strToU8(SHEET),
		'xl/sharedStrings.xml': strToU8(shared)
	});
}

/**
 * A nine-level internal entity bomb. `&e9;` expands to 3^9 = 19683 characters in a parser that
 * expands DTD entities, and to the four characters `&e9;` in one that does not.
 *
 * Internal rather than external on purpose: this is the family that needs no filesystem and no
 * network, so a parser hardened only against SYSTEM identifiers is still exposed to it.
 */
function entityBombDoctype(): string {
	const levels = ['<!ENTITY e0 "aaa">'];
	for (let level = 1; level <= 9; level += 1) {
		levels.push(`<!ENTITY e${level} "&e${level - 1};&e${level - 1};&e${level - 1};">`);
	}
	return `<!DOCTYPE sst [\n${levels.join('\n')}\n]>\n`;
}

const EXPANDED_BOMB_LENGTH = 3 ** 9;

let xxeWorkbook: Uint8Array;
let bombWorkbook: Uint8Array;
let controlWorkbook: Uint8Array;

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), 'bp-xxe-'));
	canaryPath = join(workdir, 'canary.txt');
	writeFileSync(canaryPath, CANARY_CONTENTS);

	xxeWorkbook = buildWorkbook(
		sharedStrings(`<!DOCTYPE sst [ <!ENTITY xxe SYSTEM "file://${canaryPath}"> ]>\n`, '&xxe;')
	);
	bombWorkbook = buildWorkbook(sharedStrings(entityBombDoctype(), '&e9;'));
	controlWorkbook = buildWorkbook(sharedStrings('', CONTROL_VALUE));
});

afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

function asUpload(bytes: Uint8Array, name = 'releve.xlsx'): File {
	return new File([bytes as BlobPart], name, {
		type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	});
}

/** The whole parsed result flattened, so a leak anywhere in it is a leak. */
function everyCell(result: Awaited<ReturnType<typeof readImportFile>>): string {
	return JSON.stringify(result);
}

describe('control: the fixtures are workbooks this parser genuinely reads', () => {
	// THE LOAD-BEARING ONE. Without it, every absence asserted below is equally consistent with a
	// builder that emits a workbook `read-excel-file` cannot open at all, and the whole file would
	// be a green light for nothing.
	it('a benign workbook of identical structure parses to its literal value', async () => {
		expect.assertions(2);

		const result = await readImportFile(asUpload(controlWorkbook));
		expect(result.format).toBe('xlsx');
		expect(everyCell(result)).toContain(CONTROL_VALUE);
	});

	it('both hostile fixtures pass the signature gate and the size cap, so they reach the parser', () => {
		expect.assertions(4);

		for (const workbook of [xxeWorkbook, bombWorkbook]) {
			// `hasXlsxSignature` checks these four bytes before the buffer reaches read-excel-file. A
			// fixture failing here would be refused with `bad_extension` and never parsed, which
			// looks exactly like a parser refusing an entity.
			expect(Array.from(workbook.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
			expect(workbook.byteLength).toBeLessThan(IMPORT_FILE_MAX_BYTES);
		}
	});

	it('the canary file exists and is readable by this process', () => {
		expect.assertions(1);

		// So that "the canary contents are absent from the output" is a statement about the parser
		// and not about an empty file. The XXE payload names this exact path.
		expect(readFileSync(canaryPath, 'utf8')).toBe(CANARY_CONTENTS);
	});

	/**
	 * The control that closes the last gap: the three tests above prove the fixtures reach a working
	 * parser, and none of them proves the DETECTOR would notice a leak if one happened.
	 *
	 * So the leak is performed. Two workbooks are built carrying what an entity-expanding parser
	 * would have produced (the canary's contents in one cell, 19683 characters in the other) and the
	 * same two predicates are pointed at them. Both must report. Same reasoning as the local server
	 * that echoes TRACE in `e2e/error-shape-and-endpoints.spec.ts`: an absence assertion is worth
	 * what its ability to observe the presence is worth, and reading the code is not that.
	 */
	it('control: the same predicates DO report a workbook carrying the expanded results', async () => {
		expect.assertions(4);

		const leaked = await readImportFile(
			asUpload(buildWorkbook(sharedStrings('', CANARY_CONTENTS)), 'leaked.xlsx')
		);
		expect(leaked.rows[0]?.cells[0]).not.toBe('&xxe;');
		expect(everyCell(leaked)).toContain(CANARY_CONTENTS);

		const expanded = await readImportFile(
			asUpload(buildWorkbook(sharedStrings('', 'a'.repeat(EXPANDED_BOMB_LENGTH))), 'bomb.xlsx')
		);
		expect(expanded.rows[0]?.cells[0]).not.toBe('&e9;');
		expect(expanded.rows[0]?.cells[0]?.length).toBe(EXPANDED_BOMB_LENGTH);
	});
});

describe('v5.0.0-1.5.1: external entities are not resolved', () => {
	it('a SYSTEM entity naming a local file leaves the reference unexpanded, and the file unread', async () => {
		expect.assertions(3);

		const result = await readImportFile(asUpload(xxeWorkbook));
		const serialized = everyCell(result);

		// The measured outcome, not the absence of a disaster. A parser that resolved the entity
		// would put the file's contents here; one that refused it leaves the four characters of the
		// reference. Only the second of those is consistent with this assertion.
		expect(result.rows[0]?.cells[0]).toBe('&xxe;');
		expect(serialized).not.toContain(CANARY_CONTENTS);
		// The path too: an entity resolver that failed and reported the attempted target would
		// disclose the filesystem layout without disclosing the file.
		expect(serialized).not.toContain(canaryPath);
	});
});

describe('v5.0.0-5.2.2: an internal entity bomb expands to nothing', () => {
	it('a nine-level bomb yields the four-character reference rather than 19683 characters', async () => {
		expect.assertions(4);

		// The input figure is part of the claim: this is a small file, comfortably inside the upload
		// cap, whose declared expansion is four orders of magnitude larger. The danger of this family
		// is precisely that the cap cannot see it.
		expect(bombWorkbook.byteLength).toBeLessThan(IMPORT_FILE_MAX_BYTES);
		expect(EXPANDED_BOMB_LENGTH).toBe(19683);

		const result = await readImportFile(asUpload(bombWorkbook));
		const cell = result.rows[0]?.cells[0] ?? '';

		expect(cell).toBe('&e9;');
		// Stated as a length as well as a value, because the length is what the requirement is
		// about and it is the number that moves first if a future parser expands partially.
		expect(cell.length).toBeLessThan(EXPANDED_BOMB_LENGTH);
	});
});
