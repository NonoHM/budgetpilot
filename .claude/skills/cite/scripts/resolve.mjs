#!/usr/bin/env node
// Resolves ASVS 5.0.0 and AISVS 1.0 identifiers against the local copies and prints each one in the
// form a PR body quotes: identifier, level, text. Exits 1 if any identifier does not resolve, so an
// invented identifier with plausible text cannot reach a published page (it happened once, #650).
//
//   node .claude/skills/cite/scripts/resolve.mjs 8.2.2 V2.3.1 v5.0.0-16.5.1 aisvs:9.2.1
//
// The copies are gitignored (#601, #536): a clone without them gets exit 2 and the path to fetch.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
// A linked worktree has no gitignored files: read the copies from the main checkout.
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
	encoding: 'utf8'
}).trim();
const bases = [root, join(common, '..')];
const find = (rel) => bases.map((b) => join(b, rel)).find((p) => existsSync(p));

const asvsPath = find(
	'scripts/security/asvs-5.0-source/OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json'
);
const aisvsDir = find('scripts/security/aisvs-1.0-source/en');

const ids = process.argv.slice(2);
if (ids.length === 0) {
	console.error('usage: resolve.mjs <ASVS id>... [aisvs:<id>]...');
	process.exit(2);
}

let asvs = null;
if (asvsPath) asvs = JSON.parse(readFileSync(asvsPath, 'utf8')).requirements;
let aisvsRows = null;
if (aisvsDir) {
	aisvsRows = new Map();
	for (const f of readdirSync(aisvsDir).filter((n) => n.endsWith('.md'))) {
		for (const line of readFileSync(join(aisvsDir, f), 'utf8').split('\n')) {
			const m = line.match(/^\|\s*\*\*(\d+\.\d+\.\d+)\*\*\s*\|\s*(.+?)\s*\|\s*(\d)\s*\|\s*$/);
			if (m) aisvsRows.set(m[1], { text: m[2].replace(/\*\*/g, ''), level: m[3], file: f });
		}
	}
}

// Calibrate in the same run: a known identifier must resolve, or every answer below is about the
// parser, not the standard.
if (asvs && !asvs.some((r) => r.req_id === 'V8.2.2')) {
	console.error('calibration failed: V8.2.2 not found in the ASVS copy');
	process.exit(2);
}
if (aisvsRows && !aisvsRows.has('9.2.1')) {
	console.error('calibration failed: 9.2.1 not found in the AISVS copy');
	process.exit(2);
}

let missing = 0;
for (const raw of ids) {
	if (/^aisvs:/i.test(raw)) {
		const id = raw.replace(/^aisvs:/i, '').replace(/^C/i, '');
		if (!aisvsRows) {
			console.log(
				`${raw}: no local AISVS copy: download it per .claude/skills/cite/references/registry.md (#601)`
			);
			missing++;
			continue;
		}
		const r = aisvsRows.get(id);
		if (!r) {
			console.log(`${raw}: NOT FOUND in AISVS 1.0`);
			missing++;
			continue;
		}
		console.log(`AISVS 1.0 C${id} (Level ${r.level}): "${r.text}"`);
		continue;
	}
	const id = 'V' + raw.replace(/^v5\.0\.0-/i, '').replace(/^V/i, '');
	if (!asvs) {
		console.log(
			`${raw}: no local ASVS copy: download it per .claude/skills/cite/references/registry.md (#601)`
		);
		missing++;
		continue;
	}
	const r = asvs.find((x) => x.req_id === id);
	if (!r) {
		console.log(`${raw}: NOT FOUND in ASVS 5.0.0`);
		missing++;
		continue;
	}
	const above = Number(r.L) > 2 ? ', above our Level 2 target' : '';
	console.log(`ASVS v5.0.0-${id.slice(1)} (Level ${r.L}${above}): "${r.req_description}"`);
}
console.log(
	`resolved ${ids.length - missing} of ${ids.length}; read ${asvs ? asvs.length : 0} ASVS and ${aisvsRows ? aisvsRows.size : 0} AISVS requirements`
);
process.exit(missing ? 1 : 0);
