import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * No private reference in anything published. AGENTS.md carries the rule and the reasoning, in
 * « Never publish anything derived from a real statement »; this file is the half of it that is
 * enforced.
 *
 * THREE KINDS, each one something a public reader cannot open and that identifies the owner:
 * a claude.ai address (a session, an artifact or a Claude Design canvas), an absolute path inside
 * somebody's home directory (it carries a username), and an email address that could reach a
 * person. A reserved test domain and a short list of published role addresses are the only
 * addresses a tracked file may carry.
 *
 * TWO SURFACES, and the boundary is the same one `emDashesInProse.spec.ts` draws. Tracked files
 * are read here. Commit messages, PR bodies, issues and comments are not files, so nothing in this
 * repository sees them before they are posted, and AGENTS.md says so rather than implying a check
 * that does not exist.
 *
 * EVERY TRACKED FILE IS READ, and that is the difference from the em dash gate rather than an
 * oversight. That gate reads prose a reader meets; this one reads what a clone carries, because a
 * clone is what is published. So there is deliberately no exclusion list, and the first test
 * asserts the number of files read equals the tracked count, so adding one is a decision somebody
 * has to write down here. The cases that looked like candidates, each measured at 0 findings on
 * 2026-09-26:
 *
 * - `package-lock.json` is READ. It is published exactly like a source file, and a dependency
 *   resolved from an ssh remote or a local `file:` path would put a machine's address in it. If it
 *   fires there, the lockfile is carrying something `npm ci` in a fresh clone would also receive.
 * - `CHANGELOG.md` is READ, although release-please writes it from commit subjects already on
 *   `main` and it is never edited by hand. A finding there means the leak is already in `main`'s
 *   history; the gate reddening is the right news, and the remedy is the owner's call.
 * - GENERATED CLIENTS ARE NOT READ BECAUSE THEY ARE NOT TRACKED. `prisma generate` and Paraglide
 *   both write under gitignored directories (only `database/generated/README.md` is tracked, and
 *   it is read), so there is nothing to exclude. A generated file that becomes tracked is read
 *   like any other, because it is then published like any other.
 * - BINARY FILES ARE READ, as raw bytes decoded one byte per character (latin1). All three
 *   patterns are ASCII, so a PNG's text chunk naming the path it was saved from is found exactly
 *   as it would be in a source file, and a byte that is not ASCII can never complete a match.
 *   Decoding as UTF-8 instead would turn every invalid sequence into U+FFFD and shift nothing the
 *   patterns read, but latin1 keeps one decoding for every file, which is the point.
 *
 * CALIBRATED IN THE SAME PASS. `scanTree` runs the planted sample through `findPrivateReferences`,
 * the one matcher the tree scan uses, in the same call that reads the tree, so the detector that
 * reported the tree clean is the detector that just found each planted kind.
 *
 * BREAK-CHECKED, each clause separately, restored from a pre-break copy (2026-09-26):
 *
 * - Pattern (a) replaced by one that matches nothing: the calibration test goes red, missing the
 *   planted claude.ai address; the tree test stays green. Separates a detector that sees a
 *   claude.ai address from one that is blind to it.
 * - Pattern (b) replaced likewise: calibration red on all three planted home paths. Same pair of
 *   states for a home-directory path.
 * - Pattern (c) replaced likewise: calibration red on the planted personal address. Same pair for
 *   an email.
 * - A positive of each kind appended to a tracked file (`docs/configuration.md`), gate intact: the
 *   tree test goes red naming that file and line. Separates a tree carrying the kind in a tracked
 *   file from a clean tree; with the kind's pattern broken as above, the same plant is green, so
 *   that pattern alone is what caught it.
 * - `isReservedDomain` answering true for everything: calibration red, the planted personal
 *   address is accepted. Separates "reserved domains are admitted" from "every domain is".
 * - `isReservedDomain` answering false for everything: the tree test goes red with 248 findings,
 *   every fixture address under `example.test`, `.invalid` and the rest. Separates a gate that admits the
 *   reserved domains from one that would force fixtures onto real domains.
 * - `PUBLIC_ROLE_ADDRESSES` emptied: the tree test goes red with 3 findings, `docs/bank-sync.md`
 *   and this file's own entry and negative sample, and the calibration finds 6 where it expects 5.
 *   Separates an allowlist that is load-bearing from one that is decoration.
 * - The reader skipping files containing a NUL: the count test goes red, 1057 read against 1133
 *   tracked. Separates a scan of every tracked file from a scan of the text ones.
 * - The allowlisted address removed from `docs/bank-sync.md` (the sentence reworded to name no
 *   address): only the staleness test goes red, naming the entry and its file; the tree test stays
 *   green because nothing offends. Separates an allowlist entry whose reason still holds from one
 *   that outlived it and would silently admit the address anywhere.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Kind = 'claude-address' | 'home-path' | 'personal-email';

