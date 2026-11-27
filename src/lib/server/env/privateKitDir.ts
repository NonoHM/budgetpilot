import { chmodSync, mkdirSync } from 'node:fs';

/**
 * Closes SvelteKit's output directory to every account but its owner. Outside a build SvelteKit 3
 * writes the declared env VALUES, secrets included, into `generated/dev/env/config.js` under it at
 * the default umask (#1336). A 0700 directory makes that file unreachable whatever mode kit gives
 * it, so the fix does not depend on kit's internal layout. Called from `vite.config.ts` before the
 * SvelteKit plugin writes anything. POSIX modes only: Windows ACLs are untouched.
 */
export function keepKitOutDirPrivate(dir: string): void {
	if (process.platform === 'win32') return;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}
