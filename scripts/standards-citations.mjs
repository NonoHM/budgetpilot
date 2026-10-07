/**
 * The ONE reading of the tracked ASVS 5.0.0 and AISVS 1.0 copies, and the ONE matcher for a citation
 * of either in a tracked file.
 *
 * Two consumers, and neither spells a pattern or a parse of its own:
 *
 * - `.claude/skills/cite/scripts/resolve.mjs`: resolve an identifier BEFORE writing it.
 * - `src/lib/prose/standardsCitations.spec.ts`: every citation already written resolves (#650).
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
 * empty standard as one in which nothing resolves.
 *
 * @typedef {{
 *   asvs: AsvsRow[] | null,
 *   asvsSections: Set<string> | null,
 *   aisvs: Map<string, AisvsRow> | null,
 *   aisvsSections: Set<string> | null
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
	/** @type {Set<string> | null} */
	let asvsSections = null;
	if (existsSync(asvsPath)) {
		asvs = /** @type {{ requirements: AsvsRow[] }} */ (JSON.parse(readFileSync(asvsPath, 'utf8')))
			.requirements;
		asvsSections = new Set(asvs.map((r) => r.section_id));
	}

	/** @type {Map<string, AisvsRow> | null} */
	let aisvs = null;
	/** @type {Set<string> | null} */
	let aisvsSections = null;
	if (existsSync(aisvsDir)) {
		aisvs = new Map();
		aisvsSections = new Set();
		for (const f of readdirSync(aisvsDir).filter((n) => n.endsWith('.md'))) {
			for (const line of readFileSync(join(aisvsDir, f), 'utf8').split('\n')) {
				const m = line.match(/^\|\s*\*\*(\d+\.\d+\.\d+)\*\*\s*\|\s*(.+?)\s*\|\s*(\d)\s*\|\s*$/);
				if (m) aisvs.set(m[1], { text: m[2].replace(/\*\*/g, ''), level: m[3], file: f });
				const heading = line.match(/^##\s+C(\d+\.\d+)\s/);
				if (heading) aisvsSections.add(heading[1]);
			}
		}
	}

	return { asvs, asvsSections, aisvs, aisvsSections };
}

/**
 * A known identifier from each copy, so a parse that silently reads nothing is told apart from a
 * standard in which nothing resolves. Returns the reason it failed, or null.
 *
 * @param {Standards} standards
 * @returns {string | null}
 */
export function calibrationFailure(standards) {
	if (standards.asvs && !standards.asvs.some((r) => r.req_id === 'V8.2.2')) {
		return 'V8.2.2 not found in the ASVS copy';
	}
	if (standards.aisvs && !standards.aisvs.has('9.2.1')) {
		return '9.2.1 not found in the AISVS copy';
	}
	return null;
}

/**
 * @param {Standards} standards
 * @param {string} reqId an ASVS requirement id in the source's own form, `V8.2.2`
 * @returns {AsvsRow | undefined}
 */
export function findAsvsRequirement(standards, reqId) {
	return standards.asvs?.find((r) => r.req_id === reqId);
}

/**
 * @param {Standards} standards
 * @param {string} id an AISVS requirement id without its chapter letter, `9.2.1`
 * @returns {AisvsRow | undefined}
 */
export function findAisvsRequirement(standards, id) {
	return standards.aisvs?.get(id);
}

/**
 * Whether a citation's identifier exists in its standard: three parts name a requirement, two name
 * a section, and anything else names nothing, so a four-part slip is reported rather than skipped.
 *
 * @param {Standards} standards
 * @param {{ standard: Standard, id: string }} citation `id` is digits and dots only
 * @returns {boolean}
 */
export function citationResolves(standards, { standard, id }) {
	const parts = id.split('.').length;
	if (standard === 'ASVS') {
		if (parts === 3) return findAsvsRequirement(standards, `V${id}`) !== undefined;
		if (parts === 2) return standards.asvsSections?.has(`V${id}`) ?? false;
		return false;
	}
	if (parts === 3) return findAisvsRequirement(standards, id) !== undefined;
	if (parts === 2) return standards.aisvsSections?.has(id) ?? false;
	return false;
}

