/**
 * The ONE definition of a private reference, and nothing else: the patterns, the reserved domains,
 * the allowlist with its reasons, the matcher, the redaction a public log may print, and the planted
 * sample every guard calibrates on before it believes a clean result.
 *
 * AGENTS.md « Never publish anything derived from a real statement » carries the rule. Four guards
 * enforce it, and every one of them imports this file rather than spelling a pattern of its own:
 *
 * - `src/lib/prose/privateReferences.spec.ts`: every tracked file, on every test run.
 * - `.claude/hooks/private-references.mjs`: a Claude Code PreToolUse hook, before a commit or a post.
 * - `.githooks/pre-commit` and `.githooks/commit-msg`: the staged lines and the message, before a
 *   commit exists.
 * - `scripts/published-text-scan.mjs`: every issue and pull request body and comment, daily.
 *
 * A second copy of a pattern is how one guard goes blind while the others stay green, so there is
 * none. Plain `.mjs` with no dependency, because a git hook and a CI step run it under bare `node`
 * with no build and possibly no `node_modules`.
 *
 * THIS FILE IS IN THE POPULATION THE TREE GATE SCANS, so every pattern is written so that its own
 * source cannot match it, and every planted positive below is assembled at run time.
 */

/**
 * @typedef {'claude-address' | 'home-path' | 'personal-email' | 'scanner-bypass' | 'iban' | 'external-image'} Kind
 */
/** @typedef {{ kind: Kind, line: number, match: string }} Finding */

/** @type {readonly Kind[]} */
export const KINDS = [
	'claude-address',
	'home-path',
	'personal-email',
	'scanner-bypass',
	'iban',
	'external-image'
];

/**
 * One pattern per kind, and the only place each is spelled.
 *
 * @type {Record<Kind, RegExp>}
 */
export const PATTERNS = {
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
	'personal-email': /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
	// (d) The two inline tags that tell a secret scanner to skip a line: gitleaks' allow comment and
	// TruffleHog's ignore comment. Not a private reference itself, but the one thing that turns the
	// secret half of these guards off for a line while every run still reports clean, so a NEW one
	// is refused wherever the matcher reads. The colon is written as a class so this source line
	// does not carry the tag it forbids. The workflows also pass `--ignore-gitleaks-allow` and
	// `--no-ignore-tag`, so an old tag cannot silence them either.
	'scanner-bypass': /gitleaks[:]allow|trufflehog[:]ignore/gi,
	// (e) An IBAN: two letters, two check digits, then the account, grouped by spaces or not. The
	// shape alone would fire on any long code, so `admitted` below keeps only a candidate whose
	// country is in `IBAN_LENGTHS` and whose first that-many characters pass the ISO 13616 mod-97
	// check, which a random string passes once in 97. Statement-derived data carries one on every
	// export, which is why it is here beside the references.
	iban: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
	// (f) An image rendered from an outside host: a Markdown image whose URL is absolute, or an HTML `<img
	// src=..>`. Rendering it makes the reader's client fetch that URL, which is a known way for an
	// agent-written body to carry data out in the URL. Only images, not links; the host is judged
	// by `IMAGE_HOSTS` afterwards.
	'external-image':
		/!\[[^\]\n]*\]\(\s*<?https?:\/\/[^)\s>]+|<img\b[^>\n]*\bsrc\s*=\s*["']?https?:\/\/[^"'\s>]+/gi
};

/**
 * Account lengths by country, from the ISO 13616 IBAN registry. A country missing here is not
 * detected at all, a false negative this list accepts over the alternative of trying every length,
 * which would pass one random prefix in five.
 *
 * @type {Record<string, number>}
 */
