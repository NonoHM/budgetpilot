#!/usr/bin/env node
/**
 * The git side of the private-reference guards: what reaches git, whoever or whatever typed it.
 *
 *   node scripts/private-references-git.mjs pre-commit        (from .githooks/pre-commit)
 *   node scripts/private-references-git.mjs commit-msg <file> (from .githooks/commit-msg)
 *   node scripts/private-references-git.mjs pull-request      (from the pull request workflow)
 *
 * Each mode runs two checks and fails on either:
 *
 * 1. THE SHARED MATCHER (`scripts/private-references.mjs`) over the ADDED lines of the staged diff,
 *    over the commit message, or, for a pull request, over the added lines of its diff, every one
 *    of its commit messages, and its title and body: a squash merge copies those onto main. There
 *    is NO skip for this check, by design.
 * 2. GITLEAKS, for secrets, with `--redact` and `--ignore-gitleaks-allow` so an inline allow tag
 *    cannot silence it. Locally, a missing gitleaks FAILS with the install instruction unless
 *    `BP_SKIP_GITLEAKS=1` is set, and then it says plainly that secrets are not being scanned. In
 *    the pull request mode the skip is never honoured. Any non-zero exit blocks: gitleaks exits 1
 *    on a leak OR an error, and 126 on an unknown flag (its README, « Exit Codes »).
 *
 * Why the matcher reads ADDED lines only: a commit that removes a leak must be able to land, and
 * everything already tracked is read by `privateReferences.spec.ts` on every test run.
 *
 * The local gitleaks is checked for a minimum VERSION, not a checksum: a distribution package is a
 * rebuild whose hash matches no release asset, so a pinned hash would refuse every packaged
 * install. CI downloads the pinned release and verifies its SHA-256 before running it.
 *
 * Output is redacted (`redact()`), and in GitHub Actions wrapped in `::stop-commands::` so no
 * published text is read as a workflow command.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HOW_TO_READ, calibrate, findPrivateReferences, redact } from './private-references.mjs';

/** `git`, `stdin`, `--pre-commit` and `--staged` under `git` all arrived in 8.19.0. */
const GITLEAKS_MINIMUM = [8, 19, 0];
const GITLEAKS_COMMON = ['--redact', '--no-banner', '--verbose', '--ignore-gitleaks-allow'];
const INSTALL =
	'Install it (https://github.com/gitleaks/gitleaks#installing; on Arch: pacman -S gitleaks), ' +
	'or set BP_SKIP_GITLEAKS=1 for this command to commit WITHOUT a secret scan.';

/**
 * @typedef {{ location: string, text: string }} Source
 * @typedef {import('./private-references.mjs').Finding} Finding
 */

/** @param {string[]} args */
function git(args) {
	return execFileSync('git', args, { maxBuffer: 1024 * 1024 * 1024 }).toString('latin1');
}

/**
 * Added lines of a unified diff, each with the file and the line number it will have. Read one
 * line at a time, so a finding's line number is the file's, not the diff's.
 *
 * @param {string} diff
 * @returns {Source[]}
 */
export function addedLines(diff) {
	/** @type {Source[]} */
	const lines = [];
	let file = '';
	let next = 0;
	let inHunk = false;
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git ')) {
			inHunk = false;
			continue;
		}
		if (!inHunk && line.startsWith('+++ ')) {
			file = line === '+++ /dev/null' ? '' : line.slice(4).replace(/^b\//, '');
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			inHunk = true;
			next = Number(hunk[1]);
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith('+')) {
			lines.push({ location: `${file}:${next}`, text: line.slice(1) });
			next += 1;
		} else if (line.startsWith(' ')) next += 1;
	}
	return lines;
}

/**
 * The one scanning path for this file; the calibration goes through it too.
 *
 * @param {Source[]} sources
 * @param {boolean} perLine true when each source is one line whose location already carries it
 */
