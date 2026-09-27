#!/usr/bin/env node
/**
 * Refuses a command or a GitHub post that would publish a private reference, BEFORE it happens.
 *
 * A Claude Code PreToolUse hook, registered in `.claude/settings.json` on `Bash` and on the GitHub
 * MCP tools. The matcher is `scripts/private-references.mjs`, the one definition every guard
 * imports; AGENTS.md « Never publish anything derived from a real statement » carries the rule, and
 * `docs/explanation/confidentiality-guards.md` says what each guard owns.
 *
 * ## What it reads
 *
 * EVERY Bash command, whatever its verb: the raw text and its dequoted words go through the matcher
 * for every kind except home paths (commands name absolute paths all the time without publishing
 * them). This half needs no parsing, so a verb spelled `g\h`, `'g'h` or `$G` cannot slip past it.
 * To test a detector on a live session, build the planted value at run time, as
 * `printf 'claude.a%s/x' i` does, rather than typing it.
 *
 * Then, for a command that publishes (`git commit`, `merge` or `tag`; `gh issue`, `pr`, `release`
 * or `gist` writes; any `gh api`; `curl` or `wget` to the GitHub API), every home path too, in the
 * value of each option that becomes published text, each heredoc body, and each FILE such an
 * option names, stdin redirects included. The matcher also reads a decoded copy of each text, so a
 * JSON escape, a percent-encoding, an entity or UTF-16 hides nothing.
 * For a GitHub MCP tool: every string in its input.
 *
 * It refuses the ways around the other guards: any abbreviation of `--no-verify` and commit's `-n`,
 * a `core.hooksPath` other than `.githooks`, and any `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_n` or `GIT_CONFIG_VALUE_n` in the command.
 *
 * ## It fails closed, because Claude Code does not
 *
 * Claude Code blocks a tool call on exit 2 ONLY; exit 1, a crash, a hook that cannot start and a
 * hook that times out all let the call through (the hooks reference, « Exit code output » and
 * « Timeouts »). So:
 * - this file runs as a small PARENT that hands the input to a WORKER copy of itself and exits 2
 *   unless the worker exits 0 within the time limit. A scan that stalls, crashes or runs out of
 *   memory is a refusal, and the parent cannot be starved by the worker's regular expressions;
 * - the worker exits 2 on anything it cannot vouch for: input that is not JSON, a command it cannot
 *   parse that names a publishing tool, a file it cannot read, stdin it cannot see, a variable or
 *   substitution it cannot evaluate, a command word built from one, a directory it cannot follow;
 * - the registered command line ends in `|| exit 2`, so a node that cannot load this file blocks.
 *
 * What it cannot see: a git alias, a script that commits on its own, a hand edit of `.git/config`,
 * a command whose verb is an argument of an unknown wrapper that reads it indirectly, and text
 * typed in the GitHub web UI. The git hooks and the pull request check read what reaches git; the
 * scheduled scan reads what reached GitHub.
 *
 * Output names the kind, where, and how to tell a true positive from an artefact, with the match
 * REDACTED: this text reaches the model's context.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
	try {
		const input = readFileSync(0);
		const limit = timeoutMs();
		const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
			input,
			timeout: limit,
			killSignal: 'SIGKILL',
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024
		});
		if (run.status === 0 && !run.error) process.exit(0);
		if (run.status === 2) block((run.stderr ?? '').trimEnd());
		const why =
			run.signal ||
			(run.error && /** @type {NodeJS.ErrnoException} */ (run.error).code === 'ETIMEDOUT')
				? `did not finish within ${limit} ms`
				: `failed (exit ${run.status})`;
		block(
			`private-references hook: BLOCKED, the scan ${why}, and a hook that stalls or crashes ` +
				`lets the call through, so this one refuses instead.\n${run.stderr ?? ''}`.trimEnd()
		);
	} catch (error) {
		block(
			`private-references hook: BLOCKED on an internal error, so nothing is let through: ${error instanceof Error ? error.message : error}`
		);
	}
}

// ---------------------------------------------------------------------------------------------
// Parsing a shell command, far enough to know which words are published text.
// ---------------------------------------------------------------------------------------------

/** A reason the hook cannot vouch for the command. Always a block. */
class Refusal extends Error {}