/**
 * One pattern per kind, and the only place each is spelled. Every one is written so that its own
 * source text cannot match it, because this file is in the population it scans.
 */
const PATTERNS: Record<Kind, RegExp> = {
	// (a) The host followed by a slash, so an address with a path. The bare word, as AGENTS.md
	// uses it in prose (« a claude.ai session »), is not an address and is not matched.
	'claude-address': /claude\.ai\//gi,
	// (b) A home-directory path with a name after it: Linux, macOS, and a Windows profile directory
	// with either separator, escaped or not. The lookbehind keeps a URL path segment out (a
	// `/home/` route under some host is preceded by a word character), while `file:///` and a path
	// opening a string or a line are still found.
	'home-path':
		/(?<![\w.-])\/(?:home|Users)\/[A-Za-z0-9._-]+|\b[A-Za-z]:(?:\\{1,2}|\/)[Uu][Ss][Ee][Rr][Ss](?:\\{1,2}|\/)/g,
	// (c) Anything shaped like an address. Which domains are allowed is decided afterwards, by
	// `isPublishableAddress`, so the shape and the policy can be broken separately.
	'personal-email': /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
};

/** Second-level names reserved for documentation by RFC 2606; a subdomain of one is reserved too. */
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'];

/**
 * Top-level names that are never delegated on the public internet, so an address under one cannot
 * reach anybody. `.test`, `.example`, `.invalid` and `.localhost`: RFC 2606 and RFC 6761. `.local`:
 * multicast DNS, RFC 6762. `.internal`: reserved by ICANN for private use. `.lan`: undelegated, and
 * named among private-use names in RFC 6762 Appendix G; `docs/database-providers.md` uses it for a
 * database host.
 */
const RESERVED_SUFFIXES = [
	'.test',
	'.example',
	'.invalid',
	'.localhost',
	'.local',
	'.internal',
	'.lan'
];

/**
 * Addresses a vendor PUBLISHES for anyone to write to. Kept short on purpose: an entry is a
 * decision, and it carries its reason and the file that needs it. The last test asserts each entry
 * still appears there, so an entry cannot outlive its reason unnoticed.
 */
const PUBLIC_ROLE_ADDRESSES: { address: string; file: string; reason: string }[] = [
	{
		address: 'support.api@enablebanking.com',
		file: 'docs/bank-sync.md',
		reason:
			"Enable Banking's published API support address, named so an operator can ask the " +
			'provider directly. A role address, not a person.'
	}
];

function isReservedDomain(domain: string): boolean {
	const lower = domain.toLowerCase();
	return (
		RESERVED_DOMAINS.some((reserved) => lower === reserved || lower.endsWith(`.${reserved}`)) ||
		RESERVED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
	);
}

function isPublishableAddress(address: string): boolean {
	const lower = address.toLowerCase();
	if (PUBLIC_ROLE_ADDRESSES.some((entry) => entry.address === lower)) return true;
	return isReservedDomain(lower.slice(lower.lastIndexOf('@') + 1));
}

/** How to tell a true positive from an artefact, per kind. Printed beside every finding. */
const HOW_TO_READ: Record<Kind, string> = {
	'claude-address':
		'always a true positive: no public reader can open it and it identifies the account. Name ' +
		'what it is (« a private Claude Design canvas ») and keep the address in the gitignored ' +
		'notes under docs/superpowers/.',
	'home-path':
		'a true positive when the segment after the home directory is a username on some machine. ' +
		'An artefact only when it is a fixed path inside a container image rather than anybody’s ' +
		'account; write a repository-relative path, or a placeholder, instead of the absolute one.',
	'personal-email':
		'a true positive when the address could reach a person or name an account. An artefact when ' +
		'the shape is not an address at all (an ssh remote, a password in a URL, an image asset ' +
		'suffix). Move a fixture to a reserved domain (example.test, example.com, .invalid); a ' +
		"vendor's published role address goes in PUBLIC_ROLE_ADDRESSES with its reason."
};

interface Finding {
	kind: Kind;
	line: number;
	match: string;
}

/** The one matcher. The tree scan and the calibration both call it and nothing else. */
function findPrivateReferences(text: string): Finding[] {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
	const lineOf = (offset: number) => {
		let line = 0;
		while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line += 1;
		return line + 1;
	};

	const findings: Finding[] = [];
	for (const kind of Object.keys(PATTERNS) as Kind[]) {
		for (const match of text.matchAll(PATTERNS[kind])) {
			if (kind === 'personal-email' && isPublishableAddress(match[0])) continue;
			findings.push({ kind, line: lineOf(match.index), match: match[0] });
		}
	}
	return findings.sort((a, b) => a.line - b.line);
}

