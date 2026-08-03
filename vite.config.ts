import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

// `vite dev` loads .env into $env/dynamic/private but NEVER into process.env, so every
// module reading process.env directly (areSecureCookiesEnabled, isLocalLlmEnabled's
// default argument, PASSWORD_HASH_COST, SESSION_TTL_DAYS, ...) silently saw an empty
// value in local dev while Docker — where the same variables arrive as real process
// env — behaved as documented. Copying the loaded values across closes that gap in one
// place instead of converting every call site, and keeps `npm run dev` honest about the
// .env sitting next to it.
//
// Deliberately narrow: `mode === 'development'` only, so this never touches `npm run
// preview` (mode "production", the server the e2e suite boots against its own throwaway
// database — it must keep getting exactly the env Playwright hands it, never the
// developer's real .env) and never runs under vitest (mode "test"). Existing process env
// always wins, so an explicit `FOO=bar npm run dev` still overrides the file.
function loadDotEnvIntoProcessEnv(mode: string) {
	if (mode !== 'development') return;
	for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ''))) {
		process.env[key] ??= value;
	}
}

export default defineConfig(({ mode }) => {
	loadDotEnvIntoProcessEnv(mode);

	return {
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
						// Component specs assert French copy. Paraglide resolves its display language via
						// 'cookie' > 'preferredLanguage' > 'baseLocale' (see src/lib/paraglide/runtime.js),
						// and the headless Chromium spun up by @vitest/browser-playwright has no
						// PARAGLIDE_LOCALE cookie, so it falls through to 'preferredLanguage' — the
						// browser's own default language. That happens to be French on a dev machine but is
						// en-US on GitHub's runners, so every test asserting French text (buttons,
						// aria-labels, menu items) failed there while passing locally. vitest.client.setup.ts
						// pins the cookie to 'fr' instead. Note the specs assert French even though the base
						// locale is now 'en': the cookie is what decides, and that is the point — the pin is
						// what makes these specs independent of both the runner's language and the fallback
						// chain. Same root cause the e2e suite hit and fixed the same way — see
						// e2e/fixtures.ts's comment.
						setupFiles: ['./vitest.client.setup.ts']
					}
				},

				{
					extends: './vite.config.ts',
					test: {
						name: 'server',
						environment: 'node',
						include: ['src/**/*.{test,spec}.{js,ts}'],
						exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
						// Pins the locale these specs render in — see the file for why it has to be
						// explicit now that 'en' is the base locale.
						setupFiles: ['./vitest.server.setup.ts']
					}
				}
			]
		}
	};
});
