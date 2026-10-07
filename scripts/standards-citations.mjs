/**
 * The ONE reading of the tracked ASVS 5.0.0 and AISVS 1.0 copies, and the ONE matcher for a citation
 * of either in a tracked file.
 *
 * Two consumers, and neither spells a pattern, a parse or a lookup of its own:
 *
 * - `.claude/skills/cite/scripts/resolve.mjs`: resolve an identifier BEFORE writing it.
 * - `src/lib/prose/standardsCitations.spec.ts`: every citation already written resolves (#650).
 *
 * Both answer through `lookup`, so an identifier the skill refuses is one the gate refuses.
 *
 * WHAT « RESOLVES » MEANS: the identifier EXISTS in the standard it is read as. Not that it is the
 * right one for the sentence, and not that the writer meant that standard: a real ASVS number cited
 * for the wrong requirement, or an ASVS 4.0.3 number that happens to exist in 5.0.0, resolves.
 *
 * Plain `.mjs` with no dependency, because the skill runs it under bare `node`.
 *
 * THIS FILE IS IN THE POPULATION THE GATE SCANS, so every identifier written in it must resolve.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ASVS_PATH =
	'docs/reference/standards/asvs-5.0.0/OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json';
export const AISVS_DIR = 'docs/reference/standards/aisvs-1.0/en';

/** @typedef {'ASVS' | 'AISVS'} Standard */
/**
 * @typedef {{ chapter_id: string, chapter_name: string, section_id: string, section_name: string,
 *   req_id: string, req_description: string, L: string }} AsvsRow
 */
/** @typedef {{ text: string, level: string, file: string }} AisvsRow */
/**
 * Either copy is null when it is missing from the tree, so a caller can say so rather than read an
 * empty standard as one in which nothing resolves. AISVS keys carry no chapter letter for the
 * chapters (`9.2.1`, section `9.2`) and keep their prefix for Appendix C (`AC.3.1`, section `AC.3`).
 *
 * @typedef {{
 *   asvs: AsvsRow[] | null,
 *   asvsSections: Map<string, string> | null,
 *   aisvs: Map<string, AisvsRow> | null,
 *   aisvsSections: Map<string, string> | null
 * }} Standards
 */

/**
 * Reads both tracked copies under `root`.
 *
 * @param {string} root the repository root
 * @returns {Standards}
 */
