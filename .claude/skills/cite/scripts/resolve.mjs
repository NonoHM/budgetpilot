#!/usr/bin/env node
// Resolves ASVS 5.0.0 and AISVS 1.0 identifiers against the tracked copies and prints each one in the
// form a PR body quotes: identifier, level, text. Exits 1 if any identifier does not resolve, so an
// invented identifier with plausible text cannot reach a published page (it happened once, #650).
//
//   node .claude/skills/cite/scripts/resolve.mjs 8.2.2 V2.3.1 v5.0.0-16.5.1 aisvs:9.2.1
//
// The copies are tracked under docs/reference/standards/ (#601), each with its CC BY-SA 4.0 licence and
// provenance, so a clone has them. Missing means the tree was damaged: the message says where to look.
// Reading them is `scripts/standards-citations.mjs`, shared with the gate that checks every citation
// already in the tree (#650), so the two cannot disagree about what exists.
import { execFileSync } from 'node:child_process';
import {
	calibrationFailure,
	findAisvsRequirement,
	findAsvsRequirement,
	loadStandards
} from '../../../../scripts/standards-citations.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const ids = process.argv.slice(2);
if (ids.length === 0) {
	console.error('usage: resolve.mjs <ASVS id>... [aisvs:<id>]...');
	process.exit(2);
}

const standards = loadStandards(root);
const asvs = standards.asvs;
const aisvsRows = standards.aisvs;

// Calibrate in the same run: a known identifier must resolve, or every answer below is about the
// parser, not the standard.
const calibration = calibrationFailure(standards);
if (calibration) {
	console.error(`calibration failed: ${calibration}`);
	process.exit(2);
}

let missing = 0;
for (const raw of ids) {
	if (/^aisvs:/i.test(raw)) {
		const id = raw.replace(/^aisvs:/i, '').replace(/^C/i, '');
		if (!aisvsRows) {
			console.log(
				`${raw}: tracked AISVS copy missing: expected docs/reference/standards/aisvs-1.0/en/ (#601)`
			);
			missing++;
			continue;
		}
		const r = findAisvsRequirement(standards, id);
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
			`${raw}: tracked ASVS copy missing: expected docs/reference/standards/asvs-5.0.0/ (#601)`
		);
		missing++;
		continue;
	}
	const r = findAsvsRequirement(standards, id);
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
