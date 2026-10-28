import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A key owned by root cannot be made without root, so its stat is mocked: owner 0, the mode below.
const root = vi.hoisted(() => ({ mode: 0o100640 }));
vi.mock('node:fs', async (original) => {
	const fs = await original<typeof import('node:fs')>();
	return {
		...fs,
		statSync: (path: string) =>
			path.endsWith('key.pem')
				? { ...fs.statSync(path), uid: 0, mode: root.mode }
				: fs.statSync(path)
	};
});

const { openSealKey } = await import('./sealer');

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function dirWithKey() {
	const dir = mkdtempSync(join(tmpdir(), 'bp-owner-'));
	dirs.push(dir);
	const pem = generateKeyPairSync('ml-dsa-44').privateKey.export({ type: 'pkcs8', format: 'pem' });
	writeFileSync(join(dir, 'key.pem'), pem, { mode: 0o600 });
	return dir;
}

describe('a key owned by root (PostgreSQL: 0640 or less)', () => {
	// Separates « root's group may read it » from « the owner-only rule applied to root ».
	it('is used at 0640', () => {
		vi.spyOn(process, 'geteuid').mockReturnValue(65532);
		root.mode = 0o100640;
		expect('keyId' in openSealKey(dirWithKey())).toBe(true);
	});

	// Separates « others may not read it » from « any root-owned key is accepted ».
	it('is refused as key_exposed at 0644', () => {
		vi.spyOn(process, 'geteuid').mockReturnValue(65532);
		root.mode = 0o100644;
		expect(openSealKey(dirWithKey())).toEqual({ reason: 'key_exposed' });
	});
});