export const IBAN_LENGTHS = {
	AD: 24,
	AE: 23,
	AL: 28,
	AT: 20,
	AZ: 28,
	BA: 20,
	BE: 16,
	BG: 22,
	BH: 22,
	BR: 29,
	BY: 28,
	CH: 21,
	CR: 22,
	CY: 28,
	CZ: 24,
	DE: 22,
	DK: 18,
	DO: 28,
	EE: 20,
	EG: 29,
	ES: 24,
	FI: 18,
	FO: 18,
	FR: 27,
	GB: 22,
	GE: 22,
	GI: 23,
	GL: 18,
	GR: 27,
	GT: 28,
	HR: 21,
	HU: 28,
	IE: 22,
	IL: 23,
	IQ: 23,
	IS: 26,
	IT: 27,
	JO: 30,
	KW: 30,
	KZ: 20,
	LB: 28,
	LC: 32,
	LI: 21,
	LT: 20,
	LU: 20,
	LV: 21,
	MC: 27,
	MD: 24,
	ME: 22,
	MK: 19,
	MR: 27,
	MT: 31,
	MU: 30,
	NL: 18,
	NO: 15,
	PK: 24,
	PL: 28,
	PS: 29,
	PT: 25,
	QA: 29,
	RO: 24,
	RS: 22,
	SA: 24,
	SC: 31,
	SE: 24,
	SI: 19,
	SK: 24,
	SM: 27,
	ST: 25,
	SV: 28,
	TL: 23,
	TN: 24,
	TR: 26,
	UA: 29,
	VA: 22,
	VG: 24,
	XK: 20
};

/**
 * The IBAN a candidate starts with, compacted, if it has one, else null.
 *
 * @param {string} candidate
 */
export function ibanIn(candidate) {
	const compact = candidate.replace(/ /g, '');
	const length = IBAN_LENGTHS[compact.slice(0, 2)];
	if (!length || compact.length < length) return null;
	const iban = compact.slice(0, length);
	let remainder = 0;
	for (const char of iban.slice(4) + iban.slice(0, 4)) {
		const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
		for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
	}
	return remainder === 1 ? iban : null;
}

/**
 * IBANs published as EXAMPLES, which the test fixtures use because they identify nobody. Same
 * contract as `PUBLIC_ROLE_ADDRESSES`: each names a file that must still carry it.
 *
 * @type {readonly { iban: string, file: string, reason: string }[]}
 */
export const EXAMPLE_IBANS = [
	{
		iban: 'FR7630006000011234567890189',
		file: 'src/lib/server/reports/monthly.spec.ts',
		reason: 'the French example IBAN printed in banking documentation and specifications'
	},
	{
		iban: 'FR7630001007941234567890185',
		file: 'src/lib/server/import/multiAccountRefusal.spec.ts',
		reason: "the French example IBAN in Wikipedia's IBAN article, sequential digits"
	},
	{
		iban: 'DE89370400440532013000',
		file: 'src/lib/server/import/profiles/realHeaders.fixture.ts',
		reason: 'the German example IBAN from the ECBS and Wikipedia IBAN documentation'
	},
	{
		iban: 'FR3730001007949876543210192',
		file: 'src/lib/server/import/multiAccountRefusal.spec.ts',
		reason:
			'built for the tests from the Wikipedia example with the digits reversed, valid by construction'
	}
];

/**
 * Hosts an image may be rendered from: GitHub's own, and the three badge services the README uses.
 * Anything else is an outside fetch the reader's client makes on the author's behalf.
 */
export const IMAGE_HOSTS = [
	'github.com',
	'.githubusercontent.com',
	'img.shields.io',
	'api.securityscorecards.dev',
	'www.bestpractices.dev',
	// The compatibility-score badge GitHub puts in every Dependabot pull request body.
	'dependabot-badges.githubapp.com'
];

/**
 * What a shape match must also be to count, per kind. A kind absent here counts on its shape.
 *
 * @type {Partial<Record<Kind, (match: string) => boolean>>}
 */
const COUNTS = {
	'personal-email': (match) => !isPublishableAddress(match),
	iban: (match) => {
		const iban = ibanIn(match);
		return iban !== null && !EXAMPLE_IBANS.some((entry) => entry.iban === iban);
	},
	'external-image': (match) => {
		const url = /https?:\/\/[^)\s>"']+/i.exec(match)?.[0] ?? '';
		let host = '';
		try {
			host = new URL(url).host.toLowerCase();
		} catch {
			return true;
		}
		return !IMAGE_HOSTS.some((allowed) =>
			allowed.startsWith('.') ? host.endsWith(allowed) : host === allowed
		);
	}
};

/** Second-level names reserved for documentation by RFC 2606; a subdomain of one is reserved too. */
export const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'];