/**
 * The planted sample. Every positive is assembled at run time, because a literal one in this file
 * would be a finding against this file. The negatives are literal on purpose: each is a shape the
 * tree really carries and the gate must keep admitting.
 */
const CLAUDE_HOST = ['claude', 'ai'].join('.');
const CALIBRATION_SAMPLE = [
	`canvas: https://${CLAUDE_HOST}/design/p/0000`,
	`cwd: ${['', 'home', 'someone', 'repo'].join('/')}`,
	`cwd: ${['', 'Users', 'someone', 'repo'].join('/')}`,
	`cwd: ${['C:', 'Users', 'someone'].join('\\')}`,
	`contact: ${['sophie.martin', 'gmail.com'].join('@')}`,
	// Negatives, one per admission rule.
	'the bare word claude.ai, as prose names it',
	'a@example.test USER@Example.COM x@db.example.lan v@budgetpilot.invalid',
	'postgres://user:hunter2@db.internal:5432/app',
	'support.api@enablebanking.com',
	'https://example.com/home/page/'
].join('\n');

const EXPECTED_CALIBRATION: Finding[] = [
	{ kind: 'claude-address', line: 1, match: `${CLAUDE_HOST}/` },
	{ kind: 'home-path', line: 2, match: ['', 'home', 'someone'].join('/') },
	{ kind: 'home-path', line: 3, match: ['', 'Users', 'someone'].join('/') },
	{ kind: 'home-path', line: 4, match: ['C:', 'Users', ''].join('\\') },
	{ kind: 'personal-email', line: 5, match: ['sophie.martin', 'gmail.com'].join('@') }
];

function trackedFiles(): string[] {
	return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
		.split('\0')
		.filter(Boolean);
}

/** Reads the tree and runs the calibration in one pass, through the same matcher. */
function scanTree() {
	let filesRead = 0;
	let binaryRead = 0;
	const offenders: string[] = [];
	for (const path of trackedFiles()) {
		const bytes = readFileSync(`${REPO_ROOT}${path}`);
		filesRead += 1;
		if (bytes.includes(0)) binaryRead += 1;
		for (const finding of findPrivateReferences(bytes.toString('latin1'))) {
			offenders.push(
				`${path}:${finding.line} [${finding.kind}] ${finding.match}: ${HOW_TO_READ[finding.kind]}`
			);
		}
	}
	const calibration = findPrivateReferences(CALIBRATION_SAMPLE);
	return { filesRead, binaryRead, offenders, calibration };
}

describe('no private reference in anything published', () => {
	const scan = scanTree();

	// Printed rather than only asserted, so a reader of a green run can see what it read.
	console.info(
		`privateReferences: read ${scan.filesRead} tracked files (${scan.binaryRead} binary), ` +
			`${scan.offenders.length} findings; calibration found ${scan.calibration.length}, ` +
			`expects ${EXPECTED_CALIBRATION.length}`
	);

	it('reads every tracked file, binaries included, so a clean result cannot mean an empty list', () => {
		expect.assertions(3);

		// Counted by a SECOND listing rather than the one the scan iterated, so a filter added to
		// the scan cannot shrink both sides at once. Measured 2026-09-26: 1133 tracked with this file,
		// 76 of them binary; the floors leave room for ordinary deletions and none for the enumeration
		// collapsing or the binaries silently dropping out.
		const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
			.split('\n')
			.filter(Boolean).length;
		expect(scan.filesRead).toBe(tracked);
		expect(scan.filesRead).toBeGreaterThan(1000);
		expect(scan.binaryRead).toBeGreaterThan(50);
	});

	it('finds every planted positive, and only those, through the matcher the tree scan uses', () => {
		expect.assertions(1);

		expect(scan.calibration).toEqual(EXPECTED_CALIBRATION);
	});

	it('finds no private reference in any tracked file', () => {
		expect.assertions(1);

		expect(
			scan.offenders,
			'Each entry is file:line [kind] match, then how to tell a true positive from an artefact.'
		).toEqual([]);
	});

	it('keeps each allowlisted address only while the file its reason names still uses it', () => {
		expect.assertions(PUBLIC_ROLE_ADDRESSES.length);

		for (const entry of PUBLIC_ROLE_ADDRESSES) {
			expect(
				readFileSync(`${REPO_ROOT}${entry.file}`, 'utf8').toLowerCase(),
				`${entry.address} is allowlisted for ${entry.file}, which no longer carries it`
			).toContain(entry.address);
		}
	});
});
