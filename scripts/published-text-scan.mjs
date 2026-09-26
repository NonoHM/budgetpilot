#!/usr/bin/env node
/**
 * Reads what this repository has ALREADY PUBLISHED and is not a tracked file: every issue and pull
 * request title and body, every conversation comment, review comment and review body, every
 * release body and commit comment, and every commit message on the checked-out branch. Runs the
 * shared matcher (`scripts/private-references.mjs`) over all of it and fails on a finding.
 *
 * The before-the-fact guards (the Claude Code hook, the git hooks, the pull request check) cannot
 * see text typed into the GitHub web UI, nor anything posted before they existed. This is the
 * after-the-fact half, run daily by `.github/workflows/published-text-scan.yml`.
 *
 * THE LOG IS PUBLIC. It prints a location, a kind and `redact()`'s form of the match, never the
 * match itself, and inside a `::stop-commands::` block so no published text can be read as a
 * workflow command.
 *
 * FAILS CLOSED, in the three ways a scan reports clean without having read anything:
 * - a fetch that fails throws, and the run fails naming it;
 * - a run that read no issue, no comment or no commit fails;
 * - a run that read fewer issues and pull requests (or commits) than the repository reports, from
 *   a SECOND listing that is not the one iterated, fails. A filter added to the fetch cannot
 *   shrink both sides at once.
 * And it calibrates in the same run: the planted sample goes through `scanItems`, the function the
 * real items go through, and every kind must be found exactly once before any result is believed.
 *
 * THE BASELINE. `.private-references-baseline` lists findings already published before these
 * guards existed, which are not rewritten away (history rewriting does not remove text from forks,
 * cached views or pull request refs, and edits keep a history). Each line is a fingerprint, the
 * location and the reason; the fingerprint is a SHA-256 of location, kind and match, so the file
 * names nothing and admits exactly one occurrence in one place. An entry that no longer matches
 * anything fails the run too, so the file cannot accumulate entries that outlived their reason.
 *
 * Plain `.mjs`, no dependency beyond `node`, `gh` and `git`, like `cve-acknowledgements.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { KINDS, calibrate, findPrivateReferences, redact } from './private-references.mjs';

/**
 * @typedef {'item' | 'comment' | 'commit'} ItemKind
 * @typedef {{ kind: ItemKind, number?: number, where: string, text: string }} Item
 * @typedef {{ issues: number, pulls: number, commits: number }} Totals
 * @typedef {{ totals: () => Totals, items: () => Item[] }} ScanSource
 * @typedef {{ fingerprint: string, location: string, reason: string }} BaselineEntry
 * @typedef {{ location: string, kind: import('./private-references.mjs').Kind, line: number, shown: string, fingerprint: string }} ScanFinding
 */

/** @param {Item} item */
function locationOf(item) {
	return item.number === undefined ? item.where : `#${item.number} ${item.where}`;
}

/**
 * The whole LINE goes in, not only the match: the claude.ai pattern matches just the host, so a
 * fingerprint of the match alone would admit any new address added to a baselined issue body later.
 * With the line, an edit to it is a new finding (and the old entry goes stale).
 *
 * @param {string} location
 * @param {string} kind
 * @param {string} match
 * @param {string} line
 */
export function fingerprint(location, kind, match, line) {
	return createHash('sha256').update(`${location}\0${kind}\0${match}\0${line}`).digest('hex');
}

/**
 * The one path every item takes, planted sample included.
 *
 * @param {Item[]} items
 * @returns {ScanFinding[]}
 */
export function scanItems(items) {
	/** @type {ScanFinding[]} */
	const findings = [];
	for (const item of items) {
		const location = locationOf(item);
		const lines = item.text.split('\n');
		for (const finding of findPrivateReferences(item.text)) {
			findings.push({
				location,
				kind: finding.kind,
				line: finding.line,
				shown: redact(finding),
				fingerprint: fingerprint(
					location,
					finding.kind,
					finding.match,
					lines[finding.line - 1] ?? ''
				)
			});
		}
	}
	return findings;
}

/**
 * `<64 hex> <location...> -- <reason>`, one per line; `#` starts a comment.
 *
 * @param {string} text
 * @returns {BaselineEntry[]}
 */
