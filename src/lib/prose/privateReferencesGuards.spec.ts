import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	parseBaseline,
	runScan,
	scanItems,
	type ScanSource
} from '../../../scripts/published-text-scan.mjs';
import { findPrivateReferences } from '../../../scripts/private-references.mjs';

/**
 * The three guards that read what `privateReferences.spec.ts` cannot, because it is not a file:
 * the Claude Code PreToolUse hook, the git hooks, and the scheduled scan of published text. All
 * three import the one matcher in `scripts/private-references.mjs`; these tests drive each guard
 * through its real entry point (a process reading tool-input JSON, a real `git commit` in a
 * throwaway repository, the scan's own run function) rather than calling the matcher directly,
 * because the matcher is already covered and what can break here is the WIRING around it.
 *
 * Every planted positive is assembled at run time: this file is tracked, so a literal one would be
 * a finding against it.
 *
 * BREAK-CHECKED (2026-09-26), one clause at a time, each restored byte-identical from a pre-break
 * copy; every break below turned the named test red, and each separates the guard doing that
 * thing from the same guard silently not doing it:
 * - hook: findings ignored (« carrying a claude-address »); unparsable input passed (« not
 *   JSON »); unreadable body file passed (« cannot read »); unseen stdin passed (« from stdin »);
 *   `|| exit 2` dropped from the registered line (« cannot start »); `--no-verify` allowed;
 *   curl to the API ignored; MCP input ignored; the claude.ai pattern blinded, which the hook's
 *   calibration turns into a refusal of even a clean commit (« lets a clean commit through »).
 * - git hooks: no staged line read; no message read; removed lines read as well (« ADDED lines
 *   only »); missing gitleaks passed; BP_SKIP_GITLEAKS also skipping the matcher (« no skip »);
 *   gitleaks' non-zero exit ignored; gitleaks calibration always passing (« planted token »).
 * - pull request mode: commit messages, the title, the body, each ignored in turn.
 * - scheduled scan: a short read accepted; a stale baseline entry accepted; the full match
 *   printed instead of the redacted one. Run live against GitHub with the external-image pattern
 *   blinded, the scan refused on its calibration before reporting anything.
 *
 * BREAK-CHECKED AGAIN (2026-09-27) after the review's fixes, each red on its « review » test:
 * the command line not read; the verb read undequoted; a substituted command word allowed; only
 * the first word taken as a verb; a `-c` string not read; a quoted `<<` taken as a heredoc; any
 * heredoc approving stdin; a pipe into the segment ignored; a `<` redirect not read; any `$( )`
 * holding `<<` read as a heredoc; the decoded copy, percent, `\u` and hexadecimal-entity decoding
 * each dropped; the quadratic address and unbounded image patterns restored (30 s and 14 s); a
 * killed worker read as clean; gist files, release assets, tags and attached curl values each
 * unread; only the full `--no-verify` refused; GIT_CONFIG variables allowed; `-uno` and merge's
 * `-n` misread; NULs kept; the gitleaks capability check skipped; a sentence version refused.
 * Two greens, read: removing the hook's calibration changes nothing while the matcher is healthy
 * (blinding a pattern with calibration present refuses even a clean commit, so it is live); and
 * the hook's JSON-strings step was redundant with the decoded copy, so it was deleted.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HOOK = join(REPO_ROOT, '.claude/hooks/private-references.mjs');
const GITHOOKS = join(REPO_ROOT, '.githooks');

const CLAUDE_LINK = `https://${['claude', 'ai'].join('.')}/design/p/0000`;
const HOME_PATH = ['', 'home', 'someone', 'notes.md'].join('/');
const PERSONAL = ['someone', 'gmail.com'].join('@');
const PLANTED = {
	'claude-address': CLAUDE_LINK,
	'home-path': HOME_PATH,
	'personal-email': PERSONAL
};

let scratch: string;
beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'bp-private-refs-'));
});
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function runHook(input: string, cwd = scratch) {
	const result = spawnSync(process.execPath, [HOOK], { input, cwd, encoding: 'utf8' });
	return { status: result.status, stderr: result.stderr };
}

function bash(command: string, cwd = scratch) {
	return runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), cwd);
}

describe('Claude Code hook: blocks a commit or a post that carries a private reference', () => {
	it('lets a clean commit through, attribution trailer included', () => {
		const result = bash(
			'git commit -m "fix: a clean subject" -m "Co-Authored-By: Claude <noreply@anthropic.com>"'
		);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
	});

	it.each(Object.entries(PLANTED))('blocks a commit message carrying a %s', (kind, value) => {
		const result = bash(`git commit -m "docs: see ${value}"`);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain(`[${kind}]`);
		expect(result.stderr).toContain('the -m value');
	});

	it('blocks a heredoc message, the shape Claude Code writes commits in', () => {
		const command = `git commit -m "$(cat <<'EOF'\nfeat: x\n\nCanvas: ${CLAUDE_LINK}\nEOF\n)"`;
		const result = bash(command);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('[claude-address] in a heredoc body, line 3');
	});

	it('blocks a PR whose --body-file carries a link, and names the file and line', () => {
		const body = join(scratch, 'body-with-link.md');
		writeFileSync(body, `## Summary\n\nDrawn on ${CLAUDE_LINK}\n`);
		const result = bash(`gh pr create --title "t" --body-file ${body}`);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain(`[claude-address] in the --body-file file ${body}, line 3`);
	});

	it('lets a PR through when its --body-file is clean', () => {
		const body = join(scratch, 'clean-body.md');
		writeFileSync(body, '## Summary\n\nNothing private here.\n');
		const result = bash(`gh pr create --title "t" --body-file ${body}`);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
	});

	it('reads a gh api body passed as -F body=@file', () => {
		const body = join(scratch, 'api-body.md');
		writeFileSync(body, `reach me at ${PERSONAL}\n`);
		const result = bash(`gh api repos/o/r/issues/1/comments -F body=@${body}`);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('[personal-email]');
	});

	it('reads git commit -F <file>', () => {
		const message = join(scratch, 'message.txt');
		writeFileSync(message, `fix: y\n\nfrom ${HOME_PATH}\n`);
		const result = bash(`git commit -F ${message}`);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('[home-path]');
	});

	it('does not treat a path the command merely USES as published text', () => {
		// The worktree path, the cwd change and the -F path are not in the message, so they are not
		// findings; only the published text is read for home paths.
		const message = join(scratch, 'clean-message.txt');
		writeFileSync(message, 'fix: z\n');
		const result = bash(`cd ${scratch} && git -C ${scratch} commit -F ${message}`);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
	});

	it('ignores a command that publishes nothing, whatever it carries', () => {
		const result = bash(`ls ${HOME_PATH} && grep -rn "git commit" .`);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
	});

	it('reads a gated command nested in bash -c', () => {
		const result = bash(`bash -c 'git commit -m "see ${CLAUDE_LINK}"'`);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('[claude-address]');
	});

	it('reads every string a GitHub MCP tool would post', () => {
		const call = (body: string) =>
			runHook(
				JSON.stringify({
					tool_name: 'mcp__plugin_github_github__add_issue_comment',
					tool_input: { owner: 'o', repo: 'r', issue_number: 1, body }
				})
			);
		const blocked = call(`drawn on ${CLAUDE_LINK}`);
		expect(blocked.status).toBe(2);
		expect(blocked.stderr).toContain('[claude-address] in the body field, line 1');
		expect(call('nothing private').status).toBe(0);
	});

	it('reads curl aimed at the GitHub API, inline data and @file alike', () => {
		const url = 'https://api.github.com/repos/o/r/issues/1/comments';
		const inline = bash(`curl -X POST ${url} -d '{"body":"see ${CLAUDE_LINK}"}'`);
		expect(inline.status).toBe(2);
		expect(inline.stderr).toContain('[claude-address] in the -d value');

		const file = join(scratch, 'curl-body.json');
		writeFileSync(file, JSON.stringify({ body: `from ${HOME_PATH}` }));
		const fromFile = bash(`curl -X POST ${url} --data-binary @${file}`);
		expect(fromFile.status).toBe(2);
		expect(fromFile.stderr).toContain('[home-path] in the --data-binary file');

		expect(bash(`curl -X POST ${url} -d '{"body":"clean"}'`).status).toBe(0);
		// The same data to any other host is not a GitHub write and is not this hook's business.
		// The same body FILE sent to any other host is not a GitHub write, so the hook does not open
		// it. (A link typed INTO any command line is refused whatever the host: review finding 1.)
		expect(bash(`curl -X POST https://example.test/x --data-binary @${file}`).status).toBe(0);
	});

	it('refuses an image from an outside host in a body, and admits GitHub-hosted ones', () => {
		const outside = `![chart](${'https'}://${['collect', 'example'].join('.')}/c.png?q=1)`;
		const blocked = bash(`gh pr comment 1 --body "${outside}"`);
		expect(blocked.status).toBe(2);
		expect(blocked.stderr).toContain('[external-image]');
		expect(blocked.stderr).toContain('image from collect.example');
		const hosted = '![chart](https://github.com/user-attachments/assets/0000)';
		expect(bash(`gh pr comment 1 --body "${hosted}"`).status).toBe(0);
	});

	it('prints the match redacted, because its output reaches the model', () => {
		const result = bash(`git commit -m "reach ${PERSONAL}"`);
		expect(result.status).toBe(2);
		expect(result.stderr).not.toContain(PERSONAL);
		expect(result.stderr).toContain('s…@g…');
	});

	describe('refuses the ways around the other guards', () => {
		const TAG = ['gitleaks', 'allow'].join(':');
		it.each([
			['git commit --no-verify -m "x"', '--no-verify'],
			['git commit -nm "x"', '-n is --no-verify'],
			['git -c core.hooksPath=/dev/null commit -m "x"', 'core.hooksPath'],
			['git config --unset core.hooksPath', 'core.hooksPath'],
			['git config core.hooksPath /tmp/elsewhere', 'core.hooksPath'],
			[`git commit -m "key # ${TAG}"`, '[scanner-bypass]']
		])('%s', (command, reason) => {
			const result = bash(command);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain(reason);
		});

		it('lets the one documented activation through', () => {
			const result = bash('git config core.hooksPath .githooks');
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
		});
	});

	describe('fails closed', () => {
		it('on input that is not JSON', () => {
			const result = runHook('{not json');
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('could not parse the tool input');
		});

		it('on input with no command', () => {
			const result = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: {} }));
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('no command string');
		});

		it('on a body file it cannot read', () => {
			const result = bash(`gh issue comment 1 --body-file ${join(scratch, 'missing.md')}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('cannot read');
		});

		it('on a body read from stdin it cannot see', () => {
			const result = bash(`cat notes.md | gh issue comment 1 --body-file -`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('reads its body from stdin');
		});

		it('on a body file written by the same command', () => {
			const body = join(scratch, 'written-now.md');
			const result = bash(`echo hi > ${body} && gh pr comment 1 --body-file ${body}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('written by this same command');
		});

		it('on a relative body file after a cd it cannot follow', () => {
			const result = bash(`cd "$DIR" && gh pr comment 1 --body-file body.md`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('cannot tell which directory');
		});

		it('on an unterminated heredoc', () => {
			const result = bash(`gh pr comment 1 --body-file - <<'EOF'\nno end marker`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('unterminated heredoc');
		});

		it('on a gated command fed arguments by xargs', () => {
			const result = bash(`echo msg | xargs git commit -m`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('xargs');
		});
	});

	describe('as registered in .claude/settings.json', () => {
		const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude/settings.json'), 'utf8'));
		const registered: string[] = settings.hooks.PreToolUse.filter(
			(entry: { matcher: string }) => entry.matcher === 'Bash'
		).flatMap((entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command));
		const command = registered.find((line) => line.includes('private-references.mjs'));

		function runRegistered(projectDir: string, toolCommand: string) {
			const result = spawnSync('sh', ['-c', command ?? 'exit 99'], {
				input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: toolCommand } }),
				env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
				encoding: 'utf8'
			});
			return { status: result.status, stderr: result.stderr };
		}

		it('is registered on the Bash matcher, with a timeout above its own watchdog', () => {
			expect(command).toBeDefined();
			const entry = settings.hooks.PreToolUse.find(
				(e: { matcher: string }) => e.matcher === 'Bash'
			).hooks.find((hook: { command: string }) => hook.command === command);
			expect(entry.timeout).toBeGreaterThanOrEqual(10);
		});

		it('is registered on every GitHub MCP tool, plugin-scoped names included', () => {
			const matchers: string[] = settings.hooks.PreToolUse.filter(
				(entry: { hooks: { command: string }[] }) =>
					entry.hooks.some((hook) => hook.command === command)
			).map((entry: { matcher: string }) => entry.matcher);
			for (const tool of [
				'mcp__github__create_issue',
				'mcp__plugin_github_github__add_issue_comment'
			]) {
				expect(
					matchers.some((matcher) => new RegExp(matcher).test(tool)),
					tool
				).toBe(true);
			}
		});

		it('blocks through the registered command line, not only when run directly', () => {
			expect(runRegistered(REPO_ROOT, `git commit -m "${CLAUDE_LINK}"`).status).toBe(2);
			expect(runRegistered(REPO_ROOT, 'git commit -m "clean"').status).toBe(0);
		});

		it('turns a hook that cannot start into a block rather than a silent pass', () => {
			// Claude Code treats any exit other than 2 as non-blocking, and a missing script exits 1
			// from node. The registered line has to convert that, or a moved file disables the gate.
			const result = runRegistered(join(scratch, 'no-such-project'), 'git commit -m "clean"');
			expect(result.status).toBe(2);
		});
	});
});

/** A throwaway repository whose hooks are this tree's `.githooks`, and a PATH we control. */
function makeRepo(
	name: string,
	gitleaks: 'absent' | 'clean' | 'leak' | 'old' | 'blind' | 'distro' | 'lacking-flag'
) {
	const dir = join(scratch, name);
	const bin = join(scratch, `${name}-bin`);
	mkdirSync(dir);
	mkdirSync(bin);
	for (const tool of ['git', 'sh', 'dirname', 'cat']) {
		const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
		symlinkSync(found, join(bin, tool));
	}
	symlinkSync(process.execPath, join(bin, 'node'));
	const argsLog = join(bin, 'gitleaks-args.log');
	if (gitleaks !== 'absent') {
		// A stand-in recording how it was called, so the flags the hooks pass are asserted rather than
		// assumed. It reads stdin, as the real `gitleaks stdin` does.
		const exit = gitleaks === 'leak' ? 1 : 0;
		// The Arch package prints this sentence instead of a number (measured 2026-09-27).
		const version =
			gitleaks === 'old'
				? '8.18.4'
				: gitleaks === 'distro'
					? 'version is set by build process'
					: '8.30.1';
		// Help lists the flags the hooks pass, as the real `git --help` and `stdin --help` do.
		const flags = [
			'--pre-commit',
			'--staged',
			'--log-opts',
			'--redact',
			'--no-banner',
			'--verbose',
			'--exit-code',
			...(gitleaks === 'lacking-flag' ? [] : ['--ignore-gitleaks-allow'])
		];
		writeFileSync(
			join(bin, 'gitleaks'),
			`#!/bin/sh\nif [ "$1" = version ]; then echo "${version}"; exit 0; fi\n` +
				`case "$*" in *--help*) printf '      %s string   a flag\\n' ${flags.join(' ')}; exit 0;; esac\n` +
				// The calibration run asks for exit code 42 on a finding; a blind gitleaks returns 0.
				`case "$*" in *"--exit-code 42"*) cat > /dev/null; exit ${gitleaks === 'blind' ? 0 : 42};; esac\n` +
				`echo "$*" >> ${argsLog}\ncat > /dev/null\n` +
				(exit ? 'echo "leaks found: 1" >&2\n' : '') +
				`exit ${exit}\n`
		);
		chmodSync(join(bin, 'gitleaks'), 0o755);
	}
	const env: Record<string, string> = {
		PATH: bin,
		HOME: scratch,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: '/dev/null'
	};
	const git = (args: string[], extraEnv: Record<string, string> = {}) => {
		const result = spawnSync(join(bin, 'git'), args, {
			cwd: dir,
			env: { ...env, ...extraEnv },
			encoding: 'utf8'
		});
		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	};
	git(['init', '-q', '-b', 'main']);
	git(['config', 'user.name', 'Test']);
	git(['config', 'user.email', 'test@example.test']);
	git(['config', 'commit.gpgsign', 'false']);
	git(['config', 'core.hooksPath', GITHOOKS]);
	const gitleaksCalls = () => {
		try {
			return readFileSync(argsLog, 'utf8').trim().split('\n');
		} catch {
			return [];
		}
	};
	/** The pull request mode, as the workflow runs it, over this repository's own commits. */
	const pullRequest = (extraEnv: Record<string, string>) => {
		const result = spawnSync(
			process.execPath,
			[join(REPO_ROOT, 'scripts/private-references-git.mjs'), 'pull-request'],
			{ cwd: dir, env: { ...env, GITHUB_ACTIONS: '', ...extraEnv }, encoding: 'utf8' }
		);
		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	};
	return { dir, git, gitleaksCalls, pullRequest };
}

