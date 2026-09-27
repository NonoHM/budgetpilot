#!/usr/bin/env node
/**
 * Refuses a command or a GitHub post that would publish a private reference, BEFORE it happens.
 *
 * A Claude Code PreToolUse hook, registered in `.claude/settings.json` on `Bash` and on the GitHub
 * MCP tools. The matcher is `scripts/private-references.mjs`, the one definition every guard
 * imports; AGENTS.md « Never publish anything derived from a real statement » carries the rule, and
 * `docs/explanation/confidentiality-guards.md` says what each guard owns.
 *
 * ## Two halves
 *
 * 1. EVERY Bash command line, whatever its verb, raw and with its quotes removed, goes through the
 *    matcher for every kind except home paths (command lines name absolute paths without publishing
 *    them). No parsing is involved, so no spelling of a verb gets past it. To test a detector in a
 *    live session, build the planted value at run time (`printf 'claude.a%s/x' i`).
 *
 * 2. A command that COULD publish (it names `git`, `gh`, `curl` or `wget` anywhere, quoted or not,
 *    or builds a word with `$` beside a publishing verb) is VALIDATED POSITIVELY: every part of it
 *    must match a closed list of forms, and anything else is refused with the forms to use
 *    (AGENTS.md: « Validate input positively, against a closed allow list »). This replaced an
 *    earlier attempt to understand arbitrary shell, which two adversarial reviews showed could not
 *    be made complete. The accepted forms:
 *    - read-only and local `git` and `gh` commands, and `curl` or `wget` that send nothing;
 *    - `git commit`, `merge`, annotated `tag` and `push`, with literal arguments, a message given
 *      as `-m "<text>"`, `-m "$(cat <<'EOF' … EOF)"`, `-F <path>` or `-F -` with a quoted heredoc;
 *    - `gh issue` and `gh pr` writes and `gh release create|edit|upload`, with literal arguments,
 *      text flags given literally or as `$(cat <<'EOF' … EOF)`, and a body as `--body-file <path>`
 *      or `-` with a quoted heredoc in the same command;
 *    - `gh api <path>` with literal fields, `-F body=@<path>` or `--input <path>`;
 *    - around them, only commands that cannot run what they are given (`grep`, `jq`, `head`, …),
 *      `cd` to a literal directory, and nothing that could write the body file first.
 *    The body of an accepted publishing form is then read and scanned with every kind.
 *
 * For a GitHub MCP tool: every string in its input, every kind.
 *
 * ## It fails closed, because Claude Code does not
 *
 * Claude Code blocks a tool call on exit 2 ONLY; exit 1, a crash, a hook that cannot start and a
 * hook that times out all let the call through (the hooks reference, « Exit code output » and
 * « Timeouts »). So this file runs as a small PARENT that hands the input to a WORKER copy of
 * itself and exits 2 unless the worker exits 0 within a budget counted from the parent's own
 * start; the worker exits 2 on anything it cannot vouch for; and the registered command line ends
 * in `|| exit 2`, so a node that cannot load this file blocks too.
 *
 * What it cannot see: a script or an alias that publishes on its own (the git hooks and the pull
 * request check read what reaches git whatever typed it), and text typed in the GitHub web UI (the
 * daily scan reads what reached GitHub).
 *
 * Output names the kind, where, and how to tell a true positive from an artefact, with the match
 * REDACTED: this text reaches the model's context.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Taken first, so the budget covers reading stdin and starting the worker too. */
const STARTED = Date.now();
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** @param {string} message */
function block(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// The parent: time the worker, and refuse unless it says clean.
// ---------------------------------------------------------------------------------------------

/**
 * The limit may only be LOWERED from the environment (a test does so to see the timeout path in
 * under a second); a larger value is ignored, so no setting can stretch the scan past the hook's
 * own registered timeout.
 */
function timeoutMs() {
	const requested = Number(process.env.BP_PRIVATE_REFS_TIMEOUT_MS);
	return Number.isInteger(requested) && requested > 0 && requested < DEFAULT_TIMEOUT_MS
		? requested
		: DEFAULT_TIMEOUT_MS;
}

function parent() {
	const limit = timeoutMs();
	const tooLate = `private-references hook: BLOCKED, the scan did not finish within ${limit} ms of the hook starting, and a hook that stalls lets the call through, so this one refuses instead.`;
	try {
		const input = readFileSync(0);
		const remaining = limit - (Date.now() - STARTED);
		if (remaining <= 0) block(tooLate);
		const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
			input,
			timeout: remaining,
			killSignal: 'SIGKILL',
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024
		});
		if (run.status === 0 && !run.error) process.exit(0);
		if (run.status === 2) block((run.stderr ?? '').trimEnd());
		const timedOut =
			run.signal ||
			(run.error && /** @type {NodeJS.ErrnoException} */ (run.error).code === 'ETIMEDOUT');
		if (timedOut) block(tooLate);
		block(
			`private-references hook: BLOCKED, the scan failed (exit ${run.status}), and a hook that ` +
				`crashes lets the call through, so this one refuses instead.\n${run.stderr ?? ''}`.trimEnd()
		);
	} catch (error) {
		block(
			`private-references hook: BLOCKED on an internal error, so nothing is let through: ${error instanceof Error ? error.message : error}`
		);
	}
}

// ---------------------------------------------------------------------------------------------
// Tokenizing a shell command, far enough to validate it against the accepted forms.
// ---------------------------------------------------------------------------------------------

/** A reason the hook cannot vouch for the command. Always a block. */
class Refusal extends Error {}

/**
 * @typedef {import('../../scripts/private-references.mjs').Finding} Finding
 * @typedef {{ where: string, text: string, homePaths: boolean }} Text
 * @typedef {{ kind: 'var' | 'cmd' | 'backtick' | 'proc', raw: string, inner: string }} Subst
 * @typedef {{ type: 'word', value: string, raw: string, substs: Subst[] }} Word
 * @typedef {{ type: 'op', value: string }} Op
 * @typedef {{ type: 'redir', value: string, body: string | null, quoted: boolean }} Redir
 * @typedef {Word | Op | Redir} Token
 * @typedef {{ op: string, word: Word | null, target: string, body: string | null, quoted: boolean }} SegmentRedir
 * @typedef {{ words: Word[], redirs: SegmentRedir[], pipedInto: boolean }} Segment
 * @typedef {{ where: string, path: string, cwd: string | null }} FileRef
 * @typedef {'reader' | 'writer' | 'read' | 'index' | 'tree' | 'net' | 'other' | 'publish' | 'refused'} Kind
 * @typedef {{ texts: Text[], files: FileRef[], refusals: string[], heredocs: string[], words: string[], publishes: number, readsFile: boolean, unsafe: boolean }} Analysis
 */

/** A heredoc operator and its delimiter, as it opens the body on the next line. */
const HEREDOC_OPENER = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/;

/**
 * Reads the heredoc bodies that start at `start` (the character after a newline), in the order
 * their operators appeared on the line, and returns where the command resumes.
 *
 * @param {string} src
 * @param {number} start
 * @param {{ delimiter: string, strip: boolean, onBody: (body: string) => void }[]} pending
 */
function readBodies(src, start, pending) {
	let at = start;
	for (const heredoc of pending) {
		/** @type {string[]} */
		const body = [];
		let closed = false;
		while (at <= src.length) {
			const end = src.indexOf('\n', at);
			const line = end < 0 ? src.slice(at) : src.slice(at, end);
			at = end < 0 ? src.length + 1 : end + 1;
			if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
				closed = true;
				break;
			}
			body.push(line);
			if (end < 0) break;
		}
		if (!closed) {
			throw new Refusal(
				`unterminated heredoc: no line reads « ${heredoc.delimiter} ». If « << » is part of the ` +
					'text rather than a heredoc, quote it or put the text in a file and pass the file.'
			);
		}
		heredoc.onBody(body.join('\n'));
	}
	pending.length = 0;
	return Math.min(at, src.length);
}