/**
 * Every spelling of a citation the tree uses, one pattern each, and the only place each is spelled.
 * Measured before writing (#650's PR body carries the counts and the command). Group 1 is always
 * the identifier as digits and dots. The identifier is read GREEDILY (`(?:\.\d+)+`) so that a
 * four-part slip is captured whole and fails to resolve, rather than matching nothing and passing.
 *
 * A LIST names its standard once and the rest bare (`v5.0.0-8.2.2/8.3.1`, « 3.3.1 through 3.3.4 »),
 * so every spelling is followed by `LIST_CONTINUATION`, and each number it reads is a citation of
 * the same standard under the spelling `<name>+list`.
 *
 * Deliberately NOT recognised: a bare `C9.2.1` with no AISVS before it, a bare number with no
 * version or citation before it (an ASVS 4.0.3 number quoted as such is the case it protects), a
 * chapter on its own (`V5`), a number joined to a citation by words rather than a separator
 * (« 14.1.1 classifies it and 16.2.5 »), and a table cell whose standard is named in another cell.
 * Where the tree uses those, the PR that introduced this file lists the sites.
 *
 * @type {readonly { name: string, standard: Standard, pattern: RegExp }[]}
 */
export const SPELLINGS = [
	// `v5.0.0-8.2.2`: the form the cite skill writes, and the most common by far.
	{
		name: 'asvs-versioned',
		standard: 'ASVS',
		pattern: /(?<![\w.-])[vV]5\.0\.0-(\d+(?:\.\d+)+)(?!\w|\.\d)/g
	},
	// `V8.2.2`, and a section `V5.1`. Every one in the tree was an ASVS identifier when measured, so it
	// is matched with no context; a product version spelled this way would be the artefact to look for.
	// `-\d` in the lookahead leaves a capital `V5.0.0-8.2.2` to the versioned spelling alone.
	{
		name: 'asvs-v-prefixed',
		standard: 'ASVS',
		pattern: /(?<![\w.-])V(\d+(?:\.\d+)+)(?!\w|\.\d|-\d)/g
	},
	// `ASVS 5.0.0 14.1.1` and `ASVS 5.0 16.2.5`: a bare number, so the version before it is required,
	// which is also what keeps the version itself from being read as an identifier.
	{
		name: 'asvs-after-name',
		standard: 'ASVS',
		pattern: /\bASVS\s+v?5\.0(?:\.0)?\s+`?(\d+(?:\.\d+)+)(?!\w|\.\d)/g
	},
	// `aisvs:9.2.1`: the cite skill's argument form.
	{ name: 'aisvs-colon', standard: 'AISVS', pattern: /\baisvs:C?(\d+(?:\.\d+)+)(?!\w|\.\d)/gi },
	// `v1.0-C9.2.1`: AISVS's own versioned referencing convention.
	{
		name: 'aisvs-versioned',
		standard: 'AISVS',
		pattern: /(?<![\w.-])v1\.0-C(\d+(?:\.\d+)+)(?!\w|\.\d)/g
	},
	// `AISVS 9.2.1`, `AISVS C9.2.1`, `AISVS 1.0 C9.2`. The AISVS version `1.0` has the shape of a
	// section, so a two-part number is read only behind its chapter letter (`(?<=C)`); a bare one
	// after the name is the version (« AISVS 1.0 is locked »), never a section.
	{
		name: 'aisvs-after-name',
		standard: 'AISVS',
		pattern: /\bAISVS(?:\s+v?1\.0)?\s+`?C?((?:\d+\.){2,}\d+|(?<=C)\d+(?:\.\d+)+)(?!\w|\.\d)/g
	}
];

/**
 * The next bare number of a list, read from the end of a citation: closing and opening code or bold
 * marks, then one separator (comma, slash, semicolon, `and`, `or`, `through`), then the number.
 * Every spelling above starts with a letter, so this cannot read a number another spelling reads.
 */
export const LIST_CONTINUATION =
	/^[`*]*\s*(?:,|\/|;|\b(?:and|or|through)\b)\s*[`*]*(\d+(?:\.\d+)+)(?!\w|\.\d)/;

/** @typedef {{ line: number, raw: string, standard: Standard, id: string, spelling: string }} Citation */

/**
 * Every citation in `text`, line by line, each spelling's matches followed by their list
 * continuations, with a 1-based line number.
 *
 * @param {string} text
 * @returns {Citation[]}
 */
export function findCitations(text) {
	/** @type {Citation[]} */
	const found = [];
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		for (const { name, standard, pattern } of SPELLINGS) {
			for (const m of line.matchAll(pattern)) {
				found.push({ line: index + 1, raw: m[0], standard, id: m[1], spelling: name });
				let end = m.index + m[0].length;
				for (let next = line.slice(end).match(LIST_CONTINUATION); next;) {
					found.push({
						line: index + 1,
						raw: next[1],
						standard,
						id: next[1],
						spelling: `${name}+list`
					});
					end += next[0].length;
					next = line.slice(end).match(LIST_CONTINUATION);
				}
			}
		}
	}
	return found;
}
