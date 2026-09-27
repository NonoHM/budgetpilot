#!/usr/bin/env node
/**
 * The git side of the private-reference guards: what reaches git, whoever or whatever typed it.
 *
 *   node scripts/private-references-git.mjs pre-commit        (from .githooks/pre-commit)
 *   node scripts/private-references-git.mjs commit-msg <file> (from .githooks/commit-msg)
 *   node scripts/private-references-git.mjs pull-request      (from the pull request workflow)
 *   node scripts/private-references-git.mjs history           (from the daily scan: every ref)
 *
 * Every gitleaks call names `.gitleaksignore`, the reviewed historical findings as fingerprints
 * only; `history` fails when the findings without it are not exactly the ones it lists.
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
 * The local gitleaks is judged by CAPABILITY, not a checksum: a distribution package is a rebuild
 * whose hash matches no release asset, and the Arch one prints a sentence where the version would
 * be. Its help must list every flag passed here, and it must find a planted token. CI downloads
 * the pinned release and verifies its SHA-256 before running it.
 *
 * Output is redacted (`redact()`), and in GitHub Actions wrapped in `::stop-commands::` so no
 * published text is read as a workflow command.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * The flags the hooks and the pull request mode pass, per gitleaks subcommand. A build is accepted
 * by CAPABILITY: its own help for each subcommand must list every one of them. An unknown flag
 * would otherwise surface only as exit 126 on the first real commit.
 */
const GITLEAKS_NEEDS = {
	git: [
		'--pre-commit',
		'--staged',
		'--log-opts',
		...GITLEAKS_COMMON,
		'--exit-code',
		'--gitleaks-ignore-path',
		'--report-path',
		'--report-format'
	],
	stdin: [...GITLEAKS_COMMON, '--exit-code', '--gitleaks-ignore-path']
};

