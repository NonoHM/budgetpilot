import { join } from 'node:path';
import { resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { DEV_SERVER_FS_DENY } from './devServerDeny';

// `vite dev` served `.svelte-kit/generated/dev/env/config.js`, which SvelteKit 3 writes with every
// declared private value in it, to any request on loopback: HTTP 200 with 3 of 3 test secrets,
// while `.env` answered 403 (#1336). Read through Vite's own matcher, because a glob is only what
// the matcher that runs it says it is. Separates a dev server that refuses that file, and keeps
// refusing everything Vite refuses by default, from one that serves it or drops a default.
const root = process.cwd();
// `fsDenyGlob` is the matcher Vite runs on every served path. It is internal, so it is typed here;
// were Vite to drop it, these specs would fail on the call rather than pass.
type WithDenyMatcher = Awaited<ReturnType<typeof resolveConfig>> & {
	fsDenyGlob: (path: string) => boolean;
};
const resolve = async (deny?: string[]) =>
	(await resolveConfig(
		{ configFile: false, root, server: deny ? { fs: { deny } } : {} },
		'serve'
	)) as WithDenyMatcher;

describe('the dev server deny list', () => {
	it('refuses the generated file that holds the env values', async () => {
		const config = await resolve(DEV_SERVER_FS_DENY);
		expect(config.fsDenyGlob(join(root, '.svelte-kit/generated/dev/env/config.js'))).toBe(true);
	});

	it('keeps every file Vite refuses by default', async () => {
		const defaults = (await resolve()).server.fs.deny;
		expect(defaults.length).toBeGreaterThanOrEqual(6);
		expect(DEV_SERVER_FS_DENY).toEqual(expect.arrayContaining(defaults));
	});

	it('still serves the public env module the browser needs', async () => {
		const config = await resolve(DEV_SERVER_FS_DENY);
		expect(config.fsDenyGlob(join(root, '.svelte-kit/generated/dev/env/public/client.js'))).toBe(
			false
		);
	});
});