function scan(sources, perLine) {
	/** @type {(Finding & { location: string })[]} */
	const findings = [];
	for (const source of sources) {
		for (const finding of findPrivateReferences(source.text)) {
			findings.push({
				...finding,
				location: perLine ? source.location : `${source.location}:${finding.line}`
			});
		}
	}
	return findings;
}

/**
 * @param {Source[]} sources
 * @param {boolean} perLine
 * @param {string} what
 */
function matcherCheck(sources, perLine, what) {
	calibrate((text) => scan([{ location: 'planted', text }], false));
	const findings = scan(sources, perLine);
	console.error(`private-references: read ${sources.length} ${what}; ${findings.length} findings`);
	for (const f of findings) {
		console.error(
			`  ${f.location} [${f.kind}] ${redact(f)}\n    how to read it: ${HOW_TO_READ[f.kind]}`
		);
	}
	if (findings.length > 0) {
		console.error(
			'private-references: BLOCKED. AGENTS.md « Never publish anything derived from a real ' +
				'statement »: a commit on any branch is published once pushed, and a squash merge copies it onto main.'
		);
	}
	return findings.length === 0;
}

/** @param {string} text */
function versionOf(text) {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match ? match.slice(1).map(Number) : null;
}

/**
 * @param {string[]} args
 * @param {{ input?: string, allowSkip: boolean }} options
 */
function gitleaks(args, { input, allowSkip }) {
	const skip = allowSkip && process.env.BP_SKIP_GITLEAKS === '1';
	const version = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
	if (version.error) {
		if (skip) {
			console.error(
				'private-references: BP_SKIP_GITLEAKS=1 and gitleaks is not installed, so secrets are NOT ' +
					'being scanned in this commit. The private-reference check above still ran.'
			);
			return true;
		}
		console.error(`private-references: BLOCKED, gitleaks is not installed. ${INSTALL}`);
		return false;
	}
	const found = versionOf(`${version.stdout}${version.stderr}`);
	const tooOld =
		!found ||
		found[0] * 1e6 + found[1] * 1e3 + found[2] <
			GITLEAKS_MINIMUM[0] * 1e6 + GITLEAKS_MINIMUM[1] * 1e3 + GITLEAKS_MINIMUM[2];
	if (tooOld) {
		console.error(
			`private-references: BLOCKED, gitleaks reports version « ${version.stdout.trim()} » and ` +
				`these hooks need ${GITLEAKS_MINIMUM.join('.')} or later. ${INSTALL}`
		);
		return false;
	}
	if (!calibrateGitleaks()) return false;
	const run = spawnSync('gitleaks', [...args, ...GITLEAKS_COMMON], {
		input,
		stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit']
	});
	if (run.status !== 0) {
		console.error(
			`private-references: BLOCKED, gitleaks exited ${run.status ?? run.signal}: 1 is a leak or an ` +
				'error, 126 an unknown flag. Its redacted report is above.'
		);
		return false;
	}
	return true;
}

/**
 * A GitHub token shape, assembled at run time so no tracked file carries one, that gitleaks' rules
 * must report. `--exit-code 42` separates "found it" from 1, which gitleaks also returns on an
 * error, so a gitleaks that crashes cannot pass for one that found the plant.
 */
const PLANTED_TOKEN = `ghp_${['R8x2kQ7vN4mZ1pL9sT3w', 'Y6bH0cJ5dF2gA8eK'].join('')}`;

function calibrateGitleaks() {
	const run = spawnSync(
		'gitleaks',
		['stdin', '--no-banner', '--redact', '--exit-code', '42', '--ignore-gitleaks-allow'],
		{
			input: `token = "${PLANTED_TOKEN}"\n`,
			stdio: ['pipe', 'ignore', 'ignore']
		}
	);
	if (run.status !== 42) {
		console.error(
			`private-references: BLOCKED, gitleaks did not report the planted token (exit ` +
				`${run.status ?? run.signal}, expected 42), so a clean result from it would mean nothing.`
		);
		return false;
	}
	return true;
}