/**
 * @param {string} src
 * @param {number} start index just after `$((`
 * @returns {number} index of the final `)`
 */
function readArithmetic(src, start) {
	let depth = 2;
	for (let i = start; i < src.length; i += 1) {
		if (src[i] === '(') depth += 1;
		else if (src[i] === ')') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	throw new Refusal('unbalanced arithmetic expansion');
}

/**
 * @param {string} src
 * @param {number} start index just after an opening `$(`, `<(` or `>(`
 * @returns {number} index of the matching `)`, skipping quotes, nested substitutions and heredoc
 *   bodies, so a `)` or a quote inside a heredoc cannot end it early
 */
function readParen(src, start) {
	let depth = 1;
	let i = start;
	/** @type {{ delimiter: string, strip: boolean, onBody: (body: string) => void }[]} */
	const pending = [];
	while (i < src.length) {
		const c = src[i];
		if (c === '\\') i += 2;
		else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) throw new Refusal('unbalanced single quote inside a command substitution');
			i = end + 1;
		} else if (c === '"') i = readDouble(src, i + 1).end + 1;
		else if (c === '`') i = readBacktick(src, i + 1) + 1;
		else if (c === '$' && src.startsWith('((', i + 1)) i = readArithmetic(src, i + 3) + 1;
		else if (c === '$' && src[i + 1] === '(') i = readParen(src, i + 2) + 1;
		else if (c === '<' && src.startsWith('<<<', i)) i += 3;
		else if (c === '<' && src[i + 1] === '<') {
			const opener = HEREDOC_OPENER.exec(src.slice(i));
			if (opener) {
				pending.push({
					delimiter: opener[2] ?? opener[3] ?? opener[4],
					strip: opener[1] === '-',
					onBody: () => {}
				});
				i += opener[0].length;
			} else i += 2;
		} else if (c === '\n' && pending.length > 0) i = readBodies(src, i + 1, pending);
		else if (c === '#' && (i === start || /[\s(;|&]/.test(src[i - 1]))) {
			while (i < src.length && src[i] !== '\n') i += 1;
		} else if (c === '(') {
			depth += 1;
			i += 1;
		} else if (c === ')') {
			depth -= 1;
			if (depth === 0) return i;
			i += 1;
		} else i += 1;
	}
	throw new Refusal('unbalanced command substitution');
}

/**
 * @param {string} src
 * @param {number} start index just after the opening backtick
 */
function readBacktick(src, start) {
	let i = start;
	while (i < src.length) {
		if (src[i] === '\\') i += 2;
		else if (src[i] === '`') return i;
		else i += 1;
	}
	throw new Refusal('unbalanced backtick');
}

/**
 * @param {string} src
 * @param {number} start index just after the opening double quote
 */
function readDouble(src, start) {
	let value = '';
	/** @type {Subst[]} */
	const substs = [];
	let i = start;
	while (i < src.length) {
		const c = src[i];
		if (c === '"') return { value, substs, end: i };
		if (c === '\\') {
			const next = src[i + 1] ?? '';
			if (next === '\n') value += '';
			else if ('$`"\\'.includes(next)) value += next;
			else value += `\\${next}`;
			i += 2;
		} else if (c === '$' && src.startsWith('((', i + 1)) {
			const end = readArithmetic(src, i + 3);
			value += src.slice(i, end + 1);
			i = end + 1;
		} else if (c === '$' && src[i + 1] === '(') {
			const end = readParen(src, i + 2);
			const raw = src.slice(i, end + 1);
			substs.push({ kind: 'cmd', raw, inner: src.slice(i + 2, end) });
			value += raw;
			i = end + 1;
		} else if (c === '`') {
			const end = readBacktick(src, i + 1);
			const raw = src.slice(i, end + 1);
			substs.push({ kind: 'backtick', raw, inner: src.slice(i + 1, end) });
			value += raw;
			i = end + 1;
		} else if (c === '$' && /[A-Za-z_{0-9@*#?!$-]/.test(src[i + 1] ?? '')) {
			substs.push({ kind: 'var', raw: src.slice(i, i + 2), inner: '' });
			value += c;
			i += 1;
		} else {
			value += c;
			i += 1;
		}
	}
	throw new Refusal('unbalanced double quote');
}

/**
 * Splits a command into words, operators and redirections. A heredoc exists only where `<<` is met
 * OUTSIDE quotes; its body is read from the next line and attached to its redirection, with
 * whether the delimiter was quoted (a quoted one means the shell expands nothing in the body).
 *
 * @param {string} src
 * @returns {Token[]}
 */
function tokenize(src) {
	/** @type {Token[]} */
	const tokens = [];
	/** @type {{ value: string, raw: string, substs: Subst[] } | null} */
	let word = null;
	/** @type {{ redir: Redir, strip: boolean } | null} */
	let awaitingDelimiter = null;
	/** @type {{ delimiter: string, strip: boolean, onBody: (body: string) => void }[]} */
	const pending = [];
	const push = () => {
		if (!word) return;
		tokens.push({ type: 'word', ...word });
		if (awaitingDelimiter) {
			const { redir, strip } = awaitingDelimiter;
			redir.quoted = word.raw !== word.value;
			pending.push({ delimiter: word.value, strip, onBody: (body) => (redir.body = body) });
			awaitingDelimiter = null;
		}
		word = null;
	};
	/** @param {string} value @param {string} [raw] @param {Subst[]} [substs] */
	const add = (value, raw = value, substs = []) => {
		word ??= { value: '', raw: '', substs: [] };
		word.value += value;
		word.raw += raw;
		word.substs.push(...substs);
	};
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === ' ' || c === '\t') {
			push();
			i += 1;
		} else if (c === '\n') {
			push();
			tokens.push({ type: 'op', value: ';' });
			i = pending.length > 0 ? readBodies(src, i + 1, pending) : i + 1;
		} else if (c === '#' && word === null) {
			while (i < src.length && src[i] !== '\n') i += 1;
		} else if (c === '\\') {
			if (src[i + 1] !== '\n') add(src[i + 1] ?? '', c + (src[i + 1] ?? ''));
			i += 2;
		} else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) throw new Refusal('unbalanced single quote');
			add(src.slice(i + 1, end), src.slice(i, end + 1));
			i = end + 1;
		} else if (c === '$' && src[i + 1] === "'") {
			let j = i + 2;
			while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
			if (j >= src.length) throw new Refusal("unbalanced $' quote");
			add(src.slice(i + 2, j), src.slice(i, j + 1));
			i = j + 1;
		} else if (c === '"') {
			const { value, substs, end } = readDouble(src, i + 1);
			add(value, src.slice(i, end + 1), substs);
			i = end + 1;
		} else if (c === '$' && src.startsWith('((', i + 1)) {
			const end = readArithmetic(src, i + 3);
			add(src.slice(i, end + 1));
			i = end + 1;
		} else if (c === '$' && src[i + 1] === '(') {
			const end = readParen(src, i + 2);
			const raw = src.slice(i, end + 1);
			add(raw, raw, [{ kind: 'cmd', raw, inner: src.slice(i + 2, end) }]);
			i = end + 1;
		} else if ((c === '<' || c === '>') && src[i + 1] === '(') {
			// Process substitution: a command whose output or input stands in for a file name.
			const end = readParen(src, i + 2);
			const raw = src.slice(i, end + 1);
			add(raw, raw, [{ kind: 'proc', raw, inner: src.slice(i + 2, end) }]);
			i = end + 1;
		} else if (c === '`') {
			const end = readBacktick(src, i + 1);
			const raw = src.slice(i, end + 1);
			add(raw, raw, [{ kind: 'backtick', raw, inner: src.slice(i + 1, end) }]);
			i = end + 1;
		} else if (c === '$' && /[A-Za-z_{0-9@*#?!$-]/.test(src[i + 1] ?? '')) {
			add(c, c, [{ kind: 'var', raw: src.slice(i, i + 2), inner: '' }]);
			i += 1;
		} else if (src.startsWith('&>', i)) {
			push();
			const op = src.startsWith('&>>', i) ? '&>>' : '&>';
			tokens.push({ type: 'redir', value: op, body: null, quoted: false });
			i += op.length;
		} else if (/^(?:&&|\|\||;;|\|&|[|;&()])/.test(src.slice(i, i + 2))) {
			push();
			const op = /** @type {RegExpExecArray} */ (
				/^(?:&&|\|\||;;|\|&|[|;&()])/.exec(src.slice(i, i + 2))
			)[0];
			tokens.push({ type: 'op', value: op });
			i += op.length;
		} else if (c === '>' || c === '<') {
			// A file descriptor number glued in front (`2>`) is part of the operator, not a word.
			if (word && /^\d+$/.test(word.raw)) word = null;
			push();
			const op = /** @type {RegExpExecArray} */ (
				/^(?:>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)/.exec(src.slice(i, i + 3))
			)[0];
			/** @type {Redir} */
			const redir = { type: 'redir', value: op, body: null, quoted: false };
			tokens.push(redir);
			if (op === '<<' || op === '<<-') awaitingDelimiter = { redir, strip: op === '<<-' };
			i += op.length;
		} else {
			add(c);
			i += 1;
		}
	}
	push();
	if (awaitingDelimiter || pending.length > 0) {
		const delimiter = pending[0]?.delimiter ?? 'its delimiter';
		throw new Refusal(
			`unterminated heredoc: no line reads « ${delimiter} ». If « << » is part of the text ` +
				'rather than a heredoc, quote it or put the text in a file and pass the file.'
		);
	}
	return tokens;
}

