/**
 * Files `vite dev` refuses to serve. SvelteKit 3 writes every declared private value, secrets
 * included, into `.svelte-kit/generated/dev/env/config.js`, and the dev server served it to any
 * request on loopback (#1336). Only SvelteKit's server runtime imports that file, through Vite's
 * module runner, so refusing it over HTTP removes nothing the browser loads.
 *
 * Vite replaces its default list with this one rather than adding to it, so its six defaults are
 * restated; `devServerDeny.spec.ts` fails when a Vite release adds one this list lacks.
 */
export const DEV_SERVER_FS_DENY = [
	'.env',
	'.env.*',
	'*.{crt,pem,key,p12,pfx,cer,der}',
	'.npmrc',
	'.yarnrc.yml',
	'**/.git/**',
	'**/.svelte-kit/generated/**/env/config.js'
];
