import { createHash, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogWriter, newChain, sha256Hex } from '../core';
import type { LogEvent } from '../events';
import { ATTRIBUTE as A, EVENT as E, FIELD } from '../names';
import { MAX_LINE_BYTES } from '../serialize';
import { FLOOD_ALLOWANCE } from '../flood';
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

/** A process stand-in: the stop checkpoint is reached through the events the sealer listens to. */
const fakeProcess = () => {
	const proc = new EventEmitter();
	return { proc, stop: () => (proc.emit('sveltekit:shutdown'), proc.emit('exit')) };
};

/**
 * One process start: `lines` events, a checkpoint every `every` lines if given (through the
 * interval timer the sealer schedules), then a clean stop through the process events.
 */
function runStart(
	dir: string,
	lines: number,
	every?: number,
	host = 'host-a',
	stopped = true
): string[] {
	const out: string[] = [];
	const scheduled: (() => void)[] = [];
	const { proc, stop } = fakeProcess();
	const write = createLogWriter({
		level: 'info',
		securityLog: 'on',
		sink: (line) => out.push(line),
		chain: newChain(),
		seal: 'on',
		schedule: (run) => scheduled.push(run)
	});
	write.startSeal({ dir, intervalSeconds: 900, host, proc });
	for (let i = 1; i <= lines; i++) {
		write(event(i));
		if (every && i % every === 0) scheduled.splice(0).forEach((run) => run());
	}
	if (stopped) stop();
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
		record[A.logSeq] = s.seq += 1;
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
		expect(report.status).toBe('verified');
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
		// Rewriting the chain changes every later line, so every later segment's root differs too.
		expect(new Set(kinds(verifyLog(text(rechain(lines)), vkeyIn(dir))))).toEqual(new Set(['root']));
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
		expect(kinds(verifyLog(text([...truncated, ...b]), vkeyIn(dir)))).toEqual([
			'missing-checkpoint'
		]);
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

	// Rotation (json-file keeps 5 x 10 MB) cuts the copy inside a segment of the running start.
	it('a copy beginning inside a segment verifies the segments after it', () => {
		const dir = sealDir();
		const lines = runStart(dir, 10, 4);
		const report = verifyLog(text(lines.slice(3)), vkeyIn(dir));
		expect(report.breaks).toEqual([]);
		expect(report.notices.map((n) => n.kind)).toEqual(['copy-begins-mid-segment']);
		expect(report.checkpointsVerified).toBe(2);
	});

	// The ruling of design note A9: lines nothing signed covers are UNVERIFIED, never a break. Pass 1
	// showed an unsealed start can be forged, pass 2 that a clean toggle or an unreadable key looks
	// the same; the status separates « contradicted » from « not covered », and exit 0 is neither.
	it('an unsealed start between two sealed ones: unverified, not a break', () => {
		const dir = sealDir();
		const a = runStart(dir, 2);
		const forged: string[] = [];
		const plain = createLogWriter({
			level: 'info',
			securityLog: 'on',
			sink: (l) => forged.push(l),
			chain: newChain()
		});
		plain(event(99));
		const b = runStart(dir, 2);
		const report = verifyLog(text([...a, ...forged, ...b]), vkeyIn(dir));
		expect(report.breaks).toEqual([]);
		expect(report.unverified.map((u) => u.kind)).toEqual(['unsealed-start']);
		expect(report.status).toBe('unverified');
	});

	it('a start killed before its stop checkpoint: unverified, not a break', () => {
		const dir = sealDir();
		const a = runStart(dir, 6, 4, 'host-a', false);
		const b = runStart(dir, 2);
		const report = verifyLog(text([...a, ...b]), vkeyIn(dir));
		expect(report.breaks).toEqual([]);
		expect(report.unverified).toEqual([{ kind: 'ended-without-checkpoint', lines: 2 }]);
		expect(report.status).toBe('unverified');
	});

	// Security review of 717e024: a start killed before its FIRST checkpoint took the « copy begins
	// mid-segment » branch, so its lines counted nowhere and the copy read verified; and the next
	// start, whose link could not advance, read as a removed start. Separates « a sealed start with
	// no checkpoint is a tail » from « it is a rotation notice ».
	it('a start killed before its first checkpoint: unverified, not hidden, not a break', () => {
		const dir = sealDir();
		const a = runStart(dir, 2, undefined, 'host-a', false);
		const b = runStart(dir, 2);
		const report = verifyLog(text([...a, ...b]), vkeyIn(dir));
		expect(report.breaks).toEqual([]);
		expect(report.unverified).toEqual([{ kind: 'ended-without-checkpoint', lines: 3 }]);
		expect(report.status).toBe('unverified');
	});

	it('the same after an earlier sealed start: the link names the checkpoint before it', () => {
		const dir = sealDir();
		const a0 = runStart(dir, 2);
		const a = runStart(dir, 2, undefined, 'host-a', false);
		const b = runStart(dir, 2);
		const report = verifyLog(text([...a0, ...a, ...b]), vkeyIn(dir));
		expect(report.breaks).toEqual([]);
		expect(report.unverified).toEqual([{ kind: 'ended-without-checkpoint', lines: 3 }]);
	});

	// Final pass A, F1: a forged start under an unseen host, no checkpoint, in the middle of a copy.
	it('a forged start under a host never seen: not verified', () => {
		const dir = sealDir();
		const a = runStart(dir, 2);
		const forged = runStart(sealDir(), 3, undefined, 'host-forged', false);
		const b = runStart(dir, 2);
		expect(verifyLog(text([...a, ...forged, ...b]), vkeyIn(dir)).status).not.toBe('verified');
	});

	// Design note A13: a tail followed by a verified checkpoint of ANY start is not « the newest
	// lines ». Separates the exemption by position from the exemption by host tag.
	it('a killed start on one host followed by sealed lines of another: unverified', () => {
		const dir = sealDir();
		const x = runStart(dir, 6, 4, 'host-x', false);
		const y = runStart(dir, 6, 4, 'host-y');
		const report = verifyLog(text([...x, ...y]), vkeyIn(dir));
		expect(report.breaks).toEqual([]);
		expect(report.unverified).toEqual([{ kind: 'ended-without-checkpoint', lines: 2 }]);
	});

	// Final passes A (F2) and B (node 1): every recreated container is a new host, so per-host links
	// alone let a start between two recreations vanish.
	it('a start removed across container recreations: broken', () => {
		const dir = sealDir();
		const s1 = runStart(dir, 2, undefined, 'container-1');
		runStart(dir, 2, undefined, 'container-2');
		const s3 = runStart(dir, 2, undefined, 'container-3');
		expect(verifyLog(text([...s1, ...s3]), vkeyIn(dir)).status).toBe('broken');
	});

	it('the old container cut back before a recreation: broken', () => {
		const dir = sealDir();
		const old1 = runStart(dir, 2, undefined, 'container-1');
		runStart(dir, 2, undefined, 'container-1');
		const fresh = runStart(dir, 2, undefined, 'container-2');
		expect(verifyLog(text([...old1, ...fresh]), vkeyIn(dir)).status).toBe('broken');
	});

	// Final passes A (F3) and B (node 5): rotation can cut the heads of two hosts' starts.
	it('a copy cut by rotation through two hosts: not broken', () => {
		const dir = sealDir();
		const x = runStart(dir, 10, 4, 'host-x');
		const y = runStart(dir, 10, 4, 'host-y');
		expect(verifyLog(text([...x.slice(3), ...y.slice(3)]), vkeyIn(dir)).breaks).toEqual([]);
	});

	// Final pass A, F4: the copy begins inside a killed start's tail, after its last checkpoint.
	it('a copy beginning inside a killed start after its last checkpoint: not broken', () => {
		const dir = sealDir();
		const a = runStart(dir, 6, 4, 'host-a', false);
		const b = runStart(dir, 2);
		expect(verifyLog(text([...a.slice(-2), ...b]), vkeyIn(dir)).breaks).toEqual([]);
	});

	// Final pass B, node 2: a line claiming to be the writer's without the chain fields.
	it('a line with the writer envelope and no chain fields: malformed', () => {
		const dir = sealDir();
		const lines = runStart(dir, 4);
		const forged = `${JSON.stringify({ [FIELD.eventName]: E.backfillLockWait, [A.serviceName]: 'budgetpilot' })}\n`;
		lines.splice(3, 0, forged);
		expect(kinds(verifyLog(text(lines), vkeyIn(dir)))).toContain('malformed');
	});

	// Final pass A residual: a hash of the host name alone can be reversed by trying names.
	it('writes a host tag no one can compute from the host name without the key', () => {
		const dir = sealDir();
		const tagOf = (lines: string[]) =>
			JSON.parse(lines.find((l) => eventOf(l) === E.logSealStarted)!)[A.logSealHost] as string;
		const first = tagOf(runStart(dir, 1, undefined, 'host-a'));
		expect(first).toMatch(/^[0-9a-f]{12}$/);
		expect(first).not.toBe(createHash('sha256').update('host-a').digest('hex').slice(0, 12));
		expect(tagOf(runStart(dir, 1, undefined, 'host-a'))).toBe(first);
		expect(tagOf(runStart(sealDir(), 1, undefined, 'host-a'))).not.toBe(first);
	});

	it('two containers on one volume: each copy and the merged copy verify', () => {
		const dir = sealDir();
		const x1 = runStart(dir, 2, undefined, 'host-x');
		const y1 = runStart(dir, 2, undefined, 'host-y');
		const x2 = runStart(dir, 2, undefined, 'host-x');
		const y2 = runStart(dir, 2, undefined, 'host-y');
		expect(verifyLog(text([...x1, ...x2]), vkeyIn(dir)).status).toBe('verified');
		expect(verifyLog(text([...y1, ...y2]), vkeyIn(dir)).status).toBe('verified');
		expect(verifyLog(text([...x1, ...y1, ...x2, ...y2]), vkeyIn(dir)).status).toBe('verified');
	});

	it('a container recreated under a new host name: verified', () => {
		const dir = sealDir();
		const old = runStart(dir, 2, undefined, 'container-1');
		const recreated = runStart(dir, 2, undefined, 'container-2');
		expect(verifyLog(text([...old, ...recreated]), vkeyIn(dir)).status).toBe('verified');
	});

	it('the head of a start that is not the first in the copy removed: broken', () => {
		const dir = sealDir();
		const a = runStart(dir, 2);
		const b = runStart(dir, 10, 4);
		const firstCheckpoint = b.findIndex((line) => eventOf(line) === E.logCheckpoint);
		const report = verifyLog(text(rechain([...a, ...b.slice(firstCheckpoint + 1)])), vkeyIn(dir));
		expect(report.status).toBe('broken');
	});

	it('starts out of order: start-order', () => {
		const dir = sealDir();
		const a = runStart(dir, 2);
		const b = runStart(dir, 2);
		const c = runStart(dir, 2);
		expect(kinds(verifyLog(text([...a, ...c, ...b]), vkeyIn(dir)))).toContain('start-order');
	});

	// Break B8 stayed green without this: the start that links a LATER start is its host's first in
	// the copy, so the « previous start of this host » branch never sees it.
	it('a copy whose first start links a start placed after it: start-order', () => {
		const dir = sealDir();
		runStart(dir, 2);
		const b = runStart(dir, 2);
		const c = runStart(dir, 2);
		expect(kinds(verifyLog(text([...c, ...b]), vkeyIn(dir)))).toContain('start-order');
	});

	// Break B9 stayed green without this: every other chain test also moves `seq`.
	it('a line edited in place, chain not recomputed: chain', () => {
		const dir = sealDir();
		const lines = runStart(dir, 4);
		lines[2] = lines[2].replace('step-2', 'step-X');
		expect(kinds(verifyLog(text(lines), vkeyIn(dir)))).toContain('chain');
	});

	it('a writer line with its boot_id removed: malformed', () => {
		const dir = sealDir();
		const lines = runStart(dir, 4);
		const record = JSON.parse(lines[2]) as Record<string, unknown>;
		delete record[A.logBootId];
		lines[2] = `${JSON.stringify(record)}\n`;
		expect(kinds(verifyLog(text(lines), vkeyIn(dir)))).toContain('malformed');
	});

	it('two starts linking one checkpoint, as after a restored backup: unverified fork', () => {
		const dir = sealDir();
		const a = runStart(dir, 2);
		const saved = readdirSync(dir)
			.filter((name) => name.startsWith('last-checkpoint.'))
			.map((name) => [name, readFileSync(join(dir, name))] as const);
		const b = runStart(dir, 2);
		for (const [name, bytes] of saved) writeFileSync(join(dir, name), bytes);
		const c = runStart(dir, 2);
		const report = verifyLog(text([...a, ...b, ...c]), vkeyIn(dir));
		expect(report.breaks).toEqual([]);
		expect(report.unverified.map((u) => u.kind)).toEqual(['fork']);
	});

	// Pass 2, F1: the sealer's stop listener is registered before the server's flood flush, so a
	// summary written at stop must still be covered by a checkpoint after it.
	it('flood summaries written at stop are covered', () => {
		const dir = sealDir();
		const out: string[] = [];
		const { proc, stop } = fakeProcess();
		const write = createLogWriter({
			level: 'info',
			securityLog: 'on',
			sink: (line) => out.push(line),
			chain: newChain(),
			seal: 'on',
			schedule: () => {}
		});
		write.startSeal({ dir, intervalSeconds: 900, host: 'h', proc });
		// The server's flushOnStop, registered after the sealer's own listeners, as in the app.
		proc.on('sveltekit:shutdown', write.flush);
		proc.on('exit', write.flush);
		for (let i = 0; i < FLOOD_ALLOWANCE + 3; i++) {
			write({
				event: E.consoleOutput,
				attributes: { [A.consoleMethod]: 'log', [A.consoleText]: 'x' }
			});
		}
		stop();
		const b = runStart(dir, 1, undefined, 'h');
		expect(out.map(eventOf)).toContain(E.logSuppressed);
		expect(verifyLog(text([...out, ...b]), vkeyIn(dir)).status).toBe('verified');
	});

	it('a key replaced between two starts verifies with both vkeys', () => {
		const dir = sealDir();
		const a = runStart(dir, 2);
		const first = vkeyIn(dir);
		rmSync(join(dir, 'key.pem'));
		const b = runStart(dir, 2);
		const second = vkeyIn(dir);
		expect(second).not.toBe(first);
		expect(verifyLog(text([...a, ...b]), [first, second]).breaks).toEqual([]);
		expect(kinds(verifyLog(text([...a, ...b]), second))).toContain('signature');
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

describe('when a checkpoint is written', () => {
	function started() {
		const dir = sealDir();
		const out: string[] = [];
		const scheduled: (() => void)[] = [];
		const { proc, stop } = fakeProcess();
		const write = createLogWriter({
			level: 'warn',
			securityLog: 'off',
			sink: (line) => out.push(line),
			chain: newChain(),
			seal: 'on',
			schedule: (run) => scheduled.push(run)
		});
		write.startSeal({ dir, intervalSeconds: 900, host: 'h', proc });
		const tick = () => scheduled.splice(0).forEach((run) => run());
		const count = () => out.map(eventOf).filter((n) => n === E.logCheckpoint).length;
		return { dir, out, write, tick, stop, count };
	}

	// The level is `warn` and security logging is off in `started()`: neither may drop a seal line.
	it('at a tick after lines were written, whatever BP_LOG_LEVEL and BP_SECURITY_LOG say', () => {
		const s = started();
		expect(s.out.map(eventOf)).toEqual([E.logSealStarted]);
		s.tick();
		expect(s.count()).toBe(1);
	});

	it('not at a tick after nothing but the last checkpoint was written', () => {
		const s = started();
		s.tick();
		s.tick();
		expect(s.count()).toBe(1);
	});

	it('once on stop, though both stop events arrive', () => {
		const s = started();
		s.stop();
		expect(s.count()).toBe(1);
		expect(verifyLog(text(s.out), vkeyIn(s.dir)).unsealedLines).toBe(0);
	});

	it('within MAX_LINE_BYTES, with the whole note', () => {
		const s = started();
		s.stop();
		const line = s.out.find((l) => eventOf(l) === E.logCheckpoint)!;
		expect(Buffer.byteLength(line)).toBeLessThan(MAX_LINE_BYTES);
		expect(verifyLog(text(s.out), vkeyIn(s.dir)).checkpointsVerified).toBe(1);
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
		const write = createLogWriter({
			level: 'info',
			securityLog: 'on',
			sink: (l) => out.push(l),
			chain: newChain()
		});
		write(event(1));
		const report = verifyLog(text(out), vkeyIn(dir));
		expect(report.checkpointsVerified).toBe(0);
		expect(report.unsealedLines).toBe(1);
		expect(report.status).toBe('nothing');
	});
});

const statMode = (path: string) => statSync(path).mode & 0o777;