/** @param {Token[]} tokens */
function segmentsOf(tokens) {
	/** @type {Segment[]} */
	const segments = [{ words: [], redirs: [], pipedInto: false }];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		const current = segments[segments.length - 1];
		if (token.type === 'op') {
			segments.push({
				words: [],
				redirs: [],
				pipedInto: token.value === '|' || token.value === '|&'
			});
		} else if (token.type === 'redir') {
			const next = tokens[i + 1];
			const word = next && next.type === 'word' ? next : null;
			current.redirs.push({
				op: token.value,
				word,
				target: word?.value ?? '',
				body: token.body,
				quoted: token.quoted
			});
			if (word) i += 1;
		} else current.words.push(token);
	}
	return segments.filter((segment) => segment.words.length > 0 || segment.redirs.length > 0);
}

/** @param {string} path */
function expandHome(path) {
	return path === '~' || path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
}

/**
 * @param {string | null} cwd
 * @param {string} path
 */
function resolveFrom(cwd, path) {
	const expanded = expandHome(path);
	if (isAbsolute(expanded)) return resolve(expanded);
	return cwd === null ? null : resolve(cwd, expanded);
}

/** @param {string} value */
const basename = (value) => value.split('/').pop() ?? '';

// ---------------------------------------------------------------------------------------------
// The allow list.
// ---------------------------------------------------------------------------------------------

const TOOLS = new Set(['git', 'gh', 'curl', 'wget']);
/** A tool named anywhere in the text, as its own word. */
const MENTIONS_TOOL = /(^|[^A-Za-z0-9_.-])(gh|git|curl|wget)(?![A-Za-z0-9_-])/;
/** A publishing verb, which beside a `$` could make a command word nobody spelled. */
const PUBLISHING_VERB =
	/(^|[^A-Za-z0-9_-])(issue|pr|api|commit|push|release|gist|comment|merge|tag|review)(?![A-Za-z0-9_-])/;
const HOOKS_PATH = /core[.]hookspath/i;
const INCLUDE_CONFIG = /(^|[.\s])include(if)?[.]|^include/i;
const GIT_CONFIG_ENV = /\bGIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)\b/;