/** @returns {string | null} what is missing, or null when every flag is listed */
function missingCapability() {
	for (const [subcommand, flags] of Object.entries(GITLEAKS_NEEDS)) {
		const help = spawnSync('gitleaks', [subcommand, '--help'], { encoding: 'utf8' });
		if (help.status !== 0) return `« gitleaks ${subcommand} --help » exited ${help.status}`;
		const text = `${help.stdout}${help.stderr}`;
		const absent = flags.find(
			(flag) => !new RegExp(`(^|\\s)${flag}(?=[\\s=\\[,]|$)`, 'm').test(text)
		);
		if (absent)
			return `gitleaks ${subcommand} --help does not list ${absent}, which the hooks pass`;
	}
	return null;
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
	const ready = gitleaksReady(allowSkip);
	if (ready !== true) return ready === 'skipped';
	const run = spawnSync(
		'gitleaks',
		[...args, ...GITLEAKS_COMMON, '--gitleaks-ignore-path', ignoreFile()],
		{
			input,
			stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit']
		}
	);
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
 * The reviewed historical findings, one fingerprint per line (commit:file:rule:line), read by every
 * gitleaks call through `--gitleaks-ignore-path`. gitleaks also reads the file at the root of the
 * repository it scans whatever that flag says (measured on 8.30.1), which is why `history` scans a
 * bare mirror to see the findings WITHOUT it.
 */
function ignoreFile() {
	return join(git(['rev-parse', '--show-toplevel']).trim(), '.gitleaksignore');
}

/** @param {string} path */
function fingerprintsIn(path) {
	return readFileSync(path, 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * The daily scan of every ref's history. Refuses unless the findings WITHOUT the ignore file are
 * exactly the reviewed ones it lists: a new one fails, and so does an entry nothing matches any
 * more. The reviewed findings are the calibration: a gitleaks that found none of them would report
 * every entry stale. Reports go to a temporary directory, never the working tree, and only
 * fingerprints (locations, no values) are printed.
 */
function history() {
	const ready = gitleaksReady(false);
	if (ready !== true) return false;
	const top = git(['rev-parse', '--show-toplevel']).trim();
	const ignore = ignoreFile();
	const listed = fingerprintsIn(ignore);
	const malformed = listed.filter((line) => !/^[0-9a-f]{40}:[^:]+:[A-Za-z0-9-]+:\d+$/.test(line));
	if (listed.length === 0 || malformed.length > 0) {
		console.error(
			`private-references: ${ignore} lists ${listed.length} fingerprints, ${malformed.length} of ` +
				'them not shaped commit:file:rule:line (a comment must be a whole line of its own)'
		);
		return false;
	}
	const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'gitleaks-history-'));
	try {
		const mirror = join(dir, 'mirror.git');
		execFileSync('git', ['clone', '--quiet', '--mirror', top, mirror]);
		const empty = join(dir, 'empty-ignore');
		writeFileSync(empty, '');
		/** @param {string} ignorePath @param {string} name */
		const scan = (ignorePath, name) => {
			const report = join(dir, name);
			const run = spawnSync(
				'gitleaks',
				[
					'git',
					'--log-opts=--all',
					'--gitleaks-ignore-path',
					ignorePath,
					'--report-format',
					'json',
					'--report-path',
					report,
					'--exit-code',
					'42',
					'--redact',
					'--no-banner',
					'--ignore-gitleaks-allow',
					mirror
				],
				{ encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
			);
			if (run.status !== 0 && run.status !== 42) {
				throw new Error(`gitleaks exited ${run.status ?? run.signal} scanning the history`);
			}
			const commits = Number(/(\d+) commits scanned/.exec(run.stderr ?? '')?.[1] ?? 0);
			/** @type {{ Fingerprint: string }[]} */
			const findings = JSON.parse(readFileSync(report, 'utf8'));
			return { commits, fingerprints: findings.map((finding) => finding.Fingerprint) };
		};
		const all = scan(empty, 'gitleaks-history-all.json');
		const kept = scan(ignore, 'gitleaks-history-kept.json');
		const fresh = all.fingerprints.filter((f) => !listed.includes(f));
		const stale = listed.filter((f) => !all.fingerprints.includes(f));
		const honoured =
			kept.fingerprints.length === fresh.length &&
			kept.fingerprints.every((f) => fresh.includes(f));
		console.error(
			`private-references: gitleaks read ${all.commits} commits on every ref; ` +
				`${all.fingerprints.length} findings without the ignore file, ${listed.length} listed, ` +
				`${fresh.length} new, ${stale.length} stale, ${kept.fingerprints.length} with the file`
		);
		for (const f of fresh) console.error(`  new finding at ${f}`);
		for (const f of stale)
			console.error(`  stale entry ${f}: nothing matches it any more; remove it`);
		if (!honoured) {
			console.error(
				'private-references: gitleaks did not honour --gitleaks-ignore-path, which every hook and ' +
					'check relies on to know the reviewed findings'
			);
		}
		if (all.commits === 0) console.error('private-references: gitleaks read no commit');
		return fresh.length === 0 && stale.length === 0 && honoured && all.commits > 0;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Installed, capable and calibrated, or not. `'skipped'` only locally, with BP_SKIP_GITLEAKS=1
 * and no gitleaks at all, and it says so.
 *
 * @param {boolean} allowSkip
 * @returns {true | false | 'skipped'}
 */
function gitleaksReady(allowSkip) {
	const skip = allowSkip && process.env.BP_SKIP_GITLEAKS === '1';
	const version = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
	if (version.error) {
		if (skip) {
			console.error(
				'private-references: BP_SKIP_GITLEAKS=1 and gitleaks is not installed, so secrets are NOT ' +
					'being scanned in this commit. The private-reference check above still ran.'
			);
			return 'skipped';
		}
		console.error(`private-references: BLOCKED, gitleaks is not installed. ${INSTALL}`);
		return false;
	}
	// A printed version number is checked when there is one; a distribution build prints a sentence
	// instead (Arch: « version is set by build process »), and is judged by what it can do below.
	const found = versionOf(`${version.stdout}${version.stderr}`);
	const tooOld =
		found !== null &&
		found[0] * 1e6 + found[1] * 1e3 + found[2] <
			GITLEAKS_MINIMUM[0] * 1e6 + GITLEAKS_MINIMUM[1] * 1e3 + GITLEAKS_MINIMUM[2];
	if (tooOld) {
		console.error(
			`private-references: BLOCKED, gitleaks reports version « ${version.stdout.trim()} » and ` +
				`these hooks need ${GITLEAKS_MINIMUM.join('.')} or later. ${INSTALL}`
		);
		return false;
	}
	const missing = missingCapability();
	if (missing) {
		console.error(`private-references: BLOCKED, ${missing}. ${INSTALL}`);
		return false;
	}
	return calibrateGitleaks();
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
	else if (mode === 'history') ok = history();
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