const SKIP = { BP_SKIP_GITLEAKS: '1' };

describe('git hooks: pre-commit reads the staged lines, commit-msg reads the message', () => {
	it('lets a clean commit through, and says plainly that secrets were not scanned', () => {
		const repo = makeRepo('clean', 'absent');
		writeFileSync(join(repo.dir, 'a.md'), 'plain text\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a'], SKIP);
		expect(result.output).toContain('secrets are NOT being scanned');
		expect(result.status).toBe(0);
	});

	it.each(Object.entries(PLANTED))('pre-commit blocks a staged %s', (kind, value) => {
		const repo = makeRepo(`staged-${kind}`, 'absent');
		writeFileSync(join(repo.dir, 'a.md'), `line one\nsee ${value}\n`);
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a'], SKIP);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain(`a.md:2 [${kind}]`);
	});

	it('pre-commit reads ADDED lines only, so a commit removing a leak goes through', () => {
		const repo = makeRepo('removal', 'absent');
		writeFileSync(join(repo.dir, 'a.md'), `keep\nsee ${CLAUDE_LINK}\n`);
		repo.git(['add', 'a.md']);
		expect(repo.git(['commit', '-q', '--no-verify', '-m', 'seed'], SKIP).status).toBe(0);
		writeFileSync(join(repo.dir, 'a.md'), 'keep\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: remove the link'], SKIP);
		expect(result.status).toBe(0);
	});

	it.each(Object.entries(PLANTED))('commit-msg blocks a message carrying a %s', (kind, value) => {
		const repo = makeRepo(`message-${kind}`, 'absent');
		writeFileSync(join(repo.dir, 'a.md'), 'plain\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', `docs: a\n\nsee ${value}`], SKIP);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain(`commit message:3 [${kind}]`);
	});

	it('fails when gitleaks is missing and nothing says to skip it, naming how to install it', () => {
		const repo = makeRepo('no-gitleaks', 'absent');
		writeFileSync(join(repo.dir, 'a.md'), 'plain\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a']);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('gitleaks is not installed');
		expect(result.output).toContain('BP_SKIP_GITLEAKS=1');
	});

	it('runs gitleaks with the documented flags and passes when it finds nothing', () => {
		const repo = makeRepo('gitleaks-clean', 'clean');
		writeFileSync(join(repo.dir, 'a.md'), 'plain\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a']);
		expect(result.status).toBe(0);
		expect(repo.gitleaksCalls()).toEqual([
			'git --pre-commit --staged --redact --no-banner --verbose --ignore-gitleaks-allow',
			'stdin --redact --no-banner --verbose --ignore-gitleaks-allow'
		]);
	});

	it('refuses a gitleaks that cannot find the planted token, before trusting its clean result', () => {
		const repo = makeRepo('gitleaks-blind', 'blind');
		writeFileSync(join(repo.dir, 'a.md'), 'plain\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a']);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('did not report the planted token');
		expect(repo.gitleaksCalls()).toEqual([]);
	});

	it('accepts a distribution build whose version is a sentence, judged by what it can do', () => {
		const repo = makeRepo('gitleaks-distro', 'distro');
		writeFileSync(join(repo.dir, 'a.md'), 'plain\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a']);
		expect(result.output).not.toContain('BLOCKED');
		expect(result.status).toBe(0);
		expect(repo.gitleaksCalls()).toHaveLength(2);
	});

	it('refuses a gitleaks whose help does not list a flag the hooks pass, naming the flag', () => {
		const repo = makeRepo('gitleaks-lacking-flag', 'lacking-flag');
		writeFileSync(join(repo.dir, 'a.md'), 'plain\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a']);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('does not list --ignore-gitleaks-allow');
		expect(repo.gitleaksCalls()).toEqual([]);
	});

	it('refuses a gitleaks too old to have the commands the hooks call', () => {
		const repo = makeRepo('gitleaks-old', 'old');
		writeFileSync(join(repo.dir, 'a.md'), 'plain\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a']);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('need 8.19.0 or later');
	});

	it('blocks when gitleaks reports a secret', () => {
		const repo = makeRepo('gitleaks-leak', 'leak');
		writeFileSync(join(repo.dir, 'a.md'), 'plain\n');
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a']);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('gitleaks');
	});

	it('the shared matcher has no skip: BP_SKIP_GITLEAKS does not let a link through', () => {
		const repo = makeRepo('no-matcher-skip', 'clean');
		writeFileSync(join(repo.dir, 'a.md'), `see ${CLAUDE_LINK}\n`);
		repo.git(['add', 'a.md']);
		const result = repo.git(['commit', '-q', '-m', 'docs: a'], SKIP);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('[claude-address]');
	});
});

