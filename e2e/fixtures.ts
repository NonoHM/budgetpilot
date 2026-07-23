import { test as base, expect } from '@playwright/test';
import { E2E_BASE_URL } from './config';

// Explicit locale fixture: the app resolves its display language via Paraglide's own
// 'cookie' > 'preferredLanguage' > 'baseLocale' strategy (src/lib/paraglide/runtime.js),
// reading a `PARAGLIDE_LOCALE` cookie first. This suite asserts French copy everywhere
// (fr is the app's baseLocale), which used to be achieved indirectly by pinning
// Playwright's own browser `locale` to 'fr-FR' in playwright.config.ts — that only worked
// because Chromium's Accept-Language header then fed Paraglide's 'preferredLanguage'
// fallback, i.e. the suite depended on the language cookie staying absent. Setting the
// cookie directly here makes "this suite renders in French" an explicit fact in test code,
// robust to any future change in the fallback chain or in Playwright's own locale default.
export const test = base.extend({
	context: async ({ context }, use) => {
		await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'fr', url: E2E_BASE_URL }]);
		await use(context);
	},
	// Root-cause fix for a full-suite-only flake (see playwright.config.ts's `retries` comment):
	// every spec does `page.goto(...)` and then immediately clicks/presses a key on an element that
	// opens a client-side-only overlay (dropdown menu, modal). SvelteKit's client bundle can still be
	// loading/executing at that instant, so the interaction sometimes fires before Bits UI's handlers
	// are attached and is silently lost. Overriding `goto` here to also wait for network activity to
	// settle (a good proxy for "the client JS has finished loading and hydration has started") closes
	// almost all of that race window, in exactly one place, instead of touching every interaction site
	// across ~18 spec files. `retries` in playwright.config.ts remains as a safety net for the residual
	// gap between "network idle" and "hydration fully attached".
	page: async ({ page }, use) => {
		const originalGoto = page.goto.bind(page);
		page.goto = (async (url, options) => {
			const response = await originalGoto(url, options);
			await page.waitForLoadState('networkidle');
			return response;
		}) as typeof page.goto;
		await use(page);
	}
});

export { expect };
