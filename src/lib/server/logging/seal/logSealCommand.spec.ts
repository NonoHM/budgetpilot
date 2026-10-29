import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogWriter, newChain } from '../core';
import { ATTRIBUTE as A, EVENT as E } from '../names';

/**
 * `scripts/log-seal.mjs verify` (#875): its exit status per verdict and the figures of its report.
 * Run as a child `node` with no alias resolution, exactly as in the image, so a `$lib` import in its
 * closure fails here before it fails in the container. The verdicts themselves are `seal.spec.ts`'s;
 * this checks that the command reports the verifier's answer, one figure per line.
 */

const SCRIPT = resolve(import.meta.dirname, '../../../../../scripts/log-seal.mjs');

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sealedStart(dir: string, lines: number, sealed = true): string[] {
	const out: string[] = [];
	const proc = new EventEmitter();
	const write = createLogWriter({
		level: 'info',
		securityLog: 'on',
		sink: (line) => out.push(line),
		chain: newChain(),
		...(sealed ? { seal: 'on' as const } : {}),
		schedule: () => {}
	});
	write.startSeal({ dir, intervalSeconds: 900, host: 'h', proc });
	for (let i = 0; i < lines; i++) {
		write({
			event: E.backfillLockWait,
			attributes: { [A.backfillName]: `n${i}`, [A.backfillWaitedSeconds]: i }
		});
	}
	proc.emit('exit');
	return out;
}

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'bp-log-seal-'));
	dirs.push(dir);
	const a = sealedStart(dir, 3);
	const b = sealedStart(dir, 2);
	return { a, b, dir, vkey: readFileSync(join(dir, 'verification.vkey'), 'utf8').trim() };
}

function run(args: string[], input: string) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], {
		input,
		encoding: 'utf8',
		env: { PATH: process.env.PATH }
	});
	const figure = (name: string) =>
		new RegExp(`^${name}: (.*)$`, 'm').exec(result.stdout)?.[1] ?? null;
	return {
		status: result.status,
		verdict: figure('status'),
		linesRead: figure('lines read'),
		verified: figure('checkpoints verified'),
		breaks: result.stdout.split('\n').filter((line) => line.startsWith('BREAK ')).length,
		stderr: result.stderr
	};
}

describe('scripts/log-seal.mjs verify', () => {
	it('exits 0 on a verified log, with the lines read and the checkpoints verified', () => {
		const { a, b, vkey } = fixture();
		expect(run(['verify', '--vkey', vkey], [...a, ...b].join(''))).toMatchObject({
			status: 0,
			verdict: 'verified',
			linesRead: String(a.length + b.length),
			verified: '2',
			breaks: 0
		});
	});

	it('exits 1 on a broken log, one BREAK line per break', () => {
		const { a, b, vkey } = fixture();
		const deleted = [...a.slice(0, 1), ...a.slice(2), ...b];
		expect(run(['verify', '--vkey', vkey], deleted.join(''))).toMatchObject({
			status: 1,
			verdict: 'broken',
			breaks: 2
		});
	});

	it('exits 3 when nothing is contradicted but a start is unsealed', () => {
		const { a, b, dir, vkey } = fixture();
		const plain = sealedStart(dir, 1, false);
		expect(run(['verify', '--vkey', vkey], [...a, ...plain, ...b].join(''))).toMatchObject({
			status: 3,
			verdict: 'unverified',
			breaks: 0
		});
	});

	it('exits 2 when no checkpoint verifies, and says why on stderr', () => {
		const { dir, vkey } = fixture();
		const result = run(['verify', '--vkey', vkey], sealedStart(dir, 2, false).join(''));
		expect([result.status, result.verdict, result.verified]).toEqual([2, 'nothing', '0']);
		expect(result.stderr).toMatch(/^No checkpoint verified/);
	});

	it('exits 2 with the usage when no key is given, and with the reason on a vkey it cannot read', () => {
		const { a } = fixture();
		const noKey = run(['verify'], a.join(''));
		const badKey = run(['verify', '--vkey', 'budgetpilot/log+00000000+AAAA'], a.join(''));
		expect([noKey.status, noKey.verdict, noKey.stderr.split('\n')[0]]).toEqual([
			2,
			null,
			'Usage: log-seal.mjs verify --vkey <verification key> [--vkey <another>]'
		]);
		expect([badKey.status, badKey.verdict, badKey.stderr.trim()]).toEqual([
			2,
			null,
			'The verification key is not an ML-DSA-44 checkpoint key (type 0x06).'
		]);
	});
});