describe('pull request check: what a squash merge copies onto main', () => {
	function branch(name: string, message: string) {
		const repo = makeRepo(name, 'clean');
		writeFileSync(join(repo.dir, 'a.md'), 'base\n');
		repo.git(['add', 'a.md']);
		repo.git(['commit', '-q', '--no-verify', '-m', 'base']);
		const base = repo.git(['rev-parse', 'HEAD']).output.trim();
		writeFileSync(join(repo.dir, 'a.md'), 'base\nchange\n');
		repo.git(['add', 'a.md']);
		repo.git(['commit', '-q', '--no-verify', '-m', message]);
		const head = repo.git(['rev-parse', 'HEAD']).output.trim();
		return { repo, base, head };
	}

	it('passes a clean pull request and says what it read', () => {
		const { repo, base, head } = branch('pr-clean', 'feat: clean');
		const result = repo.pullRequest({
			BASE_SHA: base,
			HEAD_SHA: head,
			PR_TITLE: 't',
			PR_BODY: 'b'
		});
		expect(result.output).toContain('read 3 texts (1 commit messages, the title and the body)');
		expect(result.status).toBe(0);
	});

	it.each([
		['a commit message', { message: `feat: x\n\nCanvas: ${CLAUDE_LINK}`, title: 't', body: 'b' }],
		['the title', { message: 'feat: x', title: `see ${CLAUDE_LINK}`, body: 'b' }],
		['the body', { message: 'feat: x', title: 't', body: `drawn on ${CLAUDE_LINK}` }]
	])('refuses a link in %s', (where, { message, title, body }) => {
		const { repo, base, head } = branch(`pr-${where.replace(/ /g, '-')}`, message);
		const result = repo.pullRequest({
			BASE_SHA: base,
			HEAD_SHA: head,
			PR_TITLE: title,
			PR_BODY: body
		});
		expect(result.status).toBe(1);
		expect(result.output).toContain('[claude-address]');
	});

	it('refuses to run on commit ids it cannot trust', () => {
		const { repo } = branch('pr-bad-ids', 'feat: x');
		const result = repo.pullRequest({
			BASE_SHA: 'main',
			HEAD_SHA: 'HEAD',
			PR_TITLE: '',
			PR_BODY: ''
		});
		expect(result.status).toBe(1);
		expect(result.output).toContain('must be full commit ids');
	});
});

