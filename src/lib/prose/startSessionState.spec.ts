import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `/start-session` injects what `state.sh` prints, so a wrong block reads as the state itself.
 * Driven through the real script in a throwaway repository with no remote: the network sections
 * print their « unavailable » lines, the sections under test do not touch the network.
 *
 * BREAK-CHECKED (2026-10-27), each clause alone, restored byte-identical (sha256): the heading
 * match put back to a plain mention reddens « heading, not mention » (the newer note wins and the
 * block is empty, so « /tmp » reddens with it); the prune removed reddens « prune » alone (the
 * `fatal` line returns); the /tmp warning disabled reddens « /tmp » alone.
 */

const script = fileURLToPath(
	new URL('../../../.claude/skills/start-session/scripts/state.sh', import.meta.url)
);
let repo: string;
let gone: string;

function git(...args: string[]) {
	const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function runState() {
	const r = spawnSync('bash', [script], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
	return r.stdout + r.stderr;
}

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), 'state-sh-'));
	git('init', '-q', '-b', 'main');
	git(
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@example.test',
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'init'
	);
	const notes = join(repo, 'docs/superpowers');
	mkdirSync(notes, { recursive: true });
	const plan = join(notes, 'plan.md');
	writeFileSync(
		plan,
		'# Plan\n\n#### RESUME HERE (day 2)\n\nNext: piece B, see /tmp/x/notes.md\n\n#### Older\n\nold\n'
	);
	utimesSync(plan, new Date('2026-01-01'), new Date('2026-01-01'));
	// Newer, and only mentions the phrase: the old `grep -l` picked this one.
	writeFileSync(join(notes, 'how-to.md'), 'Write a RESUME HERE block at the end of a session.\n');
	gone = mkdtempSync(join(tmpdir(), 'state-sh-wt-'));
	rmSync(gone, { recursive: true });
	git('worktree', 'add', '-q', '--detach', gone);
	rmSync(gone, { recursive: true });
});

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe('state.sh', () => {
	it('shows the newest file with a RESUME HERE heading, not the newest that mentions it', () => {
		const out = runState();
		expect(out).toContain('file: docs/superpowers/plan.md');
		expect(out).toContain('newest of 1 files with the heading, 2 read)');
		expect(out).toMatch(/#### RESUME HERE \(day 2\)\n\nNext: piece B, see \/tmp\/x\/notes\.md\n/);
		expect(out).not.toContain('old\n');
	});

	it('flags a /tmp path in the block', () => {
		expect(runState()).toContain('WARNING: 1 line(s) of this block name a /tmp path');
	});

	it('prunes a worktree whose directory is gone instead of failing on it', () => {
		// The first run in this file already pruned it; register a fresh one.
		const again = mkdtempSync(join(tmpdir(), 'state-sh-wt-'));
		rmSync(again, { recursive: true });
		git('worktree', 'add', '-q', '--detach', again);
		rmSync(again, { recursive: true });
		const out = runState();
		expect(out).toContain('pruned 1 registration(s)');
		expect(out).not.toContain('fatal');
		expect(out).toMatch(/read 1 worktrees:/);
	});
});