export function parseBaseline(text) {
	/** @type {BaselineEntry[]} */
	const entries = [];
	for (const [index, raw] of text.split('\n').entries()) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const match = /^([0-9a-f]{64}) (.+?) -- (.+)$/.exec(line);
		if (!match) {
			throw new Error(
				`baseline line ${index + 1} is not "<sha256> <location> -- <reason>", so it is refused ` +
					'rather than read as admitting nothing'
			);
		}
		entries.push({ fingerprint: match[1], location: match[2], reason: match[3] });
	}
	return entries;
}

/**
 * @param {ScanSource} source
 * @param {(line: string) => void} log
 * @param {BaselineEntry[]} [baseline]
 * @returns {0 | 1}
 */
export function runScan(source, log, baseline = []) {
	try {
		const planted = calibrate((text) =>
			scanItems([{ kind: 'item', where: 'planted', text }]).map((f) => ({
				kind: f.kind,
				line: f.line,
				match: f.shown
			}))
		);
		log(`calibration: ${KINDS.map((kind) => `${kind} ${planted[kind]}`).join(', ')}`);

		const totals = source.totals();
		const items = source.items();
		const count = (/** @type {ItemKind} */ kind) => items.filter((i) => i.kind === kind).length;
		const read = { items: count('item'), comments: count('comment'), commits: count('commit') };
		log(
			`read ${read.items} issues and pull requests and ${read.comments} comments, ` +
				`${read.commits} commit messages; the repository reports ${totals.issues} issues, ` +
				`${totals.pulls} pull requests and ${totals.commits} commits`
		);

		const refusals = [];
		if (read.items === 0) refusals.push('read no issue or pull request');
		if (read.items < totals.issues + totals.pulls) {
			refusals.push(
				`read ${read.items} issues and pull requests, fewer than the ` +
					`${totals.issues + totals.pulls} the repository reports`
			);
		}
		if (read.commits < totals.commits) {
			refusals.push(
				`read ${read.commits} commit messages, fewer than the ${totals.commits} reported`
			);
		}
		if (refusals.length > 0) {
			for (const refusal of refusals)
				log(`REFUSED: ${refusal}. A clean result would mean nothing.`);
			return 1;
		}

		const findings = scanItems(items);
		const admitted = new Set(baseline.map((entry) => entry.fingerprint));
		const fresh = findings.filter((f) => !admitted.has(f.fingerprint));
		const seen = new Set(findings.map((f) => f.fingerprint));
		const stale = baseline.filter((entry) => !seen.has(entry.fingerprint));

		log(
			`${findings.length} findings, ${findings.length - fresh.length} of them in the baseline ` +
				`(${baseline.length} entries), ${fresh.length} new, ${stale.length} stale baseline entries`
		);
		for (const f of fresh) {
			log(`${f.location} line ${f.line} [${f.kind}] ${f.shown} fingerprint ${f.fingerprint}`);
		}
		for (const entry of stale) {
			log(
				`STALE baseline entry ${entry.fingerprint} (${entry.location}): nothing matches it any ` +
					'more. Remove the line; an entry that outlived its reason is how an allowlist rots.'
			);
		}
		if (fresh.length > 0) {
			log(
				'A new finding is a private reference in published text. Correct the text on GitHub; the ' +
					'edit history keeps the old version, so ask GitHub support to purge it if it matters. ' +
					'Only a finding reviewed and ruled on goes in .private-references-baseline, with its reason.'
			);
		}
		return fresh.length > 0 || stale.length > 0 ? 1 : 0;
	} catch (error) {
		log(`FAILED, so nothing is reported clean: ${error instanceof Error ? error.message : error}`);
		return 1;
	}
}

/**
 * `gh api --paginate` with a jq filter that prints one compact JSON value per line.
 *
 * @param {string[]} args
 * @returns {any[]}
 */
function ghLines(args) {
	const out = execFileSync('gh', ['api', '--paginate', ...args], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024 * 1024
	});
	return out
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line));
}

/**
 * @param {string} repo `owner/name`
 * @returns {ScanSource}
 */
