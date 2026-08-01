import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		// Force runes mode for the project, except for libraries.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		typescript: {
			config: (config) => {
				// svelte-kit sync's generated include covers ../src, ../test, ../tests but not
				// ../e2e — so an e2e file importing a symbol a refactor moved or removed is caught
				// by nothing this repo runs (test:unit doesn't execute e2e, eslint doesn't
				// validate named exports across modules). Add it here rather than restating the
				// list in tsconfig.json: an extending tsconfig's `include` REPLACES the base's,
				// it doesn't merge, so restating it would be one more place to keep in sync.
				config.include = [...(config.include ?? []), '../e2e/**/*.ts', '../e2e/**/*.js'];
				return config;
			}
		},
		// CSP: SvelteKit augments script-src with a nonce for its own inline scripts
		// (mode: 'auto' -> nonce for dynamically-rendered pages, this app has no
		// prerendered page). style-src has no 'unsafe-inline': every previously
		// data-driven inline style="" attribute (chart bars, category color dots,
		// donut chart) was converted to static Tailwind classes (bounded color
		// palettes mapped to arbitrary-value bg-[#hex] classes, percentages
		// quantized to 101 static w-[N%] classes) or SVG fill/stroke presentation
		// attributes (not governed by style-src). The only remaining dynamic
		// styling (drag/swipe transforms in BottomSheet/TransactionFocusOverlay,
		// NetWorthChart's hover card, Spinner's size/duration) uses Svelte's
		// `style:` directive, which
		// applies via el.style.setProperty(...) client-side after hydration and is
		// unaffected by this directive (unlike a literal style="" attribute, which
		// CSP blocks regardless of a matching nonce). img-src allows data: for the
		// TOTP QR code (settings/+page.server.ts, generateTotpQrCodeDataUrl).
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self'],
				// Scoped exception for style="" attributes only — `style-src: self` above still
				// governs stylesheets and <style> blocks, and script-src is untouched.
				//
				// Needed because the remaining inline style attributes all come from
				// dependencies, not from this app: SvelteKit hardcodes one on its
				// #svelte-announcer live region (core/sync/write_root.js), and bits-ui hides
				// its helper inputs with svelte-toolbelt's srOnlyStyles. Both are on
				// visually-hidden accessibility elements, neither is reachable from app code,
				// and every page was reporting at least one violation because of them.
				//
				// The exposure this adds is narrow: a style attribute can't execute script,
				// and the usual CSS-based exfiltration trick (background: url(https://evil))
				// is already blocked by img-src's self/data allowlist. Silencing the constant
				// noise is worth more than that margin — a console that always has violations
				// in it is a console nobody reads a real violation out of.
				'style-src-attr': ['unsafe-inline'],
				'img-src': ['self', 'data:'],
				'font-src': ['self'],
				'connect-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none']
			}
		}
	}
};

export default config;
