import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogWriter, newChain, sha256Hex } from '../core';
import type { LogEvent } from '../events';
import { ATTRIBUTE as A, EVENT as E, FIELD } from '../names';
import { vkeyOf } from './note';
import { verifyLog, type VerifyReport } from './verify';

/**
 * The ruling of #875, « Done when », as tests through the real writer and the real verifier.
 *
 * An edit is followed by `rechain`, which recomputes `seq` and `prev` the way anyone holding the
 * file can: the keyless chain of #871 already shows a naive edit, so a test that left the chain
 * broken would be green on the chain and say nothing about the seal. Each break test names the
 * one `kind` it expects, never only that something broke (AGENTS.md, « A test on a refusal asserts
 * the REASON »).
 */

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});
const sealDir = () => {
	const dir = mkdtempSync(join(tmpdir(), 'bp-seal-'));
	dirs.push(dir);
	return dir;
};

const event = (n: number): LogEvent => ({
	event: E.backfillLockWait,
	attributes: { [A.backfillName]: `step-${n}`, [A.backfillWaitedSeconds]: n }
});

/** One process start: `lines` events, a checkpoint every `every` lines if given, then a clean stop. */
function runStart(dir: string, lines: number, every?: number): string[] {
	const out: string[] = [];
	const scheduled: (() => void)[] = [];
	const write = createLogWriter({
		level: 'info',
		securityLog: 'on',
		sink: (line) => out.push(line),
		chain: newChain(),
		seal: 'on',
		schedule: (run) => scheduled.push(run)
	});
	write.startSeal({ dir, intervalSeconds: 900 });
	for (let i = 1; i <= lines; i++) {
		write(event(i));
		if (every && i % every === 0) write.checkpoint();
	}
	write.flush();
	return out;
}

const vkeyIn = (dir: string) => readFileSync(join(dir, 'verification.vkey'), 'utf8').trim();
const text = (lines: string[]) => lines.join('');
const eventOf = (line: string) => (JSON.parse(line) as Record<string, unknown>)[FIELD.eventName];

/** Recomputes seq and prev per start, as an editor without the key can. */
function rechain(lines: string[]): string[] {
	const state = new Map<unknown, { seq: number; prev: string }>();
	return lines.map((line) => {
		const record = JSON.parse(line) as Record<string, unknown>;
		const boot = record[A.logBootId];
		const s = state.get(boot) ?? { seq: 0, prev: '0'.repeat(64) };
		record[A.logSeq] = (s.seq += 1);
		record[A.logPrev] = s.prev;
		const rewritten = JSON.stringify(record);
		s.prev = sha256Hex(rewritten);
		state.set(boot, s);
		return `${rewritten}\n`;
	});
}

const kinds = (report: VerifyReport) => report.breaks.map((b) => b.kind);

describe('BP_LOG_SEAL off', () => {
	it('writes no seal line and no file', () => {
		const dir = sealDir();
		const out: string[] = [];
		const write = createLogWriter({
			level: 'info',
			securityLog: 'on',
			sink: (line) => out.push(line),
			chain: newChain()
		});
		write(event(1));
		write.flush();
		expect(out.map(eventOf)).toEqual([E.backfillLockWait]);
		expect(existsSync(join(dir, 'key.pem'))).toBe(false);
	});
});

