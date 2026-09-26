#!/usr/bin/env node
/**
 * Refuses a commit or a GitHub post that would publish a private reference, BEFORE it happens.
 *
 * A Claude Code PreToolUse hook, registered in `.claude/settings.json` on `Bash` and on the GitHub
 * MCP tools. The matcher is `scripts/private-references.mjs`, the one definition every guard
 * imports; AGENTS.md « Never publish anything derived from a real statement » carries the rule.
 *
 * ## What it reads
 *
 * For a Bash command that publishes (`git commit`, `git merge`, `gh issue|pr|release` writes,
 * any `gh api`, and `curl` or `wget` aimed at `api.github.com`): the value of every option that becomes published text (`-m`, `--body`, `--title`,
 * `-f`/`-F` fields...), every heredoc body, and every FILE such an option names (`--body-file`,
 * `-F`, `git commit -F`, `-F body=@path`, `--input`, `$(cat path)`), each with all four kinds.
 * The rest of the command line is read for every kind except home paths: a publishing command
 * habitually NAMES absolute paths (`cd`, `git -C`, the body file itself) without publishing them,
 * and reading those as findings would block every commit made from a worktree.
 *
 * For a GitHub MCP tool: every string in its input, all four kinds.
 *
 * It also refuses the ways around the other guards: `git commit|merge --no-verify` (or `-n`), and
 * setting `core.hooksPath` anywhere but `.githooks`, through `git -c`, `--config-env`, `git config`
 * or a `GIT_CONFIG_*` variable.
 *
 * ## It fails closed, because Claude Code does not
 *
 * Claude Code blocks a tool call on exit 2 ONLY. Exit 1, a crash, a hook that cannot start and a
 * hook that times out all let the call through (the hooks reference, « Exit code output » and
 * « Timeouts »). So every path out of this file that is not a verified clean result exits 2: input
 * that is not JSON, a command it cannot parse, a file it cannot read, stdin it cannot see, a
 * variable or command substitution it cannot evaluate, a directory it cannot follow. A watchdog
 * exits 2 well before the registered timeout. And the registered command line ends in `|| exit 2`,
 * so a node that cannot load this file still blocks rather than passes.
 *
 * What it cannot see, and does not pretend to: a git alias, a script that commits on its own, an
 * edit of `.git/config` by hand, and text typed into the GitHub web UI. The git hooks and the
 * pull request check read what reaches git whatever typed it; the scheduled scan reads what
 * reached GitHub.
 *
 * Output names the kind, where, and how to tell a true positive from an artefact, with the match
 * REDACTED: this text reaches the model's context.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** Exits 2 whatever went wrong, before the registered timeout can turn a stall into a pass. */
const WATCHDOG_MS = 7000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

setTimeout(() => {
	process.stderr.write(
		`private-references hook: BLOCKED, it did not finish within ${WATCHDOG_MS} ms, and a hook ` +
			'that times out lets the call through, so this one refuses instead.\n'
	);
	process.exit(2);
}, WATCHDOG_MS).unref();

/** A reason the hook cannot vouch for the command. Always a block. */
class Refusal extends Error {}

/**
 * @typedef {import('../../scripts/private-references.mjs').Finding} Finding
 * @typedef {{ where: string, text: string, homePaths: boolean }} Text
 * @typedef {{ where: string, path: string, cwd: string | null }} FileRef
 * @typedef {{ kind: 'var' | 'cmd', raw: string }} Subst
 * @typedef {{ type: 'word', value: string, raw: string, substs: Subst[] } | { type: 'op', value: string } | { type: 'redir', value: string }} Token
 * @typedef {{ gated: boolean, texts: Text[], files: FileRef[], refusals: string[], written: Set<string>, heredocs: number }} Analysis
 */

// ---------------------------------------------------------------------------------------------
// Parsing a shell command, far enough to know which words are published text and nothing more.
// ---------------------------------------------------------------------------------------------