export function githubSource(repo) {
	const [owner, name] = repo.split('/');
	if (!owner || !name) throw new Error(`"${repo}" is not owner/name`);
	return {
		totals() {
			const data = JSON.parse(
				execFileSync(
					'gh',
					[
						'api',
						'graphql',
						'-f',
						'query=query($o:String!,$n:String!){repository(owner:$o,name:$n){issues{totalCount} pullRequests{totalCount}}}',
						'-F',
						`o=${owner}`,
						'-F',
						`n=${name}`
					],
					{ encoding: 'utf8' }
				)
			);
			const commits = Number(
				execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()
			);
			return {
				issues: data.data.repository.issues.totalCount,
				pulls: data.data.repository.pullRequests.totalCount,
				commits
			};
		},
		items() {
			/** @type {Item[]} */
			const items = [];
			for (const issue of ghLines([
				`repos/${repo}/issues?state=all&per_page=100`,
				'--jq',
				'.[] | {number, title, body}'
			])) {
				items.push({
					kind: 'item',
					number: issue.number,
					where: 'title and body',
					text: `${issue.title ?? ''}\n${issue.body ?? ''}`
				});
			}
			for (const c of ghLines([
				`repos/${repo}/issues/comments?per_page=100`,
				'--jq',
				'.[] | {id, body, number: (.issue_url | split("/") | last | tonumber)}'
			])) {
				items.push({
					kind: 'comment',
					number: c.number,
					where: `comment ${c.id}`,
					text: c.body ?? ''
				});
			}
			for (const c of ghLines([
				`repos/${repo}/pulls/comments?per_page=100`,
				'--jq',
				'.[] | {id, body, number: (.pull_request_url | split("/") | last | tonumber)}'
			])) {
				items.push({
					kind: 'comment',
					number: c.number,
					where: `review comment ${c.id}`,
					text: c.body ?? ''
				});
			}
			for (const pr of ghLines([
				'graphql',
				'-f',
				'query=query($o:String!,$n:String!,$endCursor:String){repository(owner:$o,name:$n){pullRequests(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{number reviews(first:100){totalCount nodes{databaseId body}}}}}}',
				'-F',
				`o=${owner}`,
				'-F',
				`n=${name}`,
				'--jq',
				'.data.repository.pullRequests.nodes[] | {number, total: .reviews.totalCount, reviews: [.reviews.nodes[] | {id: .databaseId, body}]}'
			])) {
				if (pr.reviews.length < pr.total) {
					throw new Error(`#${pr.number} has ${pr.total} reviews and only 100 are fetched`);
				}
				for (const review of pr.reviews) {
					items.push({
						kind: 'comment',
						number: pr.number,
						where: `review ${review.id}`,
						text: review.body ?? ''
					});
				}
			}
			for (const c of ghLines([
				`repos/${repo}/comments?per_page=100`,
				'--jq',
				'.[] | {id, body, commit: .commit_id[0:7]}'
			])) {
				items.push({
					kind: 'comment',
					where: `commit comment ${c.id} on ${c.commit}`,
					text: c.body ?? ''
				});
			}
			for (const r of ghLines([
				`repos/${repo}/releases?per_page=100`,
				'--jq',
				'.[] | {tag: .tag_name, name, body}'
			])) {
				items.push({
					kind: 'comment',
					where: `release ${r.tag}`,
					text: `${r.name ?? ''}\n${r.body ?? ''}`
				});
			}
			const log = execFileSync('git', ['log', '--format=%H%x1f%B%x1e', 'HEAD'], {
				encoding: 'utf8',
				maxBuffer: 1024 * 1024 * 1024
			});
			for (const record of log.split('\x1e')) {
				const [sha, message] = record.replace(/^\n/, '').split('\x1f');
				if (!sha || message === undefined) continue;
				items.push({ kind: 'commit', where: `commit ${sha.slice(0, 12)}`, text: message });
			}
			return items;
		}
	};
}

function isMain() {
	if (!process.argv[1]) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isMain()) {
	const repo = process.argv[2] ?? process.env.GITHUB_REPOSITORY ?? '';
	const baselinePath = process.argv[3] ?? '.private-references-baseline';
	// Published text reaches this log, redacted or not, so no line of it may be read as a workflow
	// command. The token is random per run, as the workflow-commands reference requires.
	const token = randomBytes(16).toString('hex');
	const inActions = process.env.GITHUB_ACTIONS === 'true';
	if (inActions) console.log(`::stop-commands::${token}`);
	let status = /** @type {0 | 1} */ (1);
	try {
		const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
		status = runScan(githubSource(repo), (line) => console.log(line), baseline);
	} catch (error) {
		console.log(`FAILED before scanning: ${error instanceof Error ? error.message : error}`);
	}
	if (inActions) console.log(`::${token}::`);
	process.exit(status);
}