describe('scheduled scan of published text', () => {
	const cleanSource = (overrides: Partial<ScanSource> = {}): ScanSource => ({
		totals: () => ({ issues: 2, pulls: 1, commits: 1 }),
		items: () => [
			{ kind: 'item', number: 1, where: 'title and body', text: 'an issue body' },
			{ kind: 'item', number: 2, where: 'title and body', text: 'another' },
			{ kind: 'item', number: 3, where: 'title and body', text: 'a pull request' },
			{ kind: 'comment', number: 1, where: 'comment 11', text: 'a comment' },
			{ kind: 'commit', where: 'commit 0123456789ab', text: 'fix: a subject' }
		],
		...overrides
	});

	function capture(source: ScanSource) {
		const lines: string[] = [];
		const status = runScan(source, (line) => lines.push(line));
		return { status, output: lines.join('\n') };
	}

	it('passes over clean text and says how much it read', () => {
		const result = capture(cleanSource());
		expect(result.status).toBe(0);
		expect(result.output).toContain(
			'read 3 issues and pull requests and 1 comments, 1 commit messages'
		);
		expect(result.output).toContain(
			'calibration: claude-address 1, home-path 1, personal-email 1, scanner-bypass 1'
		);
	});

	it.each(Object.entries(PLANTED))(
		'fails on a %s and prints only a redacted form of it',
		(kind, value) => {
			const source = cleanSource({
				items: () => [
					...cleanSource().items(),
					{ kind: 'comment', number: 7, where: 'comment 70', text: `line\nsee ${value}` }
				]
			});
			const result = capture(source);
			expect(result.status).toBe(1);
			expect(result.output).toContain(`#7 comment 70 line 2 [${kind}]`);
			if (kind !== 'claude-address') expect(result.output).not.toContain(value);
		}
	);

	it('refuses a run that read nothing', () => {
		const result = capture(
			cleanSource({ items: () => [], totals: () => ({ issues: 0, pulls: 0, commits: 0 }) })
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain('read no issue');
	});

	it('refuses a run that read fewer items than the repository reports', () => {
		const result = capture(cleanSource({ totals: () => ({ issues: 5, pulls: 1, commits: 1 }) }));
		expect(result.status).toBe(1);
		expect(result.output).toContain('fewer than the 6 the repository reports');
	});

	it('refuses a run that read fewer commit messages than the branch holds', () => {
		const result = capture(cleanSource({ totals: () => ({ issues: 2, pulls: 1, commits: 4 }) }));
		expect(result.status).toBe(1);
		expect(result.output).toContain('read 1 commit messages, fewer than the 4 reported');
	});

	describe('the baseline', () => {
		const leaking = () =>
			cleanSource({
				items: () => [
					...cleanSource().items(),
					{ kind: 'commit', where: 'commit 00000000abcd', text: `x\n\nTrailer: ${CLAUDE_LINK}` }
				]
			});
		const entryFor = () => {
			const [finding] = scanItems([
				{ kind: 'commit', where: 'commit 00000000abcd', text: `x\n\nTrailer: ${CLAUDE_LINK}` }
			]);
			return `${finding.fingerprint} commit 00000000abcd -- a reviewed old trailer`;
		};

		it('admits a finding whose fingerprint it lists, and only that one', () => {
			const admitted = capture2(leaking(), parseBaseline(entryFor()));
			expect(admitted.status).toBe(0);
			expect(admitted.output).toContain('1 findings, 1 of them in the baseline');

			const elsewhere = cleanSource({
				items: () => [
					...leaking().items(),
					{ kind: 'comment', number: 9, where: 'comment 90', text: `see ${CLAUDE_LINK}` }
				]
			});
			const refused = capture2(elsewhere, parseBaseline(entryFor()));
			expect(refused.status).toBe(1);
			expect(refused.output).toContain('#9 comment 90 line 1 [claude-address]');
		});

		it('fails on an entry that no longer matches anything', () => {
			const result = capture2(cleanSource(), parseBaseline(entryFor()));
			expect(result.status).toBe(1);
			expect(result.output).toContain('STALE baseline entry');
		});

		it('refuses a malformed line rather than reading it as admitting nothing', () => {
			expect(() => parseBaseline('not a fingerprint -- reason')).toThrow('is not');
		});

		it('is itself well formed, and every entry has a reason', () => {
			const entries = parseBaseline(
				readFileSync(join(REPO_ROOT, '.private-references-baseline'), 'utf8')
			);
			expect(entries.length).toBeGreaterThan(0);
			for (const entry of entries) expect(entry.reason.length).toBeGreaterThan(20);
		});
	});

	function capture2(source: ScanSource, baseline: ReturnType<typeof parseBaseline>) {
		const lines: string[] = [];
		const status = runScan(source, (line) => lines.push(line), baseline);
		return { status, output: lines.join('\n') };
	}

	it('refuses a run whose fetch failed, rather than reporting clean', () => {
		const result = capture(
			cleanSource({
				items: () => {
					throw new Error('HTTP 502');
				}
			})
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain('HTTP 502');
	});
});

/**
 * The adversarial review of 2026-09-26, one describe per finding, each test written to reproduce
 * the reviewer's case before the fix and seen red first.
 */
describe('review of 2026-09-26', () => {
	const linkFile = () => {
		const path = join(scratch, `link-${Math.random().toString(36).slice(2)}.md`);
		writeFileSync(path, `drawn on ${CLAUDE_LINK}\n`);
		return path;
	};
	const cleanFile = () => {
		const path = join(scratch, `clean-${Math.random().toString(36).slice(2)}.md`);
		writeFileSync(path, 'nothing private\n');
		return path;
	};

	describe('1: a quoted or escaped verb, a variable verb, and text on any command line', () => {
		it.each([
			['g\\h issue comment 5 --body-file'],
			["'g'h issue comment 5 --body-file"],
			['"g"h issue comment 5 --body-file'],
			["gi''t commit -F"]
		])('reads the file behind %s', (prefix) => {
			const result = bash(`${prefix} ${linkFile()}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('[claude-address] in the ');
		});

		it.each([
			['G=gh; $G issue comment 5 --body-file'],
			['$(printf gh) issue comment 5 --body-file']
		])('refuses a command word built from a variable or a substitution: %s', (prefix) => {
			const result = bash(`${prefix} ${cleanFile()}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('command word is built from');
		});

		it('refuses a link on a command line that publishes nothing', () => {
			const result = bash(`echo 'see ${CLAUDE_LINK}' > ${join(scratch, 'notes.txt')}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('[claude-address] in the command text');
		});

		it('admits the calibration idiom, which never spells the address', () => {
			const result = bash(`printf 'claude.a%s/x' i`);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
		});
	});

	describe('2: no wrapper list, the first git, gh, curl or wget word is what is read', () => {
		it.each([
			['nice -n 5 gh issue comment 5 --body-file FILE'],
			['timeout -s KILL 60 gh issue comment 5 --body-file FILE'],
			['flock /tmp/x.lock gh issue comment 5 --body-file FILE'],
			['setsid gh issue comment 5 --body-file FILE'],
			['ionice -c3 gh issue comment 5 --body-file FILE'],
			['script -qc "gh issue comment 5 --body-file FILE" /dev/null'],
			['env -S "gh issue comment 5 --body-file FILE"'],
			['gh -R o/r issue comment 5 --body-file FILE'],
			['gh --repo=o/r issue comment 5 --body-file FILE']
		])('%s', (template) => {
			const result = bash(template.replace('FILE', linkFile()));
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('[claude-address] in the --body-file file');
		});
	});

	describe('3: a quoted << is text, not a heredoc', () => {
		it.each([
			["git commit -m 'fix: use a << b to shift'"],
			['gh issue comment 1 --body "read a << EOF as text"']
		])('%s', (command) => {
			const result = bash(command);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
		});
	});

	describe('4: stdin is accepted only from a redirect in the same segment, never through a pipe', () => {
		it('refuses a piped body even when another segment has a heredoc', () => {
			const command = `cat <<'EOF' > /dev/null\nclean\nEOF\ncat ${linkFile()} | gh issue comment 1 --body-file -`;
			const result = bash(command);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('reads its body from stdin');
		});

		it('refuses stdin that only a heredoc in ANOTHER segment could have supplied', () => {
			const command = `cat <<'EOF' > /dev/null\nclean\nEOF\ngh issue comment 1 --body-file -`;
			const result = bash(command);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('reads its body from stdin');
		});

		it('refuses stdin through a pipe even when the same segment also redirects', () => {
			const result = bash(`cat notes | gh issue comment 1 --body-file - < ${cleanFile()}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('reads its body from stdin');
		});

		it('reads the file a < redirect feeds it', () => {
			const result = bash(`gh issue comment 1 --body-file - < ${linkFile()}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('[claude-address] in the stdin redirect file');
			expect(bash(`gh issue comment 1 --body-file - < ${cleanFile()}`).status).toBe(0);
		});

		it('admits a heredoc in the same segment', () => {
			const result = bash(`gh issue comment 1 --body-file - <<'EOF'\nclean\nEOF`);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
		});
	});

	describe('5: a $( ) in published text is read only as cat of a heredoc or a file', () => {
		it('refuses a heredoc piped through another command', () => {
			const result = bash(`git commit -m "$(cat <<'E' | tr a-z A-Z\nclean\nE\n)"`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('cannot evaluate');
		});

		it('admits the plain heredoc form Claude Code writes', () => {
			const result = bash(`git commit -m "$(cat <<'EOF'\nfix: x\n\nbody, don't (really)\nEOF\n)"`);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
		});
	});

	describe('6: an escaped or encoded reference is decoded before it is matched', () => {
		// Assembled at run time: the decoded copy of a literal would be a finding against this file.
		const host = ['claude', 'ai'].join('.');
		const home = (separator: string) => ['', 'home', 'someone', 'x'].join(separator);
		it.each([
			['JSON-escaped slashes', `{"body":"see https:\\/\\/${host}\\/design\\/p"}`, 'claude-address'],
			['a \\u escape', `{"body":"cwd ${home('\\u002F')}"}`, 'home-path'],
			['percent-encoding', `see ${home('%2F')}`, 'home-path'],
			['a numeric entity', `see ${home('&#47;')}`, 'home-path']
		])('%s in a body file', (_label, content, kind) => {
			const path = join(scratch, `encoded-${kind}-${Math.random().toString(36).slice(2)}.json`);
			writeFileSync(path, content);
			const result = bash(`gh issue comment 1 --body-file ${path}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain(`[${kind}] in the --body-file file`);
		});

		it('finds a reference stored as UTF-16, whose bytes interleave NULs', () => {
			const text = Buffer.from(`see ${CLAUDE_LINK}`, 'utf16le').toString('latin1');
			expect(findPrivateReferences(text).map((f) => f.kind)).toEqual(['claude-address']);
		});

		// Outside JSON, as the tree gate, the git hooks and the daily scan read it: only the matcher's
		// own decoding can find these.
		it.each([
			['a \\u escape', home('\\u002F')],
			['a hexadecimal entity', home('&#x2F;')]
		])('finds %s in plain text', (_label, encoded) => {
			const findings = findPrivateReferences(`line one\ncwd ${encoded}`);
			expect(findings).toEqual([
				{ kind: 'home-path', line: 2, match: ['', 'home', 'someone'].join('/') }
			]);
		});
	});

	describe('7: the matcher is linear, and a stalled scan blocks', () => {
		// Measured before the fix: 29.5 s for 2e5 letters, 114 ms for 1e4 image openers.
		it.each([
			['2e5 letters with no @', 'a'.repeat(2e5)],
			['1e5 image openers', '!['.repeat(1e5)],
			['2e5 characters inside an img tag', `<img ${'a'.repeat(2e5)}`],
			['a 2e5-character dotted domain', `x@${'a.'.repeat(1e5)}`]
		])(
			'scans %s in under a second',
			(_label, text) => {
				const started = performance.now();
				findPrivateReferences(text);
				expect(performance.now() - started).toBeLessThan(1000);
			},
			60_000
		);

		it('exits 2 when the scanning process does not finish in time', () => {
			const result = spawnSync(process.execPath, [HOOK], {
				input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: scratch }),
				env: {
					...process.env,
					BP_PRIVATE_REFS_STALL_FOR_TEST: '1',
					BP_PRIVATE_REFS_TIMEOUT_MS: '500'
				},
				encoding: 'utf8'
			});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('did not finish');
		});
	});

	describe('8: the other ways to publish', () => {
		it.each([
			['gh gist create FILE'],
			['gh gist create --desc x FILE'],
			['gh release upload v1 FILE'],
			['gh release create v1 FILE#label --notes x'],
			['git tag -a v1 -F FILE']
		])('%s', (template) => {
			const result = bash(template.replace('FILE', linkFile()));
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('[claude-address]');
		});

		it.each([['-d@FILE'], ["'-Fbody=<FILE'"]])('curl %s with the value attached', (flag) => {
			const url = 'https://api.github.com/repos/o/r/issues/1/comments';
			const result = bash(`curl -X POST ${url} ${flag.replace('FILE', linkFile())}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('[claude-address]');
		});
	});

	describe('9: abbreviations and environment variables that skip the git hooks', () => {
		it.each([
			['git commit --no-verif -m x', 'no-verify'],
			['git commit --no-ve -m x', 'no-verify'],
			['git merge --no-verif feature', 'no-verify'],
			[
				`export GIT_CONFIG_PARAMETERS="'core.hookspath=/dev/null'" && git commit -m x`,
				'GIT_CONFIG_PARAMETERS'
			],
			['export GIT_CONFIG_COUNT=1 && git commit -m x', 'GIT_CONFIG_COUNT']
		])('%s', (command, reason) => {
			const result = bash(command);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain(reason);
		});
	});

	describe('10: short options read per subcommand', () => {
		it.each([['git commit -uno -m "fix: x"'], ['git merge -n feature'], ['git commit -sS -m x']])(
			'%s is not a skipped hook',
			(command) => {
				const result = bash(command);
				expect(result.stderr).toBe('');
				expect(result.status).toBe(0);
			}
		);
	});

	describe('11: a staged UTF-16 file', () => {
		it('is refused like any other when it carries a reference', () => {
			const repo = makeRepo('utf16', 'absent');
			const bom = Buffer.from([0xff, 0xfe]);
			writeFileSync(
				join(repo.dir, 'u.txt'),
				Buffer.concat([bom, Buffer.from(`line\nsee ${CLAUDE_LINK}\n`, 'utf16le')])
			);
			repo.git(['add', 'u.txt']);
			const result = repo.git(['commit', '-q', '-m', 'docs: a'], SKIP);
			expect(result.status).not.toBe(0);
			expect(result.output).toContain('[claude-address]');
		});
	});
});