/**
 * Takes heredoc bodies out of the command. A heredoc operator on a line starts a body on the next
 * line that runs to the line equal to its delimiter; several on one line are read in order.
 *
 * @param {string} command
 */
function extractHeredocs(command) {
	const lines = command.split('\n');
	/** @type {string[]} */
	const skeleton = [];
	/** @type {string[]} */
	const bodies = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		skeleton.push(line);
		i += 1;
		for (const op of line.matchAll(
			/(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/g
		)) {
			const strip = op[1] === '-';
			const delimiter = op[2] ?? op[3] ?? op[4];
			/** @type {string[]} */
			const body = [];
			let closed = false;
			while (i < lines.length) {
				const candidate = lines[i];
				i += 1;
				if ((strip ? candidate.replace(/^\t+/, '') : candidate) === delimiter) {
					closed = true;
					break;
				}
				body.push(candidate);
			}
			if (!closed) {
				throw new Refusal(
					`unterminated heredoc: no line reads « ${delimiter} ». If « << » is part of the text ` +
						'rather than a heredoc, put the text in a file and pass the file instead.'
				);
			}
			bodies.push(body.join('\n'));
		}
	}
	return { skeleton: skeleton.join('\n'), bodies };
}

/**
 * @param {string} src
 * @param {number} start index just after the opening `$(`
 * @returns {number} index of the matching `)`
 */
