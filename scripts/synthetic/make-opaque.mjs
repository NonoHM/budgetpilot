#!/usr/bin/env node
/**
 * N files whose headers nothing recognises, each a DIFFERENT shape.
 *
 * A mapping is remembered per header-row fingerprint, so driving a user to the cap needs N
 * distinct header rows rather than N copies of one file. Same synthetic ledger as
 * make-synthetic.mjs — Paul Mercier, invented merchants — only the column NAMES vary.
 *
 *   node scripts/synthetic/make-opaque.mjs scr/synthetic/opaque 4
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , out, countRaw] = process.argv;
if (!out) {
	console.error('usage: make-opaque.mjs <dir> [count]');
	process.exit(2);
}
const count = Number(countRaw ?? 4);

const ROWS = [
	['2026-06-01', 'Mercerie Lafayette', '-45.20'],
	['2026-06-02', 'Pharmacie du Pont', '-18.90'],
	['2026-06-03', 'Salaire', '2450.00'],
	['2026-06-05', 'Transports Urbains', '-62.00']
];

mkdirSync(out, { recursive: true });
for (let i = 1; i <= count; i += 1) {
	// Distinct header names per file, so each lands on its own fingerprint.
	const header = [`zone_${i}a`, `zone_${i}b`, `zone_${i}c`].join(',');
	const body = ROWS.map((r) => r.join(',')).join('\n');
	const name = `opaque-${String(i).padStart(2, '0')}.csv`;
	writeFileSync(join(out, name), `${header}\n${body}\n`, 'utf8');
	console.log(name, header);
}