/**
 * Top-level names that are never delegated on the public internet, so an address under one cannot
 * reach anybody. `.test`, `.example`, `.invalid` and `.localhost`: RFC 2606 and RFC 6761. `.local`:
 * multicast DNS, RFC 6762. `.internal`: reserved by ICANN for private use. `.lan`: undelegated, and
 * named among private-use names in RFC 6762 Appendix G; `docs/database-providers.md` uses it for a
 * database host.
 */
export const RESERVED_SUFFIXES = [
	'.test',
	'.example',
	'.invalid',
	'.localhost',
	'.local',
	'.internal',
	'.lan'
];

/**
 * Addresses published for anyone to write to, or that no one can write to at all. Kept short on
 * purpose: an entry is a decision, and it carries its reason and WHERE it is needed.
 *
 * `file` names a tracked file that must still carry the address; the tree gate asserts it, so a
 * file entry cannot outlive its reason unnoticed. `surface` names a place that is not a file (a
 * commit trailer), which no test can re-read; such an entry is admitted everywhere a file entry
 * is, so its reason has to hold for every surface, and it is the one kind to question first.
 *
 * @type {readonly ({ address: string, reason: string } & ({ file: string } | { surface: string }))[]}
 */
export const PUBLIC_ROLE_ADDRESSES = [
	{
		address: 'support.api@enablebanking.com',
		file: 'docs/bank-sync.md',
		reason:
			"Enable Banking's published API support address, named so an operator can ask the " +
			'provider directly. A role address, not a person.'
	},
	{
		address: 'support@github.com',
		surface: 'the Signed-off-by trailer Dependabot writes on every commit it authors',
		reason:
			"GitHub's published support address, and the trailer lands on main with every Dependabot " +
			'merge, so the scheduled scan of commit messages would otherwise fail on each one.'
	},
	{
		address: '117260525+nonohm@users.noreply.github.com',
		surface:
			'the Co-authored-by trailer GitHub adds when the repository owner edits a Dependabot pull request',
		reason:
			"GitHub's no-reply form of the repository owner's account: it delivers no mail, and the " +
			'account it names is the one in the repository URL.'
	},
	{
		address: 'noreply@anthropic.com',
		surface: 'the Co-Authored-By trailer on commits written with Claude Code',
		reason:
			'A no-reply address that reaches nobody, required on every such commit by the ' +
			'attribution rule, so the commit-msg and Claude Code hooks would otherwise refuse the ' +
			'trailer the repository asks for.'
	}
];

/** @param {string} domain */
export function isReservedDomain(domain) {
	const lower = domain.toLowerCase();
	return (
		RESERVED_DOMAINS.some((reserved) => lower === reserved || lower.endsWith(`.${reserved}`)) ||
		RESERVED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
	);
}

/** @param {string} address */
export function isPublishableAddress(address) {
	const lower = address.toLowerCase();
	if (PUBLIC_ROLE_ADDRESSES.some((entry) => entry.address === lower)) return true;
	return isReservedDomain(lower.slice(lower.lastIndexOf('@') + 1));
}

/**
 * How to tell a true positive from an artefact, per kind. Printed beside every finding.
 *
 * @type {Record<Kind, string>}
 */
export const HOW_TO_READ = {
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
		"vendor's published role address goes in PUBLIC_ROLE_ADDRESSES with its reason.",
	'scanner-bypass':
		'always refused: the tag tells a secret scanner to skip its line, so a secret beside it ' +
		'passes every scan while the run reports clean. Use a fake value the scanner does not ' +
		'match (see the CI keys in ci.yml), or name the tag in prose without its colon.',
	iban:
		'a true positive unless the value is a published example. It passed the mod-97 check, so it ' +
		'is a well-formed account number; one taken from a statement identifies its holder. Use an ' +
		'example IBAN from EXAMPLE_IBANS, or the synthetic generators under scripts/synthetic/.',
	'external-image':
		'a true positive when the host is not one the page needs: rendering the image makes every ' +
		"reader's client fetch that URL, and the URL can carry data. An artefact only for a new badge " +
		'host, which goes in IMAGE_HOSTS with the reason; otherwise link the page instead of embedding it.'
};

/**
 * The one matcher. Every guard calls it and nothing else.
 *
 * @param {string} text
 * @returns {Finding[]}
 */