function readParen(src, start) {
	let depth = 1;
	let i = start;
	while (i < src.length) {
		const c = src[i];
		if (c === '\\') i += 2;
		else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) throw new Refusal('unbalanced single quote inside a command substitution');
			i = end + 1;
		} else if (c === '"') i = readDouble(src, i + 1).end + 1;
		else if (c === '`') i = readBacktick(src, i + 1) + 1;
		else if (c === '(') {
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
		} else if (c === '$' && src[i + 1] === '(') {
			const end = readParen(src, i + 2);
			const raw = src.slice(i, end + 1);
			substs.push({ kind: 'cmd', raw });
			value += raw;
			i = end + 1;
		} else if (c === '`') {
			const end = readBacktick(src, i + 1);
			const raw = src.slice(i, end + 1);
			substs.push({ kind: 'cmd', raw });
			value += raw;
			i = end + 1;
		} else if (c === '$' && /[A-Za-z_{0-9@*#?!$-]/.test(src[i + 1] ?? '')) {
			substs.push({ kind: 'var', raw: src.slice(i, i + 2) });
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
 * @param {string} src
 * @returns {Token[]}
 */
function tokenize(src) {
	/** @type {Token[]} */
	const tokens = [];
	/** @type {{ value: string, raw: string, substs: Subst[] } | null} */
	let word = null;
	const push = () => {
		if (word) tokens.push({ type: 'word', ...word });
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
		const rest = src.slice(i);
		if (c === ' ' || c === '\t') {
			push();
			i += 1;
		} else if (c === '\n') {
			push();
			tokens.push({ type: 'op', value: ';' });
			i += 1;
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
		} else if (c === '$' && src[i + 1] === '(') {
			const end = readParen(src, i + 2);
			const raw = src.slice(i, end + 1);
			add(raw, raw, [{ kind: 'cmd', raw }]);
			i = end + 1;
		} else if (c === '`') {
			const end = readBacktick(src, i + 1);
			const raw = src.slice(i, end + 1);
			add(raw, raw, [{ kind: 'cmd', raw }]);
			i = end + 1;
		} else if (c === '$' && /[A-Za-z_{0-9@*#?!$-]/.test(src[i + 1] ?? '')) {
			add(c, c, [{ kind: 'var', raw: src.slice(i, i + 2) }]);
			i += 1;
		} else if (/^(?:&>>|&>)/.test(rest)) {
			push();
			const op = /** @type {RegExpExecArray} */ (/^(?:&>>|&>)/.exec(rest))[0];
			tokens.push({ type: 'redir', value: op });
			i += op.length;
		} else if (/^(?:&&|\|\||;;|\|&|[|;&()])/.test(rest)) {
			push();
			const op = /** @type {RegExpExecArray} */ (/^(?:&&|\|\||;;|\|&|[|;&()])/.exec(rest))[0];
			tokens.push({ type: 'op', value: op });
			i += op.length;
		} else if (c === '>' || c === '<') {
			// A file descriptor number glued in front (`2>`) is part of the operator, not a word.
			if (word && /^\d+$/.test(word.raw)) word = null;
			push();
			const op = /** @type {RegExpExecArray} */ (/^(?:>>|>\||>&|<<<|<<-?|<&|<>|>|<)/.exec(rest))[0];
			tokens.push({ type: 'redir', value: op });
			i += op.length;
		} else {
			add(c);
			i += 1;
		}
	}
	push();
	return tokens;
}

/** @param {Token[]} tokens */
function segmentsOf(tokens) {
	/** @type {{ words: Extract<Token, { type: 'word' }>[], redirs: { op: string, target: string }[] }[]} */
	const segments = [{ words: [], redirs: [] }];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		const current = segments[segments.length - 1];
		if (token.type === 'op') segments.push({ words: [], redirs: [] });
		else if (token.type === 'redir') {
			const next = tokens[i + 1];
			if (next && next.type === 'word') {
				current.redirs.push({ op: token.value, target: next.value });
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

const WRAPPERS = new Set([
	'command',
	'builtin',
	'exec',
	'time',
	'nohup',
	'nice',
	'stdbuf',
	'sudo',
	'env',
	'timeout'
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const GH_WRITES = {
	issue: new Set(['create', 'edit', 'comment', 'close', 'reopen']),
	pr: new Set(['create', 'edit', 'comment', 'review', 'merge', 'close', 'reopen']),
	release: new Set(['create', 'edit'])
};
const GH_TEXT_LONG = new Set(['--title', '--body', '--comment', '--subject', '--notes']);
const GH_TEXT_SHORT = new Set(['-t', '-b', '-c', '-n']);
const GH_FILE_LONG = new Set(['--body-file', '--notes-file']);
const HOOKS_PATH = /core\.hookspath/i;

/**
 * @param {string} command
 * @param {string | null} cwd
 * @returns {Analysis}
 */
function analyze(command, cwd) {
	const { skeleton, bodies } = extractHeredocs(command);
	/** @type {Analysis} */
	const result = {
		gated: false,
		texts: [],
		files: [],
		refusals: [],
		written: new Set(),
		heredocs: bodies.length
	};
	let here = cwd;

	/**
	 * @param {string} where
	 * @param {Extract<Token, { type: 'word' }>} word
	 * @param {string} value
	 * @param {string | null} dir
	 */
	const addText = (where, word, value, dir) => {
		result.texts.push({ where, text: value, homePaths: true });
		for (const subst of word.substs) {
			if (subst.kind === 'var') {
				result.refusals.push(
					`${where} expands ${subst.raw}…, whose value this hook cannot see. Write the text out, ` +
						'or put it in a file and pass the file.'
				);
				continue;
			}
			if (/^\$\(\s*cat\s+<</.test(subst.raw)) continue; // a heredoc, whose body is read below
			const cat = /^\$\(\s*cat\s+(?:<\s*)?([^\s()<>|;&$`'"]+)\s*\)$/.exec(subst.raw);
			if (cat) result.files.push({ where: `${where} $(cat) file`, path: cat[1], cwd: dir });
			else {
				result.refusals.push(
					`${where} runs a command substitution this hook cannot evaluate (${subst.raw.slice(0, 40)}). ` +
						'Put the text in a file and pass the file.'
				);
			}
		}
	};

	for (const segment of segmentsOf(tokenize(skeleton))) {
		for (const redir of segment.redirs) {
			if (/>/.test(redir.op)) {
				const target = resolveFrom(here, redir.target);
				result.written.add(target ?? redir.target);
			}
		}
		const words = [...segment.words];
		// Leading assignments, then wrappers that run the rest of the line as the command.
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) {
			const assignment = /** @type {typeof words[number]} */ (words.shift());
			if (/^GIT_CONFIG/.test(assignment.value) && HOOKS_PATH.test(command)) {
				result.refusals.push(
					'a GIT_CONFIG_* variable here can redirect core.hooksPath and disable the git hooks'
				);
			}
		}
		while (words.length > 0 && WRAPPERS.has(words[0].value)) {
			const wrapper = /** @type {typeof words[number]} */ (words.shift()).value;
			while (
				words.length > 0 &&
				(words[0].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value))
			) {
				if (/^GIT_CONFIG/.test(words[0].value) && HOOKS_PATH.test(command)) {
					result.refusals.push(
						'a GIT_CONFIG_* variable here can redirect core.hooksPath and disable the git hooks'
					);
				}
				words.shift();
			}
			if (wrapper === 'timeout' && words.length > 0) words.shift();
		}
		if (words.length === 0) continue;
		const name = words[0].value.split('/').pop() ?? '';
		const args = words.slice(1);

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
			for (const arg of args)
				if (!arg.value.startsWith('-'))
					result.written.add(resolveFrom(here, arg.value) ?? arg.value);
			continue;
		}
		if (SHELLS.has(name)) {
			const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word.value));
			if (flag >= 0 && args[flag + 1]) {
				const inner = analyze(args[flag + 1].value, here);
				mergeInto(result, inner);
			}
			continue;
		}
		if (name === 'eval') {
			mergeInto(result, analyze(args.map((word) => word.value).join(' '), here));
			continue;
		}
		if (name === 'xargs' || name === 'parallel' || name === 'find') {
			if (args.some((word) => word.value === 'git' || word.value === 'gh')) {
				result.gated = true;
				result.refusals.push(
					`${name} passes arguments this hook cannot see to git or gh. Run the command directly.`
				);
			}
			continue;
		}
		if (name === 'git') analyzeGit(args, here, result, addText);
		if (name === 'gh') analyzeGh(args, here, result, addText);
		if (name === 'curl' || name === 'wget') analyzeHttp(args, here, result, addText);
	}

	if (result.gated) {
		bodies.forEach((body, index) =>
			result.texts.push({
				where: bodies.length > 1 ? `heredoc body ${index + 1}` : 'a heredoc body',
				text: body,
				homePaths: true
			})
		);
		result.texts.push({ where: 'the command text', text: skeleton, homePaths: false });
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
	into.heredocs += from.heredocs;
	for (const path of from.written) into.written.add(path);
}

/**
 * @param {Extract<Token, { type: 'word' }>[]} args
 * @param {string | null} cwd
 * @param {Analysis} result
 * @param {(where: string, word: Extract<Token, { type: 'word' }>, value: string, dir: string | null) => void} addText
 */
function analyzeGit(args, cwd, result, addText) {
	let dir = cwd;
	let i = 0;
	// Global options, up to the subcommand.
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
	if (sub !== 'commit' && sub !== 'merge') return;
	result.gated = true;

	for (let j = 0; j < rest.length; j += 1) {
		const word = rest[j];
		const value = word.value;
		const next = rest[j + 1];
		if (value === '--') break;
		if (value === '--no-verify') {
			result.refusals.push(`git ${sub} --no-verify skips the repository's git hooks`);
		} else if (value === '--message' || value === '--trailer' || value === '--author') {
			if (next) addText(`the ${value} value`, next, next.value, dir);
			j += 1;
		} else if (/^--(?:message|trailer|author)=/.test(value)) {
			const [flag, ...parts] = value.split('=');
			addText(`the ${flag} value`, word, parts.join('='), dir);
		} else if (value === '--file' || value === '--template') {
			if (next) result.files.push({ where: `the ${value} file`, path: next.value, cwd: dir });
			j += 1;
		} else if (/^--(?:file|template)=/.test(value)) {
			const [flag, ...parts] = value.split('=');
			result.files.push({ where: `the ${flag} file`, path: parts.join('='), cwd: dir });
		} else if (/^-[A-Za-z]/.test(value) && !value.startsWith('--')) {
			// A cluster of short options: `-am`, `-sm "msg"`, `-mmsg`, `-Ffile`.
			for (let k = 1; k < value.length; k += 1) {
				const letter = value[k];
				if (letter === 'n') {
					result.refusals.push(
						`git ${sub} -n is --no-verify, which skips the repository's git hooks`
					);
					continue;
				}
				if ('mFtCc'.includes(letter)) {
					const attached = value.slice(k + 1);
					const argument = attached !== '' ? attached : next?.value;
					if (attached === '') j += 1;
					if (argument === undefined) break;
					if (letter === 'm') {
						if (attached !== '') addText('the -m value', word, argument, dir);
						else if (next) addText('the -m value', next, argument, dir);
					} else if (letter === 'F' || letter === 't') {
						result.files.push({ where: `the -${letter} file`, path: argument, cwd: dir });
					}
					break;
				}
			}
		}
	}
}

/**
 * @param {Extract<Token, { type: 'word' }>[]} args
 * @param {string | null} cwd
 * @param {Analysis} result
 * @param {(where: string, word: Extract<Token, { type: 'word' }>, value: string, dir: string | null) => void} addText
 */
function analyzeGh(args, cwd, result, addText) {
	const words = args.filter((word, index) => {
		// `-R owner/repo` may come first; it is not published text.
		const previous = args[index - 1]?.value;
		return !(
			word.value === '-R' ||
			word.value === '--repo' ||
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
			if (flag === '--input') {
				result.files.push({ where: 'the --input file', path: argument, cwd });
			} else if ((flag === '-F' || flag === '--field') && /^[^=]*=@/.test(argument)) {
				result.files.push({
					where: `the ${flag} ${argument.split('=')[0]} file`,
					path: argument.replace(/^[^=]*=@/, ''),
					cwd
				});
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
	if (!writes || !writes.has(words[1]?.value)) return;
	result.gated = true;
	const rest = words.slice(2);
	for (let j = 0; j < rest.length; j += 1) {
		const word = rest[j];
		const next = rest[j + 1];
		const value = word.value;
		const eq = /^(--[a-z-]+)=(.*)$/s.exec(value);
		const flag = eq
			? eq[1]
			: /^-[A-Za-z]/.test(value) && !value.startsWith('--')
				? value.slice(0, 2)
				: value;
		const attached = eq
			? eq[2]
			: flag.length === 2 && value.length > 2
				? value.slice(2)
				: undefined;
		const isText = GH_TEXT_LONG.has(flag) || GH_TEXT_SHORT.has(flag);
		const isFile = GH_FILE_LONG.has(flag) || flag === '-F';
		if (!isText && !isFile) continue;
		let argument = attached;
		let source = word;
		if (argument === undefined && next) {
			argument = next.value;
			source = next;
			j += 1;
		}
		if (argument === undefined) continue;
		if (isText) addText(`the ${flag} value`, source, argument, cwd);
		else result.files.push({ where: `the ${flag} file`, path: argument, cwd });
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
const WGET_DATA = new Set(['--post-data', '--body-data']);
const WGET_FILE = new Set(['--post-file', '--body-file']);

/**
 * `curl` and `wget` aimed at GitHub's API are the same write channel as `gh api`, without its
 * name. Every data option is read: its value as text, or the file an `@` (or curl's `<` in a form
 * field) names.
 *
 * @param {Extract<Token, { type: 'word' }>[]} args
 * @param {string | null} cwd
 * @param {Analysis} result
 * @param {(where: string, word: Extract<Token, { type: 'word' }>, value: string, dir: string | null) => void} addText
 */
function analyzeHttp(args, cwd, result, addText) {
	if (!args.some((word) => GITHUB_API.test(word.value))) return;
	result.gated = true;
	for (let j = 0; j < args.length; j += 1) {
		const word = args[j];
		const next = args[j + 1];
		const eq = /^(--[a-z-]+)=(.*)$/s.exec(word.value);
		const flag = eq ? eq[1] : word.value;
		const isData = CURL_DATA.has(flag) || WGET_DATA.has(flag);
		const isFile = CURL_FILE.has(flag) || WGET_FILE.has(flag);
		if (!isData && !isFile) continue;
		let argument = eq ? eq[2] : undefined;
		let source = word;
		if (argument === undefined && next) {
			argument = next.value;
			source = next;
			j += 1;
		}
		if (argument === undefined) continue;
		const fileInData = /^(?:[^=@<]*=)?[@<](.+)$/s.exec(argument);
		if (isFile) result.files.push({ where: `the ${flag} file`, path: argument, cwd });
		else if (fileInData && flag !== '--data-raw' && flag !== '--form-string') {
			result.files.push({ where: `the ${flag} file`, path: fileInData[1], cwd });
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
	for (const file of analysis.files) {
		const label = `${file.where} ${file.path}`;
		if (file.path === '-') {
			if (analysis.heredocs === 0) {
				analysis.refusals.push(
					`${file.where} reads its body from stdin, which this hook cannot see. Pass a file path or a heredoc.`
				);
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
			texts.push({
				where: `${file.where} ${path}`,
				text: readFileSync(path, 'utf8'),
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
	if (typeof value === 'string')
		out.push({ where: `the ${key || 'input'} field`, text: value, homePaths: true });
	else if (Array.isArray(value))
		value.forEach((item, index) => stringsOf(item, `${key}[${index}]`, out));
	else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) stringsOf(v, key ? `${key}.${k}` : k, out);
	}
	return out;
}

/** @param {string} message */
function block(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

async function main() {
	let raw = '';
	for await (const chunk of process.stdin) raw += chunk;

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
	let refusals = [];
	if (tool.startsWith('mcp__')) {
		texts = stringsOf(input, '', []);
	} else {
		const command = input?.command;
		if (typeof command !== 'string') {
			block(
				'private-references hook: BLOCKED, the tool input carries no command string, so it cannot vouch for the call.'
			);
			return;
		}
		// Cheap exit for the overwhelming majority of commands, which name neither tool.
		if (!/\b(?:git|gh)\b|github\.com/i.test(command) && !HOOKS_PATH.test(command)) process.exit(0);
		let analysis;
		try {
			analysis = analyze(command, typeof payload.cwd === 'string' ? payload.cwd : null);
		} catch (error) {
			if (!/\b(?:git\s+(?:\S+\s+)*commit|gh\s+(?:issue|pr|release|api))\b/.test(command))
				process.exit(0);
			block(
				`private-references hook: BLOCKED, it could not parse this command: ${error instanceof Error ? error.message : error}`
			);
			return;
		}
		if (!analysis.gated && analysis.refusals.length === 0) process.exit(0);
		texts = [...analysis.texts, ...readFiles(analysis)];
		refusals = analysis.refusals;
	}

	const { calibrate, findPrivateReferences, redact, HOW_TO_READ } =
		await import('../../scripts/private-references.mjs');
	calibrate();

	/** @type {string[]} */
	const lines = [];
	const seen = new Set();
	for (const text of texts) {
		for (const finding of findPrivateReferences(text.text)) {
			if (!text.homePaths && finding.kind === 'home-path') continue;
			const key = `${finding.kind}\0${finding.match}`;
			if (!text.homePaths && seen.has(key)) continue;
			seen.add(key);
			lines.push(
				`  [${finding.kind}] in ${text.where}, line ${finding.line}: ${redact(finding)}\n` +
					`    how to read it: ${HOW_TO_READ[finding.kind]}`
			);
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
			`this command:\n${refusals.map((r) => `  - ${r}`).join('\n')}\n`;
	}
	block(message.trimEnd());
}

main().catch((error) => {
	block(
		`private-references hook: BLOCKED on an internal error, so nothing is let through: ${error instanceof Error ? error.stack : error}`
	);
});
