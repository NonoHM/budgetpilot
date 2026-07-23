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
		// CSP: SvelteKit augments script-src with a nonce for its own inline scripts
		// (mode: 'auto' -> nonce for dynamically-rendered pages, this app has no
		// prerendered page). style-src has no 'unsafe-inline': every previously
		// data-driven inline style="" attribute (chart bars, category color dots,
		// donut chart) was converted to static Tailwind classes (bounded color
		// palettes mapped to arbitrary-value bg-[#hex] classes, percentages
		// quantized to 101 static w-[N%] classes) or SVG fill/stroke presentation
		// attributes (not governed by style-src). The only remaining dynamic
		// styling (drag/swipe transforms in BottomSheet/TransactionFocusOverlay,
		// NetWorthChart's hover card) uses Svelte's `style:` directive, which
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