describe('BP_LOG_SEAL on', () => {
	it('writes a log that verifies, every line covered after a clean stop', () => {
		const dir = sealDir();
		const lines = runStart(dir, 10, 4);
		const report = verifyLog(text(lines), vkeyIn(dir));
		expect(report.breaks).toEqual([]);
		expect(report.linesRead).toBe(lines.length);
		// 10 events, the seal_started line, two interval checkpoints and the one on stop.
		expect(lines.length).toBe(14);
		expect(report.checkpointsVerified).toBe(3);
		expect(report.unsealedLines).toBe(0);
	});

	it('keeps the key 0600 in its directory and writes the matching vkey', () => {
		const dir = sealDir();
		runStart(dir, 1);
		expect(readFileSync(join(dir, 'key.pem'), 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
		expect(statMode(join(dir, 'key.pem'))).toBe(0o600);
		expect(vkeyIn(dir)).toMatch(/^budgetpilot\/log\+[0-9a-f]{8}\+/);
	});

	it('reuses the key on the next start', () => {
		const dir = sealDir();
		runStart(dir, 1);
		const first = vkeyIn(dir);
		runStart(dir, 1);
		expect(vkeyIn(dir)).toBe(first);
	});
});

describe('a copy edited by someone without the key', () => {
	it('an edited line, chain recomputed: root', () => {
		const dir = sealDir();
		const lines = runStart(dir, 10, 4);
		lines[2] = lines[2].replace('step-2', 'step-X');
		expect(kinds(verifyLog(text(rechain(lines)), vkeyIn(dir)))).toEqual(['root']);
	});

	it('a deleted line, chain recomputed: root', () => {
		const dir = sealDir();
		const lines = runStart(dir, 10, 4);
		lines.splice(2, 1);
		expect(kinds(verifyLog(text(rechain(lines)), vkeyIn(dir)))).toContain('root');
	});

	it('two lines swapped, chain recomputed: root', () => {
		const dir = sealDir();
		const lines = runStart(dir, 10, 4);
		[lines[2], lines[3]] = [lines[3], lines[2]];
		expect(kinds(verifyLog(text(rechain(lines)), vkeyIn(dir)))).toContain('root');
	});

	it('the chain alone broken (no rechain): chain', () => {
		const dir = sealDir();
		const lines = runStart(dir, 10, 4);
		lines.splice(2, 1);
		expect(kinds(verifyLog(text(lines), vkeyIn(dir)))).toContain('chain');
	});

	it('a start truncated after a checkpoint: missing-checkpoint', () => {
		const dir = sealDir();
		const a = runStart(dir, 10, 4);
		const b = runStart(dir, 2);
		const firstCheckpoint = a.findIndex((line) => eventOf(line) === E.logCheckpoint);
		const truncated = a.slice(0, firstCheckpoint + 1);
		expect(kinds(verifyLog(text([...truncated, ...b]), vkeyIn(dir)))).toEqual(['missing-checkpoint']);
	});

	it('a whole start removed from the middle: missing-start', () => {
		const dir = sealDir();
		const a = runStart(dir, 2);
		runStart(dir, 2);
		const c = runStart(dir, 2);
		expect(kinds(verifyLog(text([...a, ...c]), vkeyIn(dir)))).toEqual(['missing-start']);
	});

	// Clean-tree check: a copy that begins after rotation names a start it does not hold. A guard
	// that fired here would fire on every rotated log and be deleted.
	it('the copy beginning at a later start is a notice, not a break', () => {
		const dir = sealDir();
		runStart(dir, 2);
		const b = runStart(dir, 2);
		const report = verifyLog(text(b), vkeyIn(dir));
		expect(report.breaks).toEqual([]);
		expect(report.notices.map((n) => n.kind)).toEqual(['copy-begins-later']);
	});

	it('verified with another key: signature', () => {
		const dir = sealDir();
		const lines = runStart(dir, 4);
		const other = vkeyOf('budgetpilot/log', generateKeyPairSync('ml-dsa-44').publicKey);
		const report = verifyLog(text(lines), other);
		expect(new Set(kinds(report))).toEqual(new Set(['signature']));
		expect(report.checkpointsVerified).toBe(0);
	});
});

describe('the key cannot be read', () => {
	it.skipIf(process.getuid?.() === 0)('writes one WARN line and every line, unsealed', () => {
		const dir = sealDir();
		runStart(dir, 1);
		chmodSync(join(dir, 'key.pem'), 0o000);
		const lines = runStart(dir, 3);
		const names = lines.map(eventOf);
		expect(names.filter((n) => n === E.logSealUnavailable)).toHaveLength(1);
		expect(JSON.parse(lines[names.indexOf(E.logSealUnavailable)])[FIELD.severityText]).toBe('WARN');
		expect(names.filter((n) => n === E.backfillLockWait)).toHaveLength(3);
		expect(names).not.toContain(E.logCheckpoint);
	});
});

describe('the verifier refuses to report success over nothing', () => {
	it('a log with no checkpoint verifies zero and says so', () => {
		const dir = sealDir();
		runStart(dir, 1);
		const out: string[] = [];
		const write = createLogWriter({ level: 'info', securityLog: 'on', sink: (l) => out.push(l), chain: newChain() });
		write(event(1));
		const report = verifyLog(text(out), vkeyIn(dir));
		expect(report.checkpointsVerified).toBe(0);
		expect(report.unsealedLines).toBe(1);
	});
});

const statMode = (path: string) => statSync(path).mode & 0o777;
