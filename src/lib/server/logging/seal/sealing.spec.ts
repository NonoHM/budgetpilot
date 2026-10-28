import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogWriter, newChain, type ChainState } from '../core';
import { ATTRIBUTE as A, EVENT as E, FIELD } from '../names';
import { MAX_CHECKPOINT_NOTE_LENGTH, MAX_LINE_BYTES } from '../serialize';
import { signCheckpoint } from './note';
import { verifyLog } from './verify';

/**
 * What `seal.spec.ts` (the ruling of #875) leaves out: the interval the timer is armed with, the off
 * path, the reasons sealing is unavailable, and the cap the checkpoint note is written under.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sealDir = () => {
	const dir = mkdtempSync(join(tmpdir(), 'bp-sealing-'));
	dirs.push(dir);
	return dir;
};

const eventOf = (line: string) => (JSON.parse(line) as Record<string, unknown>)[FIELD.eventName];
const lockWait = {
	event: E.backfillLockWait,
	attributes: { [A.backfillName]: 'step', [A.backfillWaitedSeconds]: 1 }
} as const;

function writer(seal: 'on' | 'off' | undefined, chain: ChainState = newChain()) {
	const out: string[] = [];
	const scheduled: { run: () => void; ms: number }[] = [];
	const write = createLogWriter({
		level: 'info',
		securityLog: 'on',
		sink: (line) => out.push(line),
		chain,
		...(seal === undefined ? {} : { seal }),
		schedule: (run, ms) => scheduled.push({ run, ms })
	});
	return { out, scheduled, write, chain };
}

describe('the interval', () => {
	// Separates a timer armed in seconds from one armed in the milliseconds setTimeout reads: 900
	// would fire 1000 times too often.
	it('arms the timer with the interval in milliseconds, again after each tick', () => {
		const w = writer('on');
		w.write.startSeal({
			dir: sealDir(),
			intervalSeconds: 120,
			host: 'h',
			proc: new EventEmitter()
		});
		expect(w.scheduled.map((s) => s.ms)).toEqual([120_000]);
		w.scheduled.shift()!.run();
		expect(w.scheduled.map((s) => s.ms)).toEqual([120_000]);
	});

	it('writes one checkpoint at a tick after lines, none at a tick after none', () => {
		const w = writer('on');
		w.write.startSeal({
			dir: sealDir(),
			intervalSeconds: 900,
			host: 'h',
			proc: new EventEmitter()
		});
		const tick = () => w.scheduled.splice(0).forEach((s) => s.run());
		const checkpoints = () => w.out.map(eventOf).filter((n) => n === E.logCheckpoint).length;
		w.write(lockWait);
		tick();
		expect(checkpoints()).toBe(1);
		tick();
		expect(checkpoints()).toBe(1);
		w.write(lockWait);
		tick();
		expect(checkpoints()).toBe(2);
	});
});

describe('BP_LOG_SEAL off', () => {
	// Through what the writer exposes: the chain it was given never gains a seal, startSeal writes
	// no line and no file, and flush writes no checkpoint. Separates « off » from « on and idle ».
	for (const seal of ['off', undefined] as const) {
		it(`starts nothing, hashes nothing beyond the chain, and writes no file (seal: ${seal})`, () => {
			const dir = sealDir();
			const w = writer(seal);
			w.write.startSeal({ dir, intervalSeconds: 900, host: 'h', proc: new EventEmitter() });
			w.write(lockWait);
			w.write.flush();
			w.write.checkpoint();
			expect({
				events: w.out.map(eventOf),
				seal: w.chain.seal,
				files: readdirSync(dir),
				timers: w.scheduled.length
			}).toEqual({ events: [E.backfillLockWait], seal: undefined, files: [], timers: 0 });
		});
	}

	it('is what the chain is with sealing on before startSeal: no leaf is kept', () => {
		const w = writer('on');
		w.write(lockWait);
		expect(w.chain.seal).toBeUndefined();
	});
});

describe('sealing unavailable', () => {
	const unavailable = (lines: string[]) =>
		lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((record) => record[FIELD.eventName] === E.logSealUnavailable)
			.map((record) => record[A.logSealReason]);

	it('names dir_unset when BP_LOG_SEAL_DIR is empty, and still writes every line', () => {
		const w = writer('on');
		w.write.startSeal({
			dir: undefined,
			intervalSeconds: 900,
			host: 'h',
			proc: new EventEmitter()
		});
		w.write(lockWait);
		expect([unavailable(w.out), w.out.map(eventOf).at(-1), w.chain.seal]).toEqual([
			['dir_unset'],
			E.backfillLockWait,
			null
		]);
	});

	it('names key_invalid when key.pem is not an ML-DSA-44 key', () => {
		const dir = sealDir();
		const ed25519 = generateKeyPairSync('ed25519').privateKey.export({
			type: 'pkcs8',
			format: 'pem'
		});
		writeFileSync(join(dir, 'key.pem'), ed25519, { mode: 0o600 });
		const w = writer('on');
		w.write.startSeal({ dir, intervalSeconds: 900, host: 'h', proc: new EventEmitter() });
		expect(unavailable(w.out)).toEqual(['key_invalid']);
	});

	it('tries once per chain: a second startSeal writes no second WARN', () => {
		const chain = newChain();
		const first = writer('on', chain);
		first.write.startSeal({
			dir: undefined,
			intervalSeconds: 900,
			host: 'h',
			proc: new EventEmitter()
		});
		const second = writer('on', chain);
		second.write.startSeal({
			dir: sealDir(),
			intervalSeconds: 900,
			host: 'h',
			proc: new EventEmitter()
		});
		expect([unavailable(first.out), second.out]).toEqual([['dir_unset'], []]);
	});
});

describe('two writers on one chain, as boot.mjs and the server', () => {
	it('feed one seal: the second startSeal does nothing, the second writer seals on flush', () => {
		const chain = newChain();
		const out: string[] = [];
		const options = {
			level: 'info',
			securityLog: 'on',
			sink: (l: string) => out.push(l),
			chain,
			seal: 'on',
			schedule: () => {}
		} as const;
		const boot = createLogWriter(options);
		boot.startSeal({ dir: sealDir(), intervalSeconds: 900, host: 'h', proc: new EventEmitter() });
		const server = createLogWriter(options);
		server.startSeal({ dir: sealDir(), intervalSeconds: 900, host: 'h', proc: new EventEmitter() });
		server(lockWait);
		server.flush();
		expect(out.map(eventOf)).toEqual([E.logSealStarted, E.backfillLockWait, E.logCheckpoint]);
	});
});

describe('the checkpoint note', () => {
	// The cap's premise: the longest note the format allows (an origin of 255 bytes, the largest
	// size) fits under it, so the cap never cuts a note; and a line carrying it, with the envelope a
	// real checkpoint line measures, stays under MAX_LINE_BYTES.
	it('fits its own cap at the longest origin and size, and its line fits MAX_LINE_BYTES', () => {
		const w = writer('on');
		w.write.startSeal({
			dir: sealDir(),
			intervalSeconds: 900,
			host: 'h',
			proc: new EventEmitter()
		});
		w.write.checkpoint();
		const line = w.out.find((l) => eventOf(l) === E.logCheckpoint)!.trimEnd();
		const written = (JSON.parse(line) as Record<string, string>)[A.logCheckpointNote];
		const envelope = Buffer.byteLength(line) - Buffer.byteLength(JSON.stringify(written));
		const longest = signCheckpoint(
			{
				origin: 'o'.repeat(255),
				size: Number.MAX_SAFE_INTEGER,
				root: Buffer.alloc(32),
				timestamp: 2 ** 40
			},
			{ name: 'budgetpilot/log', privateKey: generateKeyPairSync('ml-dsa-44').privateKey }
		);
		expect([
			longest.length <= MAX_CHECKPOINT_NOTE_LENGTH,
			envelope + Buffer.byteLength(JSON.stringify(longest)) < MAX_LINE_BYTES
		]).toEqual([true, true]);
	});

	it('is written whole on the line, not cut at the 256 code points other values get', () => {
		const w = writer('on');
		w.write.startSeal({
			dir: sealDir(),
			intervalSeconds: 900,
			host: 'h',
			proc: new EventEmitter()
		});
		w.write.checkpoint();
		const record = JSON.parse(w.out.find((l) => eventOf(l) === E.logCheckpoint)!) as Record<
			string,
			string
		>;
		const note = record[A.logCheckpointNote];
		expect([note.length > 3000, note.endsWith('\n'), note.split('\n').length]).toEqual([
			true,
			true,
			6
		]);
	});
});

describe('the newest lines of a running start', () => {
	// Separates « the newest tail is expected in a live log » (a notice in the per-host figures) from
	// « a start ended without its stop checkpoint » (unverified): the same tail, read as the newest
	// start of its host or as one a later start follows.
	it('are counted for their host and leave the log verified', () => {
		const dir = sealDir();
		const w = writer('on');
		w.write.startSeal({ dir, intervalSeconds: 900, host: 'h', proc: new EventEmitter() });
		w.write(lockWait);
		w.scheduled.splice(0).forEach((s) => s.run());
		w.write(lockWait);
		w.write(lockWait);
		const vkey = readFileSync(join(dir, 'verification.vkey'), 'utf8').trim();
		const report = verifyLog(w.out.join(''), vkey);
		expect({
			status: report.status,
			unverified: report.unverified,
			tails: report.hosts.map((h) => h.newestTailLines),
			unsealed: report.unsealedLines
		}).toEqual({ status: 'verified', unverified: [], tails: [2], unsealed: 2 });
	});
});
