import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keepKitOutDirPrivate } from './privateKitDir';

// Outside a build SvelteKit 3 writes the declared env VALUES, secrets included, into
// `.svelte-kit/generated/dev/env/config.js` at the default umask: 644 in 755 directories, readable
// by any local account (#1336). The same exposure #826 reports for `.env`. Separates an output
// directory only its owner can enter from one any account can.
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const scratch = () => {
	const root = mkdtempSync(join(tmpdir(), 'bp-kit-dir-'));
	roots.push(root);
	return root;
};
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

describe.skipIf(process.platform === 'win32')('keepKitOutDirPrivate', () => {
	it('closes an existing output directory any account could enter', () => {
		const dir = join(scratch(), '.svelte-kit');
		mkdirSync(dir);
		chmodSync(dir, 0o755);
		expect(mode(dir)).toBe('755');

		keepKitOutDirPrivate(dir);

		expect(mode(dir)).toBe('700');
	});

	it('creates a missing output directory closed', () => {
		const dir = join(scratch(), '.svelte-kit');

		keepKitOutDirPrivate(dir);

		expect(mode(dir)).toBe('700');
	});
});
