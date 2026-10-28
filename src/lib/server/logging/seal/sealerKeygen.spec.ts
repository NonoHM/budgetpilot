import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A runtime that cannot make an ML-DSA-44 key: the only failure the file system cannot cause.
vi.mock('node:crypto', async (original) => ({
	...(await original<typeof import('node:crypto')>()),
	generateKeyPairSync: () => {
		throw new TypeError('The argument type is invalid');
	}
}));

const { openSealKey } = await import('./sealer');

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a key that cannot be generated', () => {
	// Separates « the runtime could not make the key » from « the directory is not writable »: the
	// second sends the operator to change a directory that is fine.
	it('names keygen_failed, not dir_unwritable, and leaves the directory empty', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bp-keygen-'));
		dirs.push(dir);
		expect([openSealKey(dir), readdirSync(dir)]).toEqual([{ reason: 'keygen_failed' }, []]);
	});
});