/**
 * @typedef {import('../../scripts/private-references.mjs').Finding} Finding
 * @typedef {{ where: string, text: string, homePaths: boolean }} Text
 * @typedef {{ kind: 'var' | 'cmd', raw: string, inner: string }} Subst
 * @typedef {{ type: 'word', value: string, raw: string, substs: Subst[] }} Word
 * @typedef {{ type: 'op', value: string }} Op
 * @typedef {{ type: 'redir', value: string, body: string | null }} Redir
 * @typedef {Word | Op | Redir} Token
 * @typedef {{ words: Word[], redirs: { op: string, target: string, body: string | null }[], pipedInto: boolean }} Segment
 * @typedef {{ where: string, path: string, cwd: string | null, segment: Segment | null }} FileRef
 * @typedef {{ gated: boolean, texts: Text[], files: FileRef[], refusals: string[], written: Set<string>, heredocs: string[], words: string[] }} Analysis
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
 * @param {number} start index just after the opening `$(`
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
			substs.push({ kind: 'cmd', raw, inner: src.slice(i + 1, end) });
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
 * Splits a command into words, operators and redirections, the way the shell would read it for
 * our purposes. A heredoc exists only where the tokenizer meets `<<` OUTSIDE quotes; its body is
 * read from the next line and attached to the redirection it belongs to.
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
		} else if (c === '`') {
			const end = readBacktick(src, i + 1);
			const raw = src.slice(i, end + 1);
			add(raw, raw, [{ kind: 'cmd', raw, inner: src.slice(i + 1, end) }]);
			i = end + 1;
		} else if (c === '$' && /[A-Za-z_{0-9@*#?!$-]/.test(src[i + 1] ?? '')) {
			add(c, c, [{ kind: 'var', raw: src.slice(i, i + 2), inner: '' }]);
			i += 1;
		} else if (src.startsWith('&>', i)) {
			push();
			const op = src.startsWith('&>>', i) ? '&>>' : '&>';
			tokens.push({ type: 'redir', value: op, body: null });
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
			const redir = { type: 'redir', value: op, body: null };
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
			if (next && next.type === 'word') {
				current.redirs.push({ op: token.value, target: next.value, body: token.body });
				i += 1;
			}
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

/** The verbs this hook reads. Anything before the first of them is a wrapper, whatever its name. */
const TOOLS = new Set(['git', 'gh', 'curl', 'wget']);
/** Commands that hand words they receive elsewhere to another command, which this hook cannot see. */
const RUNNERS = new Set(['xargs', 'parallel', 'find']);
/** Shell words that come before a command word without being one. */
const KEYWORDS = new Set(['!', '{', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time']);
/** Segments that are headers of a construct rather than a command. */
const HEADERS = new Set(['for', 'case', 'select', 'function', 'in', 'done', 'fi', 'esac', '}']);
const HOOKS_PATH = /core\.hookspath/i;
const GIT_CONFIG_ENV = /\bGIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)\b/;

/**
 * Reads a `$( )` found in published text. Only three shapes have a value this hook can know:
 * `cat` of a heredoc (the form Claude Code writes messages in), `cat file` and `cat < file`.
 *
 * @param {string} inner
 * @returns {{ kind: 'heredoc' } | { kind: 'file', path: string } | null}
 */
function readableSubstitution(inner) {
	let segments;
	try {
		segments = segmentsOf(tokenize(inner));
	} catch {
		return null;
	}
	if (segments.length !== 1) return null;
	const [segment] = segments;
	const values = segment.words.map((word) => word.value);
	if (values[0] !== 'cat' || segment.words.some((word) => word.substs.length > 0)) return null;
	const [redir, ...more] = segment.redirs;
	if (
		values.length === 1 &&
		redir &&
		more.length === 0 &&
		redir.op.startsWith('<<') &&
		redir.op !== '<<<'
	) {
		return { kind: 'heredoc' };
	}
	if (values.length === 1 && redir && more.length === 0 && redir.op === '<') {
		return { kind: 'file', path: redir.target };
	}
	if (values.length === 2 && segment.redirs.length === 0) return { kind: 'file', path: values[1] };
	return null;
}

/**
 * @param {string} command
 * @param {string | null} cwd
 * @param {number} [depth]
 * @returns {Analysis}
 */
function analyze(command, cwd, depth = 0) {
	if (depth > 8) throw new Refusal('command substitutions nested more than eight deep');
	const segments = segmentsOf(tokenize(command));
	/** @type {Analysis} */
	const result = {
		gated: false,
		texts: [],
		files: [],
		refusals: [],
		written: new Set(),
		heredocs: [],
		words: []
	};
	let here = cwd;

	/**
	 * A word whose value would be published. Its substitutions must be evaluable.
	 *
	 * @param {string} where
	 * @param {Word} word
	 * @param {string} value
	 * @param {string | null} dir
	 */
	const addText = (where, word, value, dir) => {
		let text = value;
		for (const subst of word.substs) {
			if (subst.kind === 'var') {
				result.refusals.push(
					`${where} expands ${subst.raw}…, whose value this hook cannot see. Write the text out, ` +
						'or put it in a file and pass the file.'
				);
				continue;
			}
			text = text.replace(subst.raw, '');
			const readable = readableSubstitution(subst.inner);
			if (readable?.kind === 'file') {
				result.files.push({
					where: `${where} $(cat) file`,
					path: readable.path,
					cwd: dir,
					segment: null
				});
			} else if (!readable) {
				result.refusals.push(
					`${where} runs a command substitution this hook cannot evaluate ` +
						`(${subst.raw.slice(0, 40)}). Only cat of a heredoc or of a file is read; put the ` +
						'text in a file and pass the file.'
				);
			}
			// A heredoc's body is in `heredocs`, read below with every other body.
		}
		result.texts.push({ where, text, homePaths: true });
	};

	/** @param {Segment} segment @param {string | null} dir */
	const context = (segment, dir) => ({ segment, cwd: dir, result, addText });

	for (const segment of segments) {
		for (const redir of segment.redirs) {
			if (redir.body !== null) result.heredocs.push(redir.body);
			if (/>/.test(redir.op)) result.written.add(resolveFrom(here, redir.target) ?? redir.target);
		}
		for (const word of segment.words) {
			result.words.push(word.value);
			// A command inside any substitution is a command like any other.
			for (const subst of word.substs) {
				if (subst.kind === 'cmd') mergeInto(result, analyze(subst.inner, here, depth + 1));
			}
		}

		const words = segment.words;
		let start = 0;
		while (
			start < words.length &&
			(/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start].value) || KEYWORDS.has(words[start].value))
		) {
			start += 1;
		}
		if (start >= words.length || HEADERS.has(words[start].value)) continue;
		const first = words[start];
		if (first.substs.length > 0) {
			result.refusals.push(
				`the command word is built from a variable or a substitution (${first.raw.slice(0, 40)}), ` +
					'so this hook cannot tell what runs. Write the command out.'
			);
			continue;
		}
		const name = basename(first.value);
		const args = words.slice(start + 1);

		if (name === 'cd' || name === 'pushd') {
			const target = args.find((word) => !word.value.startsWith('-'));
			here =
				!target ||
				target.substs.length > 0 ||
				target.value === '-' ||
				(target.value.startsWith('~') && !target.value.startsWith('~/'))
					? null
					: resolveFrom(here, target.value);
			continue;
		}
		if (name === 'tee') {
			for (const arg of args) {
				if (!arg.value.startsWith('-'))
					result.written.add(resolveFrom(here, arg.value) ?? arg.value);
			}
			continue;
		}

		// No wrapper list: whatever precedes the first tool word is a wrapper, and a string handed
		// to a wrapper as a command (`sh -c`, `script -c`, `flock -c`, `env -S`) is read as one.
		for (let i = start; i < words.length; i += 1) {
			const word = words[i];
			const verb = basename(word.value);
			if (TOOLS.has(verb)) {
				const rest = words.slice(i + 1);
				if (verb === 'git') analyzeGit(rest, context(segment, here));
				else if (verb === 'gh') analyzeGh(rest, context(segment, here));
				else analyzeHttp(rest, context(segment, here));
				break;
			}
			if (verb === 'eval') {
				mergeInto(
					result,
					analyze(
						words
							.slice(i + 1)
							.map((w) => w.value)
							.join(' '),
						here,
						depth + 1
					)
				);
				break;
			}
			if (RUNNERS.has(verb)) {
				if (words.slice(i + 1).some((w) => TOOLS.has(basename(w.value)))) {
					result.gated = true;
					result.refusals.push(
						`${verb} passes arguments this hook cannot see to git, gh, curl or wget. Run the ` +
							'command directly.'
					);
				}
				break;
			}
			const attached = /^--(?:command|split-string)=(.*)$/s.exec(word.value);
			if (attached) {
				mergeInto(result, analyze(attached[1], here, depth + 1));
			} else if (i > start && /^(?:-[A-Za-z]*[cS]|--command|--split-string)$/.test(word.value)) {
				const next = words[i + 1];
				if (next) mergeInto(result, analyze(next.value, here, depth + 1));
				i += 1;
			}
		}
	}

	if (result.gated) {
		result.heredocs.forEach((body, index) =>
			result.texts.push({
				where: result.heredocs.length > 1 ? `heredoc body ${index + 1}` : 'a heredoc body',
				text: body,
				homePaths: true
			})
		);
	}
	return result;
}

