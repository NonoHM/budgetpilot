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
					// Same pre-existing Bits UI hydration-race flake documented in AccountMenu.svelte
					// and mitigated the same way in playwright.config.ts: a click on a DropdownMenu
					// trigger can fire before Bits UI's handler finishes attaching, so a poll-based
					// assertion right after occasionally times out. Never reproduces locally (fast,
					// uncontended CPU) — only showed up once CI's push trigger was fixed and these
					// real-Chromium tests actually ran on a GitHub-hosted runner for the first time.
					// Raising the timeout doesn't help (the element genuinely isn't wired up yet), so
					// retry like the e2e suite does, not a longer wait.
					retry: 2
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
