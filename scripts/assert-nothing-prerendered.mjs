/**
 * Fails the build when SvelteKit prerendered anything.
 *
 * WHY. GHSA-27mw-82g8-phjj (kit < 3, held on kit 2 by #1148) is an XSS that needs a PRERENDERED
 * page: kit writes a `cache-control` set by `setHeaders` into a `<meta>` tag without escaping it.
 * Nothing here is prerendered, so it is unreachable, and this keeps that true rather than assumed.
 * The check reads what the build PRODUCED, not a source spelling: `prerender = 'auto'`, `entries`,
 * a `+server.ts` and `kit.prerender` config all land in the same list (kit's
 * `generate_manifest`, the set adapter-node also ships). Remove it with #1148.
 *
 * A manifest in which the list cannot be found is a broken read and fails too: « nothing
 * prerendered » and « read nothing » must never be the same output.
 *
 * Plain `.mjs`: CI runs it with bare `node` right after `npm run build`.
 * Usage: node scripts/assert-nothing-prerendered.mjs [.svelte-kit/output/server/manifest.js]
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIST = /prerendered_routes: new Set\((\[[^\]]*\])\)/g;

/**
 * The prerendered paths a built manifest lists; throws unless it holds exactly one list.
 * @param {string} manifest
 * @returns {string[]}
 */
export function prerenderedRoutes(manifest) {
	const lists = [...manifest.matchAll(LIST)];
	if (lists.length !== 1) {
		throw new Error(`found ${lists.length} prerendered_routes lists, expected exactly 1`);
	}
	return JSON.parse(lists[0][1]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const path = process.argv[2] ?? '.svelte-kit/output/server/manifest.js';
	const text = readFileSync(path, 'utf8');
	const routes = prerenderedRoutes(text);
	console.log(`read ${path}: ${text.length} bytes, ${routes.length} prerendered`);
	if (routes.length > 0) {
		console.error(
			`Prerendered: ${routes.join(', ')}. GHSA-27mw-82g8-phjj is reachable on kit 2 once a page ` +
				'is prerendered (#1148). Remove the prerender, or take kit 3 first.'
		);
		process.exit(1);
	}
}