/**
 * @param {Analysis} into
 * @param {Analysis} from
 */
function mergeInto(into, from) {
	into.gated ||= from.gated;
	into.texts.push(...from.texts);
	into.files.push(...from.files);
	into.refusals.push(...from.refusals);
	into.heredocs.push(...from.heredocs);
	into.words.push(...from.words);
	for (const path of from.written) into.written.add(path);
}

/**
 * @typedef {{ segment: Segment, cwd: string | null, result: Analysis, addText: (where: string, word: Word, value: string, dir: string | null) => void }} Context
 */

/**
 * Short options per subcommand: which take a value, which take an OPTIONAL attached value, and
 * whether `-n` is `--no-verify`. Read per subcommand because the same letter differs: commit's
 * `-n` skips the hooks, merge's `-n` is `--no-stat`, and commit's `-uno` is `-u` with `no`.
 */
const GIT_SUBCOMMANDS = {
	commit: { value: 'mFtCc', optional: 'uS', noVerifyShort: true, files: 'Ft' },
	merge: { value: 'mFsX', optional: 'S', noVerifyShort: false, files: 'F' },
	tag: { value: 'mFu', optional: '', noVerifyShort: false, files: 'F' }
};
const GIT_TEXT_LONG = ['--message', '--trailer', '--author'];
const GIT_FILE_LONG = ['--file', '--template'];

