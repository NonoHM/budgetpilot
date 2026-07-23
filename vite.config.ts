import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			strategy: ['cookie', 'preferredLanguage', 'baseLocale']
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**'],
					// Component specs assert French copy (fr is the app's baseLocale). Paraglide resolves
					// its display language via 'cookie' > 'preferredLanguage' > 'baseLocale' (see
					// src/lib/paraglide/runtime.js), and the headless Chromium spun up by
					// @vitest/browser-playwright has no PARAGLIDE_LOCALE cookie, so it falls through to
					// 'preferredLanguage' — the browser's own default language. That happens to be
					// French on a dev machine but is en-US on GitHub's runners, so every test asserting
					// French text (buttons, aria-labels, menu items) failed there while passing locally.
					// Same root cause the e2e suite hit and fixed the same way — see e2e/fixtures.ts's
					// comment — rather than relying on the browser's own locale.
					setupFiles: ['./vitest.client.setup.ts']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