export function loadStandards(root) {
	const asvsPath = join(root, ASVS_PATH);
	const aisvsDir = join(root, AISVS_DIR);

	/** @type {AsvsRow[] | null} */
	let asvs = null;
	/** @type {Map<string, string> | null} */
	let asvsSections = null;
	if (existsSync(asvsPath)) {
		asvs = /** @type {{ requirements: AsvsRow[] }} */ (JSON.parse(readFileSync(asvsPath, 'utf8')))
			.requirements;
		asvsSections = new Map(asvs.map((r) => [r.section_id, r.section_name]));
	}

	/** @type {Map<string, AisvsRow> | null} */
	let aisvs = null;
	/** @type {Map<string, string> | null} */
	let aisvsSections = null;
	if (existsSync(aisvsDir)) {
		aisvs = new Map();
		aisvsSections = new Map();
		for (const f of readdirSync(aisvsDir).filter((n) => n.endsWith('.md'))) {
			for (const line of readFileSync(join(aisvsDir, f), 'utf8').split('\n')) {
				const m = line.match(
					/^\|\s*\*\*(\d+\.\d+\.\d+|AC\.\d+\.\d+)\*\*\s*\|\s*(.+?)\s*\|\s*(\d)\s*\|\s*$/
				);
				if (m) aisvs.set(m[1], { text: m[2].replace(/\*\*/g, ''), level: m[3], file: f });
				const heading = line.match(/^##\s+(?:C(\d+\.\d+)|(AC\.\d+))\s+(.+?)\s*$/);
				if (heading) aisvsSections.set(heading[1] ?? heading[2], heading[3]);
			}
		}
	}

	return { asvs, asvsSections, aisvs, aisvsSections };
}

/**
 * A known identifier of each kind, so a parse that silently reads nothing is told apart from a
 * standard in which nothing resolves. Returns the reason it failed, or null.
 *
 * @param {Standards} standards
 * @returns {string | null}
 */
export function calibrationFailure(standards) {
	/** @type {[Standard, string][]} */
	const known = [];
	if (standards.asvs) known.push(['ASVS', '8.2.2'], ['ASVS', '5.1']);
	if (standards.aisvs) known.push(['AISVS', '9.2.1'], ['AISVS', '9.2'], ['AISVS', 'AC.3.1']);
	for (const [standard, id] of known) {
		if (!lookup(standards, { standard, id })) return `${standard} ${id} not found in its copy`;
	}
	return null;
}

/**
 * @typedef {{ kind: 'requirement', level: string, text: string }
 *   | { kind: 'section', text: string }} Entry
 */

/**
 * What an identifier names in its standard, or undefined when it names nothing. The single
 * definition of « exists » for the skill and the gate: a requirement, else a section, and nothing
 * else, so a four-part slip or a chapter alone is reported rather than skipped.
 *
 * @param {Standards} standards
 * @param {{ standard: Standard, id: string }} citation ASVS `id` without its `V` (`8.2.2`, `5.1`);
 *   AISVS `id` without its `C` (`9.2.1`), Appendix C with its prefix (`AC.3.1`)
 * @returns {Entry | undefined}
 */
export function lookup(standards, { standard, id }) {
	if (standard === 'ASVS') {
		const row = standards.asvs?.find((r) => r.req_id === `V${id}`);
		if (row) return { kind: 'requirement', level: row.L, text: row.req_description };
		const section = standards.asvsSections?.get(`V${id}`);
		return section === undefined ? undefined : { kind: 'section', text: section };
	}
	const row = standards.aisvs?.get(id);
	if (row) return { kind: 'requirement', level: row.level, text: row.text };
	const section = standards.aisvsSections?.get(id);
	return section === undefined ? undefined : { kind: 'section', text: section };
}

/**
 * @param {Standards} standards
 * @param {{ standard: Standard, id: string }} citation
 * @returns {boolean}
 */
export function citationResolves(standards, citation) {
	return lookup(standards, citation) !== undefined;
}

/**
 * Files in which a bare backticked `` `14.1.2` `` is an ASVS 5.0.0 identifier, and nowhere else is
 * a bare number read. Each is a ledger or a header that names the standard once and then cites rows
 * by number; measured on 2026-10-07, every bare backticked three-part number in each was an ASVS
 * row, while elsewhere the same shape is a date (`01.06.2026` is not three-part, `1.2.3` in
 * `docs/operations.md` is a version) or a release.
 */
export const BARE_ASVS_FILES = new Map([
	['docs/reference/asvs-deltas.md', 'The ASVS deltas ledger: rows are cited by bare number.'],
	[
		'e2e/error-shape-and-endpoints.spec.ts',
		'Its header names the row it exists for by bare number.'
	],
	[
		'src/lib/server/security/crypto-allowlist.spec.ts',
		'Its header lists the six rows of one scan by bare number, between parentheticals.'
	]
]);

/**
 * Every spelling of a citation the tree uses, one pattern each, and the only place each is spelled.
 * Measured before writing (the PR that introduced this file carries the counts). Group 1 is the
 * identifier and always ends the match. It is read GREEDILY (`(?:\.\d+)+`) so that a four-part slip
 * is captured whole and fails to resolve, rather than matching nothing and passing.
 *
 * A LIST names its standard once and the rest bare (`v5.0.0-8.2.2/8.3.1`, « 3.3.1 through 3.3.4 »),
 * so every spelling with `list: true` is followed by `LIST_CONTINUATION`, and each number it reads
 * is a citation of the same standard under the spelling `<name>+list`.
 *
 * `skip` refuses a match that is not an identifier: a VERSION after the standard's name. No ASVS
 * section or requirement has a second part of 0, so `ASVS V5.0`, `ASVS V5.0.0` and `ASVS V4.0.3`
 * name the standard, never a row; the same holds for `AISVS V1.0`.
 *
 * Deliberately NOT recognised: a bare `C9.2.1` with no AISVS before it, a bare number with no
 * version or citation before it outside `BARE_ASVS_FILES` (an ASVS 4.0.3 number quoted as such is
 * the case it protects), a chapter on its own (`V5`), a number joined to a citation by words rather
 * than a separator (« 14.1.1 carries it, 16.2.5 »), and a table cell whose standard is named in
 * another cell. The PR that introduced this file lists the sites.
 *
 * @type {readonly { name: string, standard: Standard, pattern: RegExp, list: boolean,
 *   files?: Map<string, string>, skip?: (before: string, id: string) => boolean }[]}
 */
export const SPELLINGS = [
	// `v5.0.0-8.2.2`: the form the cite skill writes, and the most common by far. A `V` before the
	// number (`v5.0.0-V8.2.2`) is the same citation.
	{
		name: 'asvs-versioned',
		standard: 'ASVS',
		list: true,
		pattern: /(?<![\w.-])[vV]5\.0\.0-V?(\d+(?:\.\d+)+)(?!\w|\.\d)/g
	},
	// `V8.2.2`, and a section `V5.1`. Every one in the tree was an ASVS identifier when measured, so it
	// is matched with no context; a product version spelled this way would be the artefact to look for.
	// `-\d` and `-C\d` in the lookahead leave `V5.0.0-8.2.2` and `V1.0-C9.2.1` to the versioned forms.
	{
		name: 'asvs-v-prefixed',
		standard: 'ASVS',
		list: true,
		pattern: /(?<![\w.-])V(\d+(?:\.\d+)+)(?!\w|\.\d|-\d|-C\d)/g,
		skip: (before, id) => /\b(?:ASVS|AISVS)\s+$/.test(before) && /^\d+\.0(?:\.\d+)?$/.test(id)
	},
	// `ASVS 5.0.0 14.1.1` and `ASVS 5.0 16.2.5`: a bare number, so the version before it is required,
	// which is also what keeps the version itself from being read as an identifier.
	{
		name: 'asvs-after-name',
		standard: 'ASVS',
		list: true,
		pattern: /\bASVS\s+[vV]?5\.0(?:\.0)?\s+`?(\d+(?:\.\d+)+)(?!\w|\.\d)/g
	},
	// `` `14.1.2` `` in the files listed in `BARE_ASVS_FILES`, and only there.
	{
		name: 'asvs-bare-in-listed-file',
		standard: 'ASVS',
		list: false,
		files: BARE_ASVS_FILES,
		pattern: /(?<=`)(\d+\.\d+(?:\.\d+)+)(?=`)/g
	},
	// `aisvs:9.2.1`: the cite skill's argument form.
	{
		name: 'aisvs-colon',
		standard: 'AISVS',
		list: true,
		pattern: /\baisvs:C?(\d+(?:\.\d+)+)(?!\w|\.\d)/gi
	},
	// `v1.0-C9.2.1`: AISVS's own versioned referencing convention, also written `V1.0-C9.2.1`.
	{
		name: 'aisvs-versioned',
		standard: 'AISVS',
		list: true,
		pattern: /(?<![\w.-])[vV]1\.0-C(\d+(?:\.\d+)+)(?!\w|\.\d)/g
	},
	// `AISVS 9.2.1`, `AISVS C9.2.1`, `AISVS 1.0 C9.2`. The AISVS version `1.0` has the shape of a
	// section, so a two-part number is read only behind its chapter letter (`(?<=C)`); a bare one
	// after the name is the version (« AISVS 1.0 is locked »), never a section.
	{
		name: 'aisvs-after-name',
		standard: 'AISVS',
		list: true,
		pattern: /\bAISVS(?:\s+[vV]?1\.0)?\s+`?C?((?:\d+\.){2,}\d+|(?<=C)\d+(?:\.\d+)+)(?!\w|\.\d)/g
	},
	// `AC.3.1`, Appendix C, also as `aisvs:AC.3.1`. Matched with no context: measured on 2026-10-07,
	// all three uses outside the standards' own text were Appendix C rows in one table, two of them on
	// rows whose standard cell reads « same ».
	{
		name: 'aisvs-appendix-c',
		standard: 'AISVS',
		list: false,
		pattern: /(?<![\w.-])(AC\.\d+(?:\.\d+)*)(?!\w|\.\d)/g
	}
];

/** Spaces, or one line break followed by a comment marker (`//`, `*`, `#`) and indentation. */
const GAP = String.raw`[ \t]*(?:\r?\n[ \t]*(?:\/\/+|\*|#)?[ \t]*)?`;

/**
 * The next bare number of a list, read from the end of a citation: closing and opening code or bold
 * marks, a separator (comma or semicolon optionally followed by `and`/`or`, slash, `and`, `or`,
 * `through`), then the number, with at most one line break on either side of the separator so a
 * list wrapped across comment lines keeps its later items. Group 1 is a chapter letter, accepted in
 * an AISVS list only; group 2 is the identifier. Every spelling starts with a letter or a backtick
 * it does not consume, so a number read here is not read twice (and `findCitations` deduplicates by
 * position regardless).
 */
export const LIST_CONTINUATION = new RegExp(
	String.raw`^[\x60*]*${GAP}(?:[,;]${GAP}(?:(?:and|or)\b)?|\/|\b(?:and|or|through)\b)${GAP}[\x60*]*(C?)(\d+(?:\.\d+)+)(?!\w|\.\d)`
);

/** How far past a citation the next list item is looked for; one item with its gap is far shorter. */
const WINDOW = 200;

/** @typedef {{ line: number, raw: string, standard: Standard, id: string, spelling: string }} Citation */

/**
 * Every citation in `text`, in order of position, with the 1-based line of its identifier.
 *
 * @param {string} text
 * @param {string} [path] the file's repository path, which decides `BARE_ASVS_FILES`
 * @returns {Citation[]}
 */
export function findCitations(text, path) {
	const lineStarts = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
	/** @param {number} offset */
	const lineOf = (offset) => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};

	/** @type {Map<number, Citation>} keyed by the identifier's offset, so nothing is read twice */
	const found = new Map();
	for (const { name, standard, pattern, list, files, skip } of SPELLINGS) {
		if (files && !(path && files.has(path))) continue;
		for (const m of text.matchAll(pattern)) {
			const at = m.index + m[0].length - m[1].length;
			if (skip?.(text.slice(Math.max(0, m.index - 40), m.index), m[1])) continue;
			if (!found.has(at)) {
				found.set(at, { line: lineOf(at), raw: m[0], standard, id: m[1], spelling: name });
			}
			if (!list) continue;
			let end = m.index + m[0].length;
			for (let next = text.slice(end, end + WINDOW).match(LIST_CONTINUATION); next;) {
				if (next[1] === 'C' && standard !== 'AISVS') break;
				const idAt = end + next[0].length - next[2].length;
				if (!found.has(idAt)) {
					found.set(idAt, {
						line: lineOf(idAt),
						raw: next[1] + next[2],
						standard,
						id: next[2],
						spelling: `${name}+list`
					});
				}
				end += next[0].length;
				next = text.slice(end, end + WINDOW).match(LIST_CONTINUATION);
			}
		}
	}
	return [...found.entries()].sort(([a], [b]) => a - b).map(([, citation]) => citation);
}