/**
 * git accepts any unambiguous prefix of a long option, so `--no-verif` is `--no-verify`. A prefix
 * of at least five characters of one of the names this hook reads is taken as that name.
 *
 * @param {string} option
 * @param {string[]} names
 */
function longOption(option, names) {
	if (option.length < 5) return undefined;
	return names.find((name) => name.startsWith(option));
}

/**
 * @param {Word[]} args
 * @param {Context} ctx
 */
function analyzeGit(args, ctx) {
	const { result, addText, segment } = ctx;
	let dir = ctx.cwd;
	let i = 0;
	while (i < args.length && args[i].value.startsWith('-')) {
		const option = args[i].value;
		if (option === '-C') {
			dir = args[i + 1] ? resolveFrom(dir, args[i + 1].value) : null;
			i += 2;
		} else if (option === '-c' || option === '--config-env') {
			if (HOOKS_PATH.test(args[i + 1]?.value ?? '')) {
				result.refusals.push(
					`git ${option} core.hooksPath=… would run this command without the repository's git hooks`
				);
			}
			i += 2;
		} else if (/^--config-env=/.test(option) && HOOKS_PATH.test(option)) {
			result.refusals.push(
				"git --config-env=core.hooksPath would run this command without the repository's git hooks"
			);
			i += 1;
		} else if (
			['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path'].includes(option)
		) {
			i += 2;
		} else i += 1;
	}
	const sub = args[i]?.value;
	const rest = args.slice(i + 1);

	if (sub === 'config' && rest.some((word) => HOOKS_PATH.test(word.value))) {
		const values = rest
			.map((word) => word.value)
			.filter((value) => !['--local', '--worktree'].includes(value));
		const readOnly = values.some((value) =>
			['--get', '--get-all', '--list', '-l', '--show-origin'].includes(value)
		);
		const activation =
			values.length === 2 && HOOKS_PATH.test(values[0]) && values[1] === '.githooks';
		if (!readOnly && !activation) {
			result.refusals.push(
				'this changes core.hooksPath to something other than .githooks, which disables the git ' +
					'hooks. The only accepted write is « git config core.hooksPath .githooks ».'
			);
		}
		return;
	}
	const table = GIT_SUBCOMMANDS[/** @type {keyof typeof GIT_SUBCOMMANDS} */ (sub)];
	if (!table) return;
	result.gated = true;

	/** @param {string} where @param {string} path */
	const file = (where, path) => result.files.push({ where, path, cwd: dir, segment });

	for (let j = 0; j < rest.length; j += 1) {
		const word = rest[j];
		const value = word.value;
		const next = rest[j + 1];
		if (value === '--') break;
		if (value.startsWith('--')) {
			const [option, ...parts] = value.split('=');
			const attached = parts.length > 0 ? parts.join('=') : undefined;
			if (longOption(option, ['--no-verify'])) {
				result.refusals.push(
					`git ${sub} ${option} is --no-verify, which skips the repository's git hooks`
				);
				continue;
			}
			const text = longOption(option, GIT_TEXT_LONG);
			const path = longOption(option, GIT_FILE_LONG);
			if (!text && !path) continue;
			const argument = attached ?? next?.value;
			if (attached === undefined) j += 1;
			if (argument === undefined) continue;
			if (text)
				addText(`the ${text} value`, attached === undefined && next ? next : word, argument, dir);
			else file(`the ${path} file`, argument);
			continue;
		}
		if (!/^-[A-Za-z]/.test(value)) continue;
		for (let k = 1; k < value.length; k += 1) {
			const letter = value[k];
			if (letter === 'n' && table.noVerifyShort) {
				result.refusals.push(
					`git ${sub} -n is --no-verify, which skips the repository's git hooks`
				);
				continue;
			}
			if (table.optional.includes(letter)) break;
			if (!table.value.includes(letter)) continue;
			const attached = value.slice(k + 1);
			const argument = attached !== '' ? attached : next?.value;
			if (attached === '') j += 1;
			if (argument === undefined) break;
			if (letter === 'm')
				addText('the -m value', attached !== '' ? word : /** @type {Word} */ (next), argument, dir);
			else if (table.files.includes(letter)) file(`the -${letter} file`, argument);
			break;
		}
	}
}