/** Commands that only read what they are given, and write nothing but their output. */
const READERS = new Set([
	'echo',
	'printf',
	'cat',
	'head',
	'tail',
	'grep',
	'egrep',
	'fgrep',
	'rg',
	'jq',
	'wc',
	'sort',
	'uniq',
	'cut',
	'tr',
	'ls',
	'pwd',
	'test',
	'[',
	'true',
	'false',
	'sleep',
	'date',
	'diff',
	'cmp',
	'basename',
	'dirname',
	'realpath',
	'readlink',
	'stat',
	'file',
	'du',
	'df',
	'which',
	'type',
	'column',
	'nl',
	'tac',
	'fold',
	'comm',
	'paste',
	'join',
	'sha256sum',
	'md5sum',
	'base64',
	'xxd',
	'od',
	'strings',
	':',
	'seq',
	'cd',
	'pushd',
	'popd'
]);
/** Commands that write files but never run what they are given. */
const WRITERS = new Set(['mkdir', 'touch', 'cp', 'mv', 'rm', 'chmod', 'ln', 'tee']);
/** Shell words that come before a command word without being one. */
const KEYWORDS = new Set(['!', '{', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time']);
/** Segments that are the header or the end of a construct rather than a command. */
const HEADERS = new Set(['for', 'case', 'select', 'in', 'done', 'fi', 'esac', '}']);

const FORMS =
	'Accepted forms for a command that can publish: gh issue|pr create|comment|edit|review|close|' +
	'reopen|merge and gh release create|edit|upload with literal flags and a body as ' +
	'--body-file <path> (or - with a quoted heredoc); gh api <path> [-X POST|PATCH] ' +
	'-F body=@<path> or --input <path>; git commit -F <path>, -F - with a quoted heredoc, or ' +
	'-m "<text>" (literal, or $(cat <<\'EOF\' … EOF)); git push; read-only and local git and gh ' +
	'commands; and around them only readers such as grep, jq or head, and cd to a literal directory.';

/**
 * A word's value without the text its substitutions contribute.
 *
 * @param {Word} word
 */
const literalPart = (word) =>
	word.substs.reduce((value, subst) => value.replace(subst.raw, ''), word.value);

/** @param {Word} word */
const isLiteral = (word) => word.substs.length === 0;

/**
 * The one substitution accepted in published text: `$(cat <<'EOF' … EOF)`, a quoted heredoc and
 * nothing else, whose body is literal data. Returns the body, or null.
 *
 * @param {Word} word
 */
function quotedHeredocBody(word) {
	if (word.substs.length !== 1 || word.substs[0].kind !== 'cmd') return null;
	if (word.value.replace(word.substs[0].raw, '').trim() !== '') return null;
	let segments;
	try {
		segments = segmentsOf(tokenize(word.substs[0].inner));
	} catch {
		return null;
	}
	if (segments.length !== 1) return null;
	const [segment] = segments;
	const [redir, ...more] = segment.redirs;
	const onlyCat = segment.words.length === 1 && segment.words[0].raw === 'cat';
	if (!onlyCat || !redir || more.length > 0) return null;
	if ((redir.op !== '<<' && redir.op !== '<<-') || !redir.quoted || redir.body === null)
		return null;
	return redir.body;
}

/** A redirection that writes nowhere a later read could see: /dev/null or a descriptor copy. */
const isDiscard = (/** @type {SegmentRedir} */ redir) =>
	((redir.op === '>' || redir.op === '>>' || redir.op === '&>' || redir.op === '&>>') &&
		redir.target === '/dev/null') ||
	(redir.op === '>&' && /^[0-9]$/.test(redir.target));

/** @returns {Analysis} */
function emptyAnalysis() {
	return {
		texts: [],
		files: [],
		refusals: [],
		heredocs: [],
		words: [],
		publishes: 0,
		readsFile: false,
		unsafe: false
	};
}

/**
 * @param {Analysis} into
 * @param {Analysis} from
 */
function mergeInto(into, from) {
	into.texts.push(...from.texts);
	into.files.push(...from.files);
	into.refusals.push(...from.refusals);
	into.heredocs.push(...from.heredocs);
	into.words.push(...from.words);
	into.publishes += from.publishes;
	into.readsFile ||= from.readsFile;
	into.unsafe ||= from.unsafe;
}

/**
 * Validates a command that could publish, part by part, against the forms above.
 *
 * @param {string} command
 * @param {string | null} cwd
 * @param {number} depth 0 for the command itself, more inside a substitution
 * @returns {Analysis}
 */
function validate(command, cwd, depth) {
	if (depth > 8) throw new Refusal('command substitutions nested more than eight deep');
	const tokens = tokenize(command);
	const result = emptyAnalysis();
	for (let i = 0; i + 2 < tokens.length; i += 1) {
		const [name, open, close] = [tokens[i], tokens[i + 1], tokens[i + 2]];
		if (
			name.type === 'word' &&
			open.type === 'op' &&
			open.value === '(' &&
			close.type === 'op' &&
			close.value === ')'
		) {
			result.refusals.push(
				`a function definition (${name.value}) in a command that can publish: this hook cannot ` +
					'see what the function runs. Call git or gh directly.'
			);
		}
	}
	let here = cwd;
	for (const segment of segmentsOf(tokens)) {
		// Every substitution, in a word or in a redirection target, is a command of its own.
		const words = [...segment.words, ...segment.redirs.flatMap((r) => (r.word ? [r.word] : []))];
		for (const word of words) {
			result.words.push(word.value);
			for (const subst of word.substs) {
				if (subst.kind === 'backtick') {
					result.refusals.push(
						'a backtick substitution in a command that can publish: backticks nest through ' +
							'escapes this hook does not follow. Use $( ) instead.'
					);
				} else if (subst.kind === 'cmd' || subst.kind === 'proc') {
					mergeInto(result, validate(subst.inner, here, depth + 1));
				}
			}
		}
		for (const redir of segment.redirs) {
			if (redir.body !== null) {
				result.heredocs.push(redir.body);
				if (!redir.quoted && /[$`]/.test(redir.body)) {
					result.refusals.push(
						'an unquoted heredoc: the shell expands $( ), backticks and variables in its body, ' +
							"which this hook cannot see. Quote the delimiter (<<'EOF')."
					);
				}
			}
			if (/>/.test(redir.op) && !isDiscard(redir)) result.unsafe = true;
		}
		const verdict = classify(segment, here, result, depth);
		if (verdict.cwd !== undefined) here = verdict.cwd;
		if (!['reader', 'read', 'index', 'publish'].includes(verdict.kind)) result.unsafe = true;
	}
	if (depth === 0) {
		// A body file is read now; another part of the command could write it before the tool
		// reads it. So beside a publishing command that reads a file, only parts that write nothing.
		if (result.readsFile && result.unsafe) {
			result.refusals.push(
				'a body file read here could be written by this same command before it is published ' +
					'(another part of the command writes files or runs something that can). Write the ' +
					'file in one command, then publish it in the next.'
			);
		}
		if (result.publishes > 0) {
			result.heredocs.forEach((body, index) =>
				result.texts.push({
					where: result.heredocs.length > 1 ? `heredoc body ${index + 1}` : 'a heredoc body',
					text: body,
					homePaths: true
				})
			);
		}
	}
	return result;
}

/**
 * @param {Segment} segment
 * @param {string | null} here
 * @param {Analysis} result
 * @param {number} depth
 * @returns {{ kind: Kind, cwd?: string | null }}
 */
function classify(segment, here, result, depth) {
	const words = segment.words;
	let start = 0;
	while (start < words.length) {
		const word = words[start];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value)) {
			if (MENTIONS_TOOL.test(literalPart(word))) {
				result.refusals.push(
					`a variable holding git, gh, curl or wget (${word.raw.slice(0, 40)}): this hook cannot ` +
						'see where it is run. Write the command out.'
				);
			}
			start += 1;
		} else if (KEYWORDS.has(word.value) && isLiteral(word)) start += 1;
		else break;
	}
	if (start >= words.length) return { kind: 'reader' };
	const first = words[start];
	if (HEADERS.has(first.value) && isLiteral(first)) return { kind: 'reader' };
	if (first.value === 'function' && isLiteral(first)) {
		result.refusals.push(
			'a function definition in a command that can publish. Call git or gh directly.'
		);
		return { kind: 'refused' };
	}
	if (!isLiteral(first)) {
		result.refusals.push(
			`the command word is built from a variable or a substitution (${first.raw.slice(0, 40)}), ` +
				'so this hook cannot tell what runs. Write the command out.'
		);
		return { kind: 'refused' };
	}
	const name = basename(first.value);
	const args = words.slice(start + 1);
	if (name === 'cd' || name === 'pushd') {
		const target = args.find((word) => !word.value.startsWith('-'));
		const cwd =
			!target ||
			!isLiteral(target) ||
			target.value === '-' ||
			(target.value.startsWith('~') && !target.value.startsWith('~/'))
				? null
				: resolveFrom(here, target.value);
		return { kind: 'reader', cwd };
	}
	if (TOOLS.has(name)) {
		/** @type {Context} */
		const ctx = { segment, cwd: here, result, depth };
		if (name === 'git') return { kind: classifyGit(args, ctx) };
		if (name === 'gh') return { kind: classifyGh(args, ctx) };
		return { kind: classifyHttp(name, args, ctx) };
	}
	if (READERS.has(name)) return { kind: 'reader' };
	if (WRITERS.has(name)) return { kind: 'writer' };
	// Anything else may run what it is given, so it may not be given a tool.
	if (MENTIONS_TOOL.test(args.map(literalPart).join(' '))) {
		result.refusals.push(
			`« ${name} » can run what it is given, and it is given git, gh, curl or wget, so this hook ` +
				`cannot see what would be published. Run the tool directly. ${FORMS}`
		);
		return { kind: 'refused' };
	}
	// Nor a word it cannot see beside a publishing verb: `nice $G issue comment …` runs whatever
	// $G holds, with the arguments of a publishing command.
	if (
		args.some((word) => !isLiteral(word)) &&
		PUBLISHING_VERB.test(args.map(literalPart).join(' '))
	) {
		result.refusals.push(
			`« ${name} » is given a variable or a substitution beside a publishing verb, so this hook ` +
				`cannot tell what it runs. Write the command out. ${FORMS}`
		);
		return { kind: 'refused' };
	}
	return { kind: 'other' };
}

/**
 * @typedef {{ segment: Segment, cwd: string | null, result: Analysis, depth: number }} Context
 */

/**
 * Checks the segment's redirections for a publishing command: a quoted heredoc (for a body read
 * from stdin) and output thrown away, nothing else.
 *
 * @param {Context} ctx
 * @param {string} what
 */
function publishingRedirs(ctx, what) {
	for (const redir of ctx.segment.redirs) {
		if (isDiscard(redir)) continue;
		if ((redir.op === '<<' || redir.op === '<<-') && redir.quoted) continue;
		if (redir.op === '<<' || redir.op === '<<-') {
			ctx.result.refusals.push(
				`${what} is fed an unquoted heredoc, which the shell expands. Quote the delimiter (<<'EOF').`
			);
		} else {
			ctx.result.refusals.push(
				`${what} carries the redirection « ${redir.op} ${redir.target} », which is not accepted ` +
					'on a command that publishes.'
			);
		}
	}
}

/**
 * A body read from stdin (`-`): accepted only from ONE quoted heredoc in the same segment, with
 * nothing piped in and no other input redirection.
 *
 * @param {Context} ctx
 * @param {string} where
 */
function stdinBody(ctx, where) {
	const inputs = ctx.segment.redirs.filter((r) => r.op.startsWith('<'));
	const heredoc = inputs.find((r) => (r.op === '<<' || r.op === '<<-') && r.quoted);
	if (ctx.segment.pipedInto || !heredoc || inputs.length !== 1) {
		ctx.result.refusals.push(
			`${where} reads its body from stdin, which this hook accepts only from one quoted heredoc ` +
				"(<<'EOF') in the same command, with nothing piped in. Pass a file path instead."
		);
	}
}

/**
 * Records one value of a publishing command. Text must be literal or a quoted-heredoc `$(cat … )`;
 * a file must be a literal path, or `-` for stdin.
 *
 * @param {Context} ctx
 * @param {'text' | 'file' | 'value'} role
 * @param {string} where
 * @param {Word} word the word the value comes from
 * @param {string} value the value, attached part only when attached
 */
function takeValue(ctx, role, where, word, value) {
	const { result } = ctx;
	if (role === 'text') {
		if (isLiteral(word)) result.texts.push({ where, text: value, homePaths: true });
		else if (quotedHeredocBody(word) === null) {
			result.refusals.push(
				`${where} runs a substitution this hook cannot evaluate (${word.raw.slice(0, 40)}): only ` +
					"a literal or $(cat <<'EOF' … EOF) is accepted in published text."
			);
		}
		return;
	}
	if (!isLiteral(word)) {
		result.refusals.push(
			`${where} is built from a variable or a substitution (${word.raw.slice(0, 40)}), so it is ` +
				'not literal and this hook cannot tell what it names.'
		);
		return;
	}
	if (role === 'file') {
		if (value === '-') stdinBody(ctx, where);
		else {
			result.files.push({ where, path: value, cwd: ctx.cwd });
			result.readsFile = true;
		}
	}
}

/**
 * The flags of one publishing form: which carry published text, which name a file, which take
 * some other value, and which take none. Short and long names both listed; an option may be
 * abbreviated when that is how the tool reads it (`abbreviate`).
 *
 * @typedef {{ text: string[], file: string[], value: string[], bool: string[], optional?: string[], noVerify?: string[], abbreviate?: boolean }} FlagTable
 */

/**
 * Reads a publishing command's arguments against its flag table. Returns the positionals.
 *
 * @param {Word[]} args
 * @param {FlagTable} table
 * @param {Context} ctx
 * @param {string} what
 */
function readFlags(args, table, ctx, what) {
	const { result } = ctx;
	const longs = [
		...table.text,
		...table.file,
		...table.value,
		...table.bool,
		...(table.optional ?? []),
		...(table.noVerify ?? [])
	].filter((f) => f.startsWith('--'));
	/** @type {Word[]} */
	const positionals = [];
	/** @param {string} option */
	const resolveLong = (option) => {
		if (longs.includes(option)) return option;
		if (!table.abbreviate) return undefined;
		const candidates = longs.filter((name) => name.startsWith(option));
		return candidates.length === 1 && option.length >= 4 ? candidates[0] : undefined;
	};
	/** @param {string} flag */
	const roleOf = (flag) =>
		table.text.includes(flag)
			? 'text'
			: table.file.includes(flag)
				? 'file'
				: table.value.includes(flag)
					? 'value'
					: table.bool.includes(flag)
						? 'bool'
						: table.optional?.includes(flag)
							? 'optional'
							: table.noVerify?.includes(flag)
								? 'noVerify'
								: undefined;
	let afterSeparator = false;
	for (let j = 0; j < args.length; j += 1) {
		const word = args[j];
		const value = word.value;
		const next = args[j + 1];
		if (afterSeparator || !value.startsWith('-') || value === '-') {
			positionals.push(word);
			continue;
		}
		if (value === '--') {
			afterSeparator = true;
			continue;
		}
		if (!isLiteral(word) && !word.value.includes('=')) {
			result.refusals.push(`${what}: the option ${word.raw.slice(0, 40)} is not literal.`);
			continue;
		}
		if (value.startsWith('--')) {
			const [option, ...parts] = value.split('=');
			const attached = parts.length > 0 ? parts.join('=') : undefined;
			const flag = resolveLong(option);
			const role = flag ? roleOf(flag) : undefined;
			if (!flag || !role) {
				result.refusals.push(
					`${what}: the option ${option} is not one of the accepted flags. ${FORMS}`
				);
				continue;
			}
			if (role === 'noVerify') {
				result.refusals.push(
					`${what} ${option} is --no-verify, which skips the repository's git hooks.`
				);
				continue;
			}
			if (role === 'bool') continue;
			if (role === 'optional') continue;
			const source = attached === undefined && next ? next : word;
			const argument = attached ?? next?.value;
			if (attached === undefined) j += 1;
			if (argument === undefined) continue;
			takeValue(ctx, role, `the ${flag} ${role === 'file' ? 'file' : 'value'}`, source, argument);
			continue;
		}
		// A cluster of short options: booleans until one that takes a value, which owns the rest.
		for (let k = 1; k < value.length; k += 1) {
			const flag = `-${value[k]}`;
			const role = roleOf(flag);
			if (!role) {
				result.refusals.push(
					`${what}: the option ${flag} is not one of the accepted flags. ${FORMS}`
				);
				break;
			}
			if (role === 'noVerify') {
				result.refusals.push(
					`${what} ${flag} is --no-verify, which skips the repository's git hooks.`
				);
				continue;
			}
			if (role === 'bool') continue;
			if (role === 'optional') break;
			const rest = value.slice(k + 1).replace(/^=/, '');
			const source = rest === '' && next ? next : word;
			const argument = rest !== '' ? rest : next?.value;
			if (rest === '') j += 1;
			if (argument !== undefined)
				takeValue(ctx, role, `the ${flag} ${role === 'file' ? 'file' : 'value'}`, source, argument);
			break;
		}
	}
	return positionals;
}

/** @type {Record<string, FlagTable>} */
const GIT_PUBLISHING = {
	commit: {
		text: ['-m', '--message', '--author', '--trailer'],
		file: ['-F', '--file', '-t', '--template'],
		value: ['--date', '--fixup', '--squash', '--cleanup'],
		bool: [
			'-q',
			'--quiet',
			'-a',
			'--all',
			'--amend',
			'--no-edit',
			'-s',
			'--signoff',
			'-v',
			'--verbose',
			'--allow-empty',
			'--allow-empty-message',
			'--reset-author',
			'-e',
			'--edit',
			'--no-status',
			'--status',
			'-o',
			'--only',
			'-i',
			'--include',
			'--dry-run',
			'--short',
			'--porcelain',
			'--long',
			'--no-gpg-sign'
		],
		optional: ['-u', '--untracked-files', '-S', '--gpg-sign'],
		noVerify: ['-n', '--no-verify'],
		abbreviate: true
	},
	merge: {
		text: ['-m', '--message'],
		file: ['-F', '--file'],
		value: ['-s', '--strategy', '-X', '--strategy-option', '--cleanup'],
		bool: [
			'--ff',
			'--no-ff',
			'--ff-only',
			'--squash',
			'--no-squash',
			'-n',
			'--no-stat',
			'--stat',
			'-q',
			'--quiet',
			'-v',
			'--verbose',
			'--no-edit',
			'--edit',
			'-e',
			'--abort',
			'--continue',
			'--quit',
			'--commit',
			'--no-commit',
			'--log',
			'--no-log',
			'--signoff',
			'--allow-unrelated-histories',
			'--autostash',
			'--no-autostash',
			'--progress',
			'--no-progress',
			'--no-gpg-sign'
		],
		optional: ['-S', '--gpg-sign'],
		noVerify: ['--no-verify'],
		abbreviate: true
	},
	tag: {
		text: ['-m', '--message'],
		file: ['-F', '--file'],
		value: ['-u', '--local-user', '--cleanup'],
		bool: ['-a', '--annotate', '-s', '--sign', '-f', '--force', '--no-sign'],
		abbreviate: true
	},
	push: {
		text: [],
		file: [],
		value: ['-o', '--push-option', '--repo'],
		bool: [
			'-u',
			'--set-upstream',
			'-q',
			'--quiet',
			'--tags',
			'--follow-tags',
			'-d',
			'--delete',
			'--dry-run',
			'-n',
			'-v',
			'--verbose',
			'--porcelain',
			'--atomic',
			'--no-atomic',
			'--prune'
		],
		optional: ['--force-with-lease', '--force-if-includes'],
		noVerify: ['--no-verify'],
		abbreviate: true
	}
};
const GIT_READ = new Set([
	'status',
	'log',
	'show',
	'diff',
	'rev-parse',
	'rev-list',
	'ls-files',
	'ls-remote',
	'ls-tree',
	'cat-file',
	'fetch',
	'grep',
	'blame',
	'describe',
	'shortlog',
	'merge-base',
	'check-ignore',
	'show-ref',
	'for-each-ref',
	'symbolic-ref',
	'count-objects',
	'reflog',
	'diff-tree',
	'name-rev',
	'var',
	'check-attr',
	'help',
	'version',
	'whatchanged',
	'range-diff',
	'cherry'
]);
const GIT_INDEX = new Set(['add', 'branch', 'remote', 'config']);
const GIT_TREE = new Set([
	'switch',
	'checkout',
	'restore',
	'reset',
	'rebase',
	'stash',
	'cherry-pick',
	'revert',
	'pull',
	'rm',
	'mv',
	'clean',
	'apply',
	'worktree',
	'init',
	'clone',
	'bisect',
	'gc',
	'fsck',
	'prune',
	'maintenance',
	'sparse-checkout',
	'submodule'
]);

/**
 * @param {Word[]} args
 * @param {Context} ctx
 * @returns {Kind}
 */
function classifyGit(args, ctx) {
	const { result } = ctx;
	let i = 0;
	/** @type {string[]} */
	const configs = [];
	while (i < args.length && args[i].value.startsWith('-')) {
		const word = args[i];
		const option = word.value;
		if (option === '-C') {
			const target = args[i + 1];
			if (!target || !isLiteral(target)) {
				result.refusals.push('git -C with a directory that is not literal.');
				return 'refused';
			}
			ctx = { ...ctx, cwd: resolveFrom(ctx.cwd, target.value) };
			i += 2;
		} else if (option === '-c') {
			configs.push(args[i + 1]?.value ?? '');
			i += 2;
		} else if (
			[
				'--no-pager',
				'-P',
				'--paginate',
				'-p',
				'--literal-pathspecs',
				'--no-optional-locks'
			].includes(option)
		) {
			i += 1;
		} else {
			result.refusals.push(
				`git ${option} is not accepted in a command that can publish: it can point git at other ` +
					'configuration, another repository or other hooks.'
			);
			return 'refused';
		}
	}
	const subWord = args[i];
	if (!subWord) return 'read';
	if (!isLiteral(subWord)) {
		result.refusals.push(`the git subcommand ${subWord.raw.slice(0, 40)} is not literal.`);
		return 'refused';
	}
	const sub = subWord.value;
	const rest = args.slice(i + 1);
	const annotatedTag =
		sub === 'tag' &&
		rest.some((w) => /^-(-message|-file|-annotate|-sign|[amsF]|[a-zA-Z]*[msFa])/.test(w.value));
	const publishing = sub === 'tag' ? annotatedTag : sub in GIT_PUBLISHING;
	if (
		configs.length > 0 &&
		(publishing || configs.some((c) => HOOKS_PATH.test(c) || INCLUDE_CONFIG.test(c)))
	) {
		result.refusals.push(
			`git -c configuration (${configs.join(', ')}) on a command that publishes, or configuration ` +
				'that can load other files or hooks, is not accepted.'
		);
		return 'refused';
	}
	if (sub === 'config') return classifyGitConfig(rest, ctx);
	if (publishing) {
		if (ctx.depth > 0) {
			result.refusals.push(
				`git ${sub} inside a substitution publishes where this hook ` +
					`cannot follow. Run it as a command of its own. ${FORMS}`
			);
			return 'refused';
		}
		const what = `git ${sub}`;
		publishingRedirs(ctx, what);
		const positionals = readFlags(rest, GIT_PUBLISHING[sub], ctx, what);
		for (const word of positionals) {
			if (!isLiteral(word))
				result.refusals.push(`${what}: the argument ${word.raw.slice(0, 40)} is not literal.`);
		}
		result.publishes += 1;
		return 'publish';
	}
	if (sub === 'notes') {
		const action = rest[0]?.value;
		if (!action || ['list', 'show'].includes(action)) return 'read';
		result.refusals.push(`git notes ${action} writes text this hook does not read. ${FORMS}`);
		return 'refused';
	}
	if (GIT_READ.has(sub)) return 'read';
	if (GIT_INDEX.has(sub) || sub === 'tag') return 'index';
	if (GIT_TREE.has(sub)) return 'tree';
	result.refusals.push(`git ${sub} is not one of the accepted forms. ${FORMS}`);
	return 'refused';
}

/**
 * @param {Word[]} rest
 * @param {Context} ctx
 * @returns {Kind}
 */
function classifyGitConfig(rest, ctx) {
	const values = rest.map((word) => word.value);
	const readOnly = values.some((v) =>
		[
			'--get',
			'--get-all',
			'--get-regexp',
			'--list',
			'-l',
			'--show-origin',
			'--show-scope',
			'get',
			'list'
		].includes(v)
	);
	if (readOnly) return 'read';
	if (values.some((v) => HOOKS_PATH.test(v))) {
		const meaningful = values.filter((v) => !['--local', '--worktree'].includes(v));
		const activation =
			meaningful.length === 2 && HOOKS_PATH.test(meaningful[0]) && meaningful[1] === '.githooks';
		if (!activation) {
			ctx.result.refusals.push(
				'this changes core.hooksPath to something other than .githooks, which disables the git ' +
					'hooks. The only accepted write is « git config core.hooksPath .githooks ».'
			);
			return 'refused';
		}
	}
	if (values.some((v) => INCLUDE_CONFIG.test(v))) {
		ctx.result.refusals.push(
			'this sets include or includeIf configuration, which can load a file that points git at ' +
				'other hooks.'
		);
		return 'refused';
	}
	return 'index';
}

const GH_TEXT = ['--title', '-t', '--body', '-b'];
const GH_BODY_FILE = ['--body-file', '-F'];
/** @type {Record<string, Record<string, FlagTable>>} */
const GH_PUBLISHING = {
	issue: {
		create: {
			text: GH_TEXT,
			file: GH_BODY_FILE,
			value: [
				'--label',
				'-l',
				'--assignee',
				'-a',
				'--milestone',
				'-m',
				'--project',
				'-p',
				'--template',
				'-T'
			],
			bool: []
		},
		comment: { text: ['--body', '-b'], file: GH_BODY_FILE, value: [], bool: ['--edit-last'] },
		edit: {
			text: GH_TEXT,
			file: GH_BODY_FILE,
			value: [
				'--add-label',
				'--remove-label',
				'--add-assignee',
				'--remove-assignee',
				'--milestone',
				'-m',
				'--add-project',
				'--remove-project'
			],
			bool: ['--remove-milestone']
		},
		close: { text: ['--comment', '-c'], file: [], value: ['--reason', '-r'], bool: [] },
		reopen: { text: ['--comment', '-c'], file: [], value: [], bool: [] }
	},
	pr: {
		create: {
			text: GH_TEXT,
			file: GH_BODY_FILE,
			value: [
				'--base',
				'-B',
				'--head',
				'-H',
				'--label',
				'-l',
				'--assignee',
				'-a',
				'--reviewer',
				'-r',
				'--milestone',
				'-m',
				'--project',
				'-p',
				'--template',
				'-T'
			],
			bool: ['--draft', '-d', '--fill', '--fill-first', '--no-maintainer-edit']
		},
		comment: { text: ['--body', '-b'], file: GH_BODY_FILE, value: [], bool: ['--edit-last'] },
		edit: {
			text: GH_TEXT,
			file: GH_BODY_FILE,
			value: [
				'--base',
				'-B',
				'--add-label',
				'--remove-label',
				'--add-reviewer',
				'--remove-reviewer',
				'--add-assignee',
				'--remove-assignee',
				'--milestone',
				'-m',
				'--add-project',
				'--remove-project'
			],
			bool: ['--remove-milestone']
		},
		review: {
			text: ['--body', '-b'],
			file: GH_BODY_FILE,
			value: [],
			bool: ['--approve', '-a', '--comment', '-c', '--request-changes', '-r']
		},
		merge: {
			text: ['--subject', '-t', '--body', '-b'],
			file: GH_BODY_FILE,
			value: ['--match-head-commit'],
			bool: ['--squash', '-s', '--merge', '-m', '--rebase', '-r', '--delete-branch', '-d']
		},
		close: { text: ['--comment', '-c'], file: [], value: [], bool: ['--delete-branch', '-d'] },
		reopen: { text: ['--comment', '-c'], file: [], value: [], bool: [] },
		ready: { text: [], file: [], value: [], bool: ['--undo'] }
	},
	release: {
		create: {
			text: ['--title', '-t', '--notes', '-n'],
			file: ['--notes-file', '-F'],
			value: ['--target', '--discussion-category', '--notes-start-tag'],
			bool: ['--draft', '-d', '--prerelease', '-p', '--generate-notes', '--verify-tag', '--latest']
		},
		edit: {
			text: ['--title', '-t', '--notes', '-n'],
			file: ['--notes-file', '-F'],
			value: ['--tag', '--target', '--discussion-category'],
			bool: ['--draft', '--prerelease', '--latest']
		},
		upload: { text: [], file: [], value: [], bool: ['--clobber'] }
	}
};
/** @type {Record<string, string[]>} */
const GH_READ = {
	pr: ['view', 'list', 'checks', 'diff', 'status', 'checkout'],
	issue: ['view', 'list', 'status'],
	run: ['list', 'view', 'watch', 'download', 'rerun', 'cancel'],
	repo: ['view', 'clone'],
	release: ['view', 'list', 'download'],
	workflow: ['list', 'view', 'run'],
	label: ['list'],
	auth: ['status', 'token'],
	secret: ['list'],
	cache: ['list'],
	ruleset: ['list', 'view', 'check'],
	search: ['*'],
	status: ['*']
};

/**
 * @param {Word[]} args
 * @param {Context} ctx
 * @returns {Kind}
 */
function classifyGh(args, ctx) {
	const { result } = ctx;
	/** @type {Word[]} */
	const words = [];
	for (let j = 0; j < args.length; j += 1) {
		const value = args[j].value;
		if (value === '-R' || value === '--repo') {
			if (!args[j + 1] || !isLiteral(args[j + 1])) {
				result.refusals.push('gh --repo with a value that is not literal.');
				return 'refused';
			}
			j += 1;
		} else if (!value.startsWith('--repo=')) words.push(args[j]);
	}
	const [groupWord, actionWord] = words;
	if (!groupWord) return 'read';
	for (const word of [groupWord, actionWord]) {
		if (word && !isLiteral(word)) {
			result.refusals.push(
				`gh ${word.raw.slice(0, 40)}: the command is not literal, so this hook cannot tell what it does.`
			);
			return 'refused';
		}
	}
	const group = groupWord.value;
	const action = actionWord?.value ?? '';
	if (group === 'api') return classifyApi(words.slice(1), ctx);
	const read = GH_READ[group];
	if (
		read &&
		(read.includes('*') || read.includes(action) || action === '' || action.startsWith('-'))
	) {
		return 'read';
	}
	const table = GH_PUBLISHING[group]?.[action];
	if (!table) {
		result.refusals.push(`gh ${group} ${action} is not one of the accepted forms. ${FORMS}`);
		return 'refused';
	}
	const what = `gh ${group} ${action}`;
	if (ctx.depth > 0) {
		result.refusals.push(
			`${what} inside a substitution publishes where this hook cannot ` +
				`follow. Run it as a command of its own. ${FORMS}`
		);
		return 'refused';
	}
	publishingRedirs(ctx, what);
	const positionals = readFlags(words.slice(2), table, ctx, what);
	for (const word of positionals) {
		if (!isLiteral(word))
			result.refusals.push(`${what}: the argument ${word.raw.slice(0, 40)} is not literal.`);
	}
	if (group === 'release' && (action === 'create' || action === 'upload')) {
		for (const word of positionals.slice(1)) {
			takeValue(ctx, 'file', 'the release asset', word, word.value.replace(/#.*$/, ''));
		}
	} else if (group !== 'release' && positionals.length > 1) {
		result.refusals.push(`${what}: more than one argument is not an accepted form. ${FORMS}`);
	}
	result.publishes += 1;
	return 'publish';
}

/**
 * `gh api`: a read when its method is GET (the default without fields), a publishing form
 * otherwise, with every field literal and a file only as `-F name=@<path>` or `--input <path>`.
 *
 * @param {Word[]} args
 * @param {Context} ctx
 * @returns {Kind}
 */
function classifyApi(args, ctx) {
	const { result } = ctx;
	let method = '';
	let hasBody = false;
	/** @type {{ role: 'text' | 'file', where: string, word: Word, value: string }[]} */
	const values = [];
	/** @type {Word[]} */
	const positionals = [];
	const VALUE_FLAGS = [
		'-H',
		'--header',
		'--jq',
		'-q',
		'--cache',
		'-t',
		'--template',
		'--hostname',
		'-p',
		'--preview'
	];
	const BOOL_FLAGS = ['--paginate', '--slurp', '-i', '--include', '--silent', '--verbose'];
	for (let j = 0; j < args.length; j += 1) {
		const word = args[j];
		const next = args[j + 1];
		const eq = /^(--[a-z-]+)=(.*)$/s.exec(word.value);
		const attached = /^(-[fFX])(.+)$/s.exec(word.value);
		let flag = word.value;
		/** @type {string | undefined} */
		let argument;
		let source = word;
		if (eq) [, flag, argument] = eq;
		else if (attached) [, flag, argument] = attached;
		if (!flag.startsWith('-')) {
			positionals.push(word);
			continue;
		}
		if (BOOL_FLAGS.includes(flag)) continue;
		if (argument === undefined) {
			argument = next?.value;
			source = next ?? word;
			j += 1;
		}
		if (argument === undefined) continue;
		if (flag === '-X' || flag === '--method') method = argument.toUpperCase();
		else if (VALUE_FLAGS.includes(flag)) continue;
		else if (flag === '--input') {
			hasBody = true;
			values.push({ role: 'file', where: 'the --input file', word: source, value: argument });
		} else if (flag === '-f' || flag === '--raw-field' || flag === '-F' || flag === '--field') {
			hasBody = true;
			const name = argument.split('=')[0];
			const fieldValue = argument.replace(/^[^=]*=/, '');
			if ((flag === '-F' || flag === '--field') && fieldValue.startsWith('@')) {
				values.push({
					role: 'file',
					where: `the ${flag} ${name} file`,
					word: source,
					value: fieldValue.slice(1)
				});
			} else
				values.push({
					role: 'text',
					where: `the ${flag} ${name} value`,
					word: source,
					value: fieldValue
				});
		} else {
			result.refusals.push(`gh api: the option ${flag} is not one of the accepted flags. ${FORMS}`);
			return 'refused';
		}
	}
	const path = positionals[0]?.value ?? '';
	const graphql = path === 'graphql';
	const effective = method || (hasBody ? 'POST' : 'GET');
	const mutation = graphql && values.some((v) => /\bmutation\b/i.test(v.value));
	if (effective === 'GET' || (graphql && !mutation)) return 'read';
	const what = `gh api ${effective} ${path}`;
	if (ctx.depth > 0) {
		result.refusals.push(
			`${what} inside a substitution publishes where this hook cannot ` +
				`follow. Run it as a command of its own. ${FORMS}`
		);
		return 'refused';
	}
	publishingRedirs(ctx, what);
	for (const word of positionals) {
		if (!isLiteral(word))
			result.refusals.push(`${what}: the path ${word.raw.slice(0, 40)} is not literal.`);
	}
	for (const value of values) takeValue(ctx, value.role, value.where, value.word, value.value);
	result.publishes += 1;
	return 'publish';
}

const CURL_SENDS = new Set([
	'-d',
	'--data',
	'--data-raw',
	'--data-binary',
	'--data-ascii',
	'--data-urlencode',
	'--json',
	'-F',
	'--form',
	'--form-string',
	'-T',
	'--upload-file'
]);
/** curl's short options that take a value, attached or as the next word. */
const CURL_VALUE_LETTERS = 'AbcCDdeEFHKmoPQrtTuUwxXyYz';

/**
 * `curl` and `wget` are accepted only when they send nothing: a body to GitHub goes through
 * `gh api`, which this hook can read.
 *
 * @param {string} name
 * @param {Word[]} args
 * @param {Context} ctx
 * @returns {Kind}
 */
function classifyHttp(name, args, ctx) {
	const sends = args.some((word) => {
		const value = word.value;
		const eq = /^(--[a-z-]+)(=.*)?$/s.exec(value);
		if (eq) {
			const flag = eq[1];
			if (CURL_SENDS.has(flag) || /^--(post|body)-(data|file)$/.test(flag)) return true;
			if ((flag === '--request' || flag === '--method') && eq[2] && !/^=(GET|HEAD)$/i.test(eq[2]))
				return true;
			return false;
		}
		if (/^-[A-Za-z]/.test(value)) {
			for (let k = 1; k < value.length; k += 1) {
				if (!CURL_VALUE_LETTERS.includes(value[k])) continue;
				if ('dFT'.includes(value[k])) return true;
				if (value[k] === 'X') {
					const method = value.slice(k + 1) || args[args.indexOf(word) + 1]?.value || '';
					return !/^(GET|HEAD)$/i.test(method);
				}
				return false;
			}
		}
		return false;
	});
	const request = args.findIndex((w) => w.value === '--request' || w.value === '--method');
	const sendsByMethod = request >= 0 && !/^(GET|HEAD)$/i.test(args[request + 1]?.value ?? '');
	if (sends || sendsByMethod) {
		ctx.result.refusals.push(
			`${name} sending data is not accepted: send a body to GitHub with gh api <path> -X POST ` +
				`-F body=@<path>, which this hook can read. ${FORMS}`
		);
		return 'refused';
	}
	return 'net';
}

// ---------------------------------------------------------------------------------------------
// Reading what the command would publish, and deciding.
// ---------------------------------------------------------------------------------------------

/**
 * @param {Analysis} analysis
 * @returns {Text[]}
 */
function readFiles(analysis) {
	/** @type {Text[]} */
	const texts = [];
	for (const file of analysis.files) {
		const label = `${file.where} ${file.path}`;
		if (/[$`*?[]/.test(file.path)) {
			analysis.refusals.push(`${label}: a path with an expansion this hook cannot resolve`);
			continue;
		}
		const path = resolveFrom(file.cwd, file.path);
		if (path === null) {
			analysis.refusals.push(
				`${label}: a relative path after a cd this hook cannot follow, so it cannot tell which ` +
					'directory it names. Use an absolute path.'
			);
			continue;
		}
		try {
			const stat = statSync(path);
			if (!stat.isFile()) throw new Error('not a regular file');
			if (stat.size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES} bytes`);
			// One byte per character, like the tree gate: every pattern is ASCII, and the matcher's
			// decoded copy undoes a UTF-16 file's interleaved NULs.
			texts.push({
				where: `${file.where} ${path}`,
				text: readFileSync(path, 'latin1'),
				homePaths: true
			});
		} catch (error) {
			analysis.refusals.push(
				`${label}: cannot read it (${error instanceof Error ? error.message : error})`
			);
		}
	}
	return texts;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @param {Text[]} out
 */
function stringsOf(value, key, out) {
	if (typeof value === 'string') out.push({ where: key, text: value, homePaths: true });
	else if (Array.isArray(value))
		value.forEach((item, index) => stringsOf(item, `${key}[${index}]`, out));
	else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) stringsOf(v, key ? `${key}.${k}` : k, out);
	}
	return out;
}

/**
 * Whether a command could publish, read on its text with quotes and backslashes removed, so no
 * spelling of a tool's name escapes it: a tool named anywhere, or a `$` beside a publishing verb
 * (a command word nobody spelled out).
 *
 * @param {string} command
 */
function couldPublish(command) {
	const plain = command.replace(/['"\\]/g, '');
	return MENTIONS_TOOL.test(plain) || (plain.includes('$') && PUBLISHING_VERB.test(plain));
}

async function worker() {
	if (process.env.BP_PRIVATE_REFS_STALL_FOR_TEST === '1') for (;;);
	const { calibrate, findPrivateReferences, redact, HOW_TO_READ } =
		await import('../../scripts/private-references.mjs');
	calibrate();

	const raw = readFileSync(0, 'utf8');
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		block(
			'private-references hook: BLOCKED, it could not parse the tool input as JSON, so it cannot vouch for the call.'
		);
	}
	const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
	const input = payload?.tool_input;

	/** @type {Text[]} */
	let texts;
	/** @type {string[]} */
	const refusals = [];
	if (tool.startsWith('mcp__')) {
		texts = stringsOf(input, '', []).map((t) => ({
			...t,
			where: `the ${t.where || 'input'} field`
		}));
	} else {
		const command = input?.command;
		if (typeof command !== 'string') {
			block(
				'private-references hook: BLOCKED, the tool input carries no command string, so it cannot vouch for the call.'
			);
			return;
		}
		const configEnv = GIT_CONFIG_ENV.exec(command);
		if (configEnv) {
			refusals.push(
				`the command names ${configEnv[0]}, which can set core.hooksPath for this command and ` +
					'disable the git hooks'
			);
		}
		/** @type {Text[]} */
		const published = [];
		/** @type {Text[]} */
		const commandLine = [{ where: 'the command text', text: command, homePaths: false }];
		if (couldPublish(command)) {
			try {
				const analysis = validate(command, typeof payload.cwd === 'string' ? payload.cwd : null, 0);
				commandLine.push({
					where: 'the command words',
					text: analysis.words.join(' '),
					homePaths: false
				});
				published.push(...analysis.texts, ...readFiles(analysis));
				refusals.push(...analysis.refusals);
			} catch (error) {
				refusals.push(
					`it could not parse this command (${error instanceof Error ? error.message : error}), ` +
						'and the command names a tool that can publish'
				);
			}
		}
		// Published text first, so a finding is named where it would be published; the command line
		// after, reporting only what nothing above already did.
		texts = [...published, ...commandLine];
	}

	/** @type {string[]} */
	const lines = [];
	const seen = new Set();
	for (const text of texts) {
		for (const finding of findPrivateReferences(text.text)) {
			if (!text.homePaths && finding.kind === 'home-path') continue;
			const key = `${finding.kind}\0${finding.match}`;
			if (!text.homePaths && seen.has(key)) continue;
			seen.add(key);
			const line =
				`  [${finding.kind}] in ${text.where}, line ${finding.line}: ${redact(finding)}\n` +
				`    how to read it: ${HOW_TO_READ[finding.kind]}`;
			if (!lines.includes(line)) lines.push(line);
		}
	}
	if (lines.length === 0 && refusals.length === 0) process.exit(0);

	let message = '';
	if (lines.length > 0) {
		message +=
			'private-references hook: BLOCKED. This would publish a private reference ' +
			'(AGENTS.md « Never publish anything derived from a real statement »):\n' +
			`${lines.join('\n')}\n`;
	}
	if (refusals.length > 0) {
		message +=
			'private-references hook: BLOCKED, because it fails closed and could not vouch for all of ' +
			`this command:\n${[...new Set(refusals)].map((r) => `  - ${r}`).join('\n')}\n`;
	}
	block(message.trimEnd());
}

if (process.argv[2] === '--worker') {
	worker().catch((error) => {
		block(
			`private-references hook: BLOCKED on an internal error, so nothing is let through: ${error instanceof Error ? error.stack : error}`
		);
	});
} else parent();