export function findPrivateReferences(text) {
	/** @type {number[]} */
	const lineStarts = [0];
	for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
	/** @param {number} offset */
	const lineOf = (offset) => {
		let line = 0;
		while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line += 1;
		return line + 1;
	};

	/** @type {Finding[]} */
	const findings = [];
	for (const kind of KINDS) {
		for (const match of text.matchAll(PATTERNS[kind])) {
			if (COUNTS[kind] && !COUNTS[kind](match[0])) continue;
			findings.push({ kind, line: lineOf(match.index ?? 0), match: match[0] });
		}
	}
	return findings.sort((a, b) => a.line - b.line);
}

/**
 * What a PUBLIC log (or the model's context, for the Claude Code hook) may print about a finding:
 * enough to find it again from the location printed beside it, never enough to be the leak. The
 * claude.ai pattern matches only the host and its slash, and a bypass tag is not private, so both
 * print as matched; a home path keeps its first username character; an address keeps the first
 * character of each side.
 *
 * @param {Finding} finding
 */
export function redact(finding) {
	if (finding.kind === 'claude-address' || finding.kind === 'scanner-bypass') return finding.match;
	if (finding.kind === 'home-path') {
		const cut = finding.match.search(/(?:home|Users|users|USERS)(?:\\{1,2}|\/)/);
		if (cut < 0) return '[home path]';
		const prefix = finding.match.slice(0, cut).replace(/[\\/]+$/, '');
		const rest = finding.match.slice(cut);
		const separator = rest.match(/\\{1,2}|\//)?.[0] ?? '/';
		const [dir, name = ''] = rest.split(separator).filter(Boolean);
		return `${prefix}${separator}${dir}${separator}${name.slice(0, 1)}…`;
	}
	if (finding.kind === 'iban') return `${finding.match.slice(0, 4)}…`;
	if (finding.kind === 'external-image') {
		const url = /https?:\/\/[^)\s>"']+/i.exec(finding.match)?.[0] ?? '';
		try {
			return `image from ${new URL(url).host}`;
		} catch {
			return 'image from an unparsable URL';
		}
	}
	const at = finding.match.lastIndexOf('@');
	return `${finding.match.slice(0, 1)}…@${finding.match.slice(at + 1, at + 2)}…`;
}

/**
 * The planted sample every runtime guard scans BEFORE believing a clean result, through the same
 * function it scans real text with. One positive per kind, assembled at run time because a literal
 * one would be a finding against this file. The tree gate keeps its own sample and its own exact
 * expectation; this one only has to prove each kind can fire.
 */
const CLAUDE_HOST = ['claude', 'ai'].join('.');
export const PLANTED_SAMPLE = [
	`see https://${CLAUDE_HOST}/design/p/0000`,
	`cwd ${['', 'home', 'planted', 'repo'].join('/')}`,
	`contact ${['planted.person', 'gmail.com'].join('@')}`,
	`key = "x" # ${['gitleaks', 'allow'].join(':')}`,
	// The ISO 13616 example with its account digits rearranged and the check digits recomputed:
	// valid, and not in EXAMPLE_IBANS.
	`iban ${['GB05', 'WEST', '1234', '5678', '9654', '32'].join(' ')}`,
	`![x](${'https'}://${['planted', 'example'].join('.')}/p.png?d=0)`
].join('\n');

/**
 * Runs the planted sample through `scan` and throws unless every kind was found EXACTLY once, the
 * count the sample plants. `scan` is the caller's own scanning path, so what is calibrated is the
 * path that reads the real text, not a copy of it beside it. Exactly, not at least: a scan that
 * reports a kind twice for one occurrence is as broken as one that misses it, and only a count can
 * tell the two apart.
 *
 * @param {(text: string) => Finding[]} [scan]
 * @returns {Record<Kind, number>} how many planted findings of each kind the scan returned
 */
export function calibrate(scan = findPrivateReferences) {
	const counts = /** @type {Record<Kind, number>} */ (
		Object.fromEntries(KINDS.map((kind) => [kind, 0]))
	);
	for (const finding of scan(PLANTED_SAMPLE)) counts[finding.kind] += 1;
	const wrong = KINDS.filter((kind) => counts[kind] !== 1);
	if (wrong.length > 0) {
		throw new Error(
			`calibration failed: the planted sample holds one of each kind and the scan returned ` +
				`${wrong.map((kind) => `${counts[kind]} ${kind}`).join(', ')}. A detector that cannot ` +
				'count the planted sample right cannot be believed about real text.'
		);
	}
	return counts;
}