const GH_WRITES = {
	issue: new Set(['create', 'edit', 'comment', 'close', 'reopen']),
	pr: new Set(['create', 'edit', 'comment', 'review', 'merge', 'close', 'reopen']),
	release: new Set(['create', 'edit', 'upload']),
	gist: new Set(['create', 'edit'])
};
const GH_TEXT_LONG = new Set(['--title', '--body', '--comment', '--subject', '--notes', '--desc']);
const GH_TEXT_SHORT = new Set(['-t', '-b', '-c', '-n', '-d']);
const GH_FILE_LONG = new Set(['--body-file', '--notes-file', '--add']);
/** Flags of `gh release` and `gh gist` that take a value which is not published text. */
const GH_OTHER_VALUE = new Set([
	'--target',
	'--discussion-category',
	'--notes-start-tag',
	'--filename',
	'-f',
	'--remove',
	'-r'
]);

/**
 * @param {Word[]} args
 * @param {Context} ctx
 */
function analyzeGh(args, ctx) {
	const { result, addText, cwd, segment } = ctx;
	/** @param {string} where @param {string} path */
	const file = (where, path) => result.files.push({ where, path, cwd, segment });
	const words = args.filter((word, index) => {
		const previous = args[index - 1]?.value;
		return !(
			word.value === '-R' ||
			word.value === '--repo' ||
			word.value.startsWith('--repo=') ||
			previous === '-R' ||
			previous === '--repo'
		);
	});
	const group = words[0]?.value;
	if (group === 'api') {
		result.gated = true;
		const rest = words.slice(1);
		for (let j = 0; j < rest.length; j += 1) {
			const word = rest[j];
			const next = rest[j + 1];
			let flag = word.value;
			let argument = /** @type {string | undefined} */ (undefined);
			let source = word;
			const eq = /^(--raw-field|--field|--input)=(.*)$/s.exec(flag);
			const attached = /^(-[fF])(.+)$/s.exec(flag);
			if (eq) [, flag, argument] = eq;
			else if (attached) [, flag, argument] = attached;
			else if (['-f', '-F', '--raw-field', '--field', '--input'].includes(flag) && next) {
				argument = next.value;
				source = next;
				j += 1;
			}
			if (argument === undefined) continue;
			if (flag === '--input') file('the --input file', argument);
			else if ((flag === '-F' || flag === '--field') && /^[^=]*=@/.test(argument)) {
				file(`the ${flag} ${argument.split('=')[0]} file`, argument.replace(/^[^=]*=@/, ''));
			} else {
				addText(
					`the ${flag} ${argument.split('=')[0]} value`,
					source,
					argument.replace(/^[^=]*=/, ''),
					cwd
				);
			}
		}
		return;
	}
	const writes = GH_WRITES[/** @type {keyof typeof GH_WRITES} */ (group)];
	const action = words[1]?.value;
	if (!writes || !writes.has(action)) return;
	result.gated = true;
	/** @type {string[]} */
	const positionals = [];
	const rest = words.slice(2);
	for (let j = 0; j < rest.length; j += 1) {
		const word = rest[j];
		const next = rest[j + 1];
		const value = word.value;
		if (!value.startsWith('-') || value === '-') {
			positionals.push(value);
			continue;
		}
		const eq = /^(--[a-z-]+)=(.*)$/s.exec(value);
		const flag = eq ? eq[1] : !value.startsWith('--') ? value.slice(0, 2) : value;
		const attachedShort =
			!eq && !value.startsWith('--') && value.length > 2 ? value.slice(2) : undefined;
		const attached = eq ? eq[2] : attachedShort;
		const isText = GH_TEXT_LONG.has(flag) || GH_TEXT_SHORT.has(flag);
		const isFile = GH_FILE_LONG.has(flag) || flag === '-F' || (group === 'gist' && flag === '-a');
		const isOther = GH_OTHER_VALUE.has(flag);
		if (!isText && !isFile && !isOther) continue;
		let argument = attached;
		let source = word;
		if (argument === undefined && next) {
			argument = next.value;
			source = next;
			j += 1;
		}
		if (argument === undefined || isOther) continue;
		if (isText) addText(`the ${flag} value`, source, argument, cwd);
		else file(`the ${flag} file`, argument);
	}
	// Files published as they are: a gist's files, and a release's assets after its tag.
	if (group === 'gist' && action === 'create') {
		for (const path of positionals) file('the gist file', path);
	}
	if (group === 'release' && (action === 'create' || action === 'upload')) {
		for (const path of positionals.slice(1)) file('the release asset', path.replace(/#.*$/, ''));
	}
}

const GITHUB_API = /\b(?:api|uploads)\.github\.com\b/i;
const CURL_DATA = new Set([
	'-d',
	'--data',
	'--data-raw',
	'--data-binary',
	'--data-ascii',
	'--data-urlencode',
	'--json',
	'-F',
	'--form',
	'--form-string'
]);
const CURL_FILE = new Set(['-T', '--upload-file']);
/** curl's short options that take a value, attached or as the next word. */
const CURL_VALUE_LETTERS = 'AbcCDdeEFHKmoPQrtTuUwxXyYz';
const WGET_DATA = new Set(['--post-data', '--body-data']);
const WGET_FILE = new Set(['--post-file', '--body-file']);

/**
 * `curl` and `wget` aimed at GitHub's API are the same write channel as `gh api`, without its
 * name. Every data option is read, attached or not: its value as text, or the file an `@` (or
 * curl's `<` in a form field) names.
 *
 * @param {Word[]} args
 * @param {Context} ctx
 */
function analyzeHttp(args, ctx) {
	const { result, addText, cwd, segment } = ctx;
	if (!args.some((word) => GITHUB_API.test(word.value))) return;
	result.gated = true;
	for (let j = 0; j < args.length; j += 1) {
		const word = args[j];
		const next = args[j + 1];
		let flag = word.value;
		/** @type {string | undefined} */
		let argument;
		const eq = /^(--[a-z-]+)=(.*)$/s.exec(word.value);
		if (eq) [, flag, argument] = eq;
		else if (/^-[A-Za-z]/.test(word.value) && !word.value.startsWith('--')) {
			// A cluster: booleans until the first letter that takes a value, which owns the rest.
			flag = '';
			for (let k = 1; k < word.value.length; k += 1) {
				if (CURL_VALUE_LETTERS.includes(word.value[k])) {
					flag = `-${word.value[k]}`;
					const rest = word.value.slice(k + 1);
					if (rest !== '') argument = rest;
					break;
				}
			}
		}
		const isData = CURL_DATA.has(flag) || WGET_DATA.has(flag);
		const isFile = CURL_FILE.has(flag) || WGET_FILE.has(flag);
		let source = word;
		if (argument === undefined && (isData || isFile || flag.length === 2) && next && flag !== '') {
			argument = next.value;
			source = next;
			j += 1;
		}
		if ((!isData && !isFile) || argument === undefined) continue;
		const fileInData = /^(?:[^=@<]*=)?[@<](.+)$/s.exec(argument);
		if (isFile) result.files.push({ where: `the ${flag} file`, path: argument, cwd, segment });
		else if (fileInData && flag !== '--data-raw' && flag !== '--form-string') {
			result.files.push({ where: `the ${flag} file`, path: fileInData[1], cwd, segment });
		} else addText(`the ${flag} value`, source, argument, cwd);
	}
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
	const queue = [...analysis.files];
	while (queue.length > 0) {
		const file = /** @type {FileRef} */ (queue.shift());
		const label = `${file.where} ${file.path}`;
		if (file.path === '-') {
			// stdin: known only from a redirect in the SAME segment, and never through a pipe.
			const segment = file.segment;
			const heredoc = segment?.redirs.find((r) => r.op === '<<' || r.op === '<<-');
			const hereString = segment?.redirs.find((r) => r.op === '<<<');
			const redirect = segment?.redirs.find((r) => r.op === '<');
			if (!segment || segment.pipedInto || (!heredoc && !hereString && !redirect)) {
				analysis.refusals.push(
					`${file.where} reads its body from stdin, which this hook cannot see: only a heredoc, ` +
						'a here-string or a < redirect in the same command, with nothing piped in, is read. ' +
						'Pass a file path instead.'
				);
			} else if (hereString) {
				texts.push({ where: 'the here-string', text: hereString.target, homePaths: true });
			} else if (redirect && !heredoc) {
				queue.push({
					where: 'the stdin redirect file',
					path: redirect.target,
					cwd: file.cwd,
					segment: null
				});
			}
			continue;
		}
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
		if (analysis.written.has(path) || analysis.written.has(file.path)) {
			analysis.refusals.push(
				`${label} is written by this same command, so what exists now is not what would be ` +
					'published. Write the file in one command, then publish it in the next.'
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
 * @param {boolean} [homePaths]
 */
function stringsOf(value, key, out, homePaths = true) {
	if (typeof value === 'string') out.push({ where: key, text: value, homePaths });
	else if (Array.isArray(value)) {
		value.forEach((item, index) => stringsOf(item, `${key}[${index}]`, out, homePaths));
	} else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value))
			stringsOf(v, key ? `${key}.${k}` : k, out, homePaths);
	}
	return out;
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
		try {
			const analysis = analyze(command, typeof payload.cwd === 'string' ? payload.cwd : null);
			commandLine.push({
				where: 'the command words',
				text: analysis.words.join(' '),
				homePaths: false
			});
			if (analysis.gated || analysis.refusals.length > 0) {
				published.push(...analysis.texts, ...readFiles(analysis));
			}
			refusals.push(...analysis.refusals);
		} catch (error) {
			// Unparsable. Refused when, with its quoting removed, it names a publishing tool; the raw
			// text is read below either way.
			if (
				/\b(?:git|gh|curl|wget|eval)\b|github\.com|hookspath/i.test(command.replace(/[\\'"]/g, ''))
			) {
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
