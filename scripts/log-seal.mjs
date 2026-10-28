#!/usr/bin/env node
/**
 * Verifies a captured log against the seal's verification key (#875).
 *
 *   docker compose logs --no-log-prefix budgetpilot \
 *     | docker compose exec -T budgetpilot /nodejs/bin/node scripts/log-seal.mjs verify --vkey "$(cat verification.vkey)"
 *
 * The log on standard input, one or more `--vkey` (one per key the instance has used). It imports
 * the verifier the tests drive, and the verifier imports the writer's own tree and note, so what it
 * checks is what the app wrote. docs/logging-howto.md, « Seal the log », is the operator's page.
 *
 * One report on stdout. Exit status: 0 verified, 1 broken, 3 unverified (no break, but lines no
 * signature covers, listed with their reason), 2 a refusal or nothing verified, with the reason on
 * stderr. All imports are static, so a module missing from the image fails at load.
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { verifyLog } from '../src/lib/server/logging/seal/verify.ts';

const EXIT = { verified: 0, broken: 1, nothing: 2, unverified: 3 };
const REFUSED = 2;

const USAGE = `Usage: log-seal.mjs verify --vkey <verification key> [--vkey <another>]
  Reads the log on standard input. --vkey takes the text of verification.vkey, and may be repeated
  for a log that spans a key change.`;

class Refusal extends Error {}

function parse() {
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: { vkey: { type: 'string', multiple: true } }
		});
	} catch {
		throw new Refusal(USAGE);
	}
	const { values, positionals } = parsed;
	if (positionals.length !== 1 || positionals[0] !== 'verify' || !values.vkey?.length) {
		throw new Refusal(USAGE);
	}
	return values.vkey;
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

/** The report, one fact per line, so a reader and `grep` both find what they look for. */
function render(report) {
	const lines = [
		`status: ${report.status}`,
		`lines read: ${report.linesRead}`,
		`lines not from the writer: ${report.linesNotFromWriter}`,
		`starts: ${report.starts}`,
		`checkpoints verified: ${report.checkpointsVerified}`,
		`lines no checkpoint covers: ${report.unsealedLines}`,
		`newest checkpoint signed at: ${
			report.newestCheckpointTime === null
				? 'none'
				: new Date(report.newestCheckpointTime * 1000).toISOString()
		}`
	];
	for (const host of report.hosts) {
		lines.push(
			`host ${host.host}: ${host.newestTailLines} line(s) after its newest checkpoint, signed at ${
				host.newestCheckpointTime === null
					? 'none'
					: new Date(host.newestCheckpointTime * 1000).toISOString()
			}`
		);
	}
	for (const notice of report.notices) lines.push(`notice ${notice.kind}: ${notice.lines} line(s)`);
	for (const item of report.unverified)
		lines.push(`unverified ${item.kind}: ${item.lines} line(s)`);
	for (const found of report.breaks) lines.push(`BREAK ${found.kind} at line ${found.line}`);
	return `${lines.join('\n')}\n`;
}

try {
	const vkeys = parse();
	const text = await readStdin();
	let report;
	try {
		report = verifyLog(text, vkeys);
	} catch (error) {
		throw new Refusal(error instanceof Error ? error.message : String(error));
	}
	process.stdout.write(render(report));
	if (report.status === 'nothing') {
		process.stderr.write(
			'No checkpoint verified: sealing was off, the log holds no checkpoint, or the key is not the one that signed it.\n'
		);
	}
	process.exitCode = EXIT[report.status];
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = REFUSED;
}