/** @param {string} message */
function withoutScissors(message) {
	const cut = message.search(/^# -+ >8 -+$/m);
	return cut < 0 ? message : message.slice(0, cut);
}

/** @returns {boolean} */
function preCommit() {
	const diff = git([
		'-c',
		'core.quotePath=false',
		'diff',
		'--cached',
		'--no-color',
		'--no-ext-diff',
		'--text',
		'--no-renames',
		'-U0'
	]);
	const matcher = matcherCheck(addedLines(diff), true, 'added lines in the staged diff');
	const secrets = gitleaks(['git', '--pre-commit', '--staged'], { allowSkip: true });
	return matcher && secrets;
}

/** @param {string} file */
function commitMsg(file) {
	const message = withoutScissors(readFileSync(file, 'utf8'));
	const matcher = matcherCheck(
		[{ location: 'commit message', text: message }],
		false,
		'commit message'
	);
	const secrets = gitleaks(['stdin'], { input: message, allowSkip: true });
	return matcher && secrets;
}

function pullRequest() {
	const base = process.env.BASE_SHA ?? '';
	const head = process.env.HEAD_SHA ?? '';
	if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
		console.error('private-references: BASE_SHA and HEAD_SHA must be full commit ids');
		return false;
	}
	const diff = git([
		'-c',
		'core.quotePath=false',
		'diff',
		'--no-color',
		'--no-ext-diff',
		'--text',
		'--no-renames',
		'-U0',
		`${base}...${head}`
	]);
	const shas = git(['rev-list', `${base}..${head}`])
		.split('\n')
		.filter(Boolean);
	const reported = Number(git(['rev-list', '--count', `${base}..${head}`]).trim());
	if (shas.length === 0 || shas.length !== reported) {
		console.error(
			`private-references: read ${shas.length} commits against ${reported} reported; refusing a clean result`
		);
		return false;
	}
	/** @type {Source[]} */
	const messages = shas.map((sha) => ({
		location: `commit ${sha.slice(0, 12)} message`,
		text: git(['log', '-1', '--format=%B', sha])
	}));
	/** @type {Source[]} */
	const pr = [
		{ location: 'pull request title', text: process.env.PR_TITLE ?? '' },
		{ location: 'pull request body', text: process.env.PR_BODY ?? '' }
	];
	const lines = addedLines(diff);
	const matcherDiff = matcherCheck(lines, true, `added lines in the pull request diff`);
	const matcherText = matcherCheck(
		[...messages, ...pr],
		false,
		`texts (${shas.length} commit messages, the title and the body)`
	);
	const secretsDiff = gitleaks(['git', `--log-opts=${base}..${head}`, '.'], { allowSkip: false });
	const secretsText = gitleaks(['stdin'], {
		input: [...messages, ...pr].map((source) => source.text).join('\n'),
		allowSkip: false
	});
	return matcherDiff && matcherText && secretsDiff && secretsText;
}

const mode = process.argv[2];
const token = randomBytes(16).toString('hex');
const inActions = process.env.GITHUB_ACTIONS === 'true';
if (inActions) console.log(`::stop-commands::${token}`);
let ok = false;
try {
	if (mode === 'pre-commit') ok = preCommit();
	else if (mode === 'commit-msg' && process.argv[3]) ok = commitMsg(process.argv[3]);
	else if (mode === 'pull-request') ok = pullRequest();
	else if (mode === 'calibrate-gitleaks') ok = calibrateGitleaks();
	else
		console.error(
			`private-references: unknown mode « ${mode} »; expected pre-commit, commit-msg <file> or pull-request`
		);
} catch (error) {
	console.error(
		`private-references: BLOCKED on an error, so nothing is reported clean: ${error instanceof Error ? error.message : error}`
	);
	ok = false;
}
if (inActions) console.log(`::${token}::`);
process.exit(ok ? 0 : 1);
