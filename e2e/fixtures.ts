import { test as base, expect } from '@playwright/test';
import { overwriteGetLocale } from '../src/lib/paraglide/runtime';
import { E2E_BASE_URL, E2E_LOCALE } from './config';

// Half the suite builds its selectors from the message functions themselves
// (`getByRole('textbox', { name: m.login_password_label() })`, in 27 spec files), and those run
// in Playwright's node process, where there is no request and therefore no locale: getLocale()
// falls straight through the strategy chain to `baseLocale`. That silently agreed with the
// browser side for as long as `baseLocale` was 'fr' — and stopped agreeing the moment it became
// 'en', with the page rendering "Mot de passe" while the selector looked for "Password". Whole
// spec files timed out in `beforeEach`, and no static gate could have seen it: the selectors
// type-check, the page is correct, and the two halves only meet at runtime. Pinning both from
// one constant is what makes them unable to drift apart again.
overwriteGetLocale(() => E2E_LOCALE);

// Explicit locale fixture: the app resolves its display language via Paraglide's own
// 'cookie' > 'preferredLanguage' > 'baseLocale' strategy (src/lib/paraglide/runtime.js),
// reading a `PARAGLIDE_LOCALE` cookie first. This suite asserts French copy everywhere,
// which used to be achieved indirectly by pinning Playwright's own browser `locale` to
// 'fr-FR' in playwright.config.ts — that only worked because Chromium's Accept-Language
// header then fed Paraglide's 'preferredLanguage' fallback, i.e. the suite depended on the
// language cookie staying absent. Setting the cookie directly here makes "this suite renders
// in French" an explicit fact in test code, robust to any future change in the fallback chain
// or in Playwright's own locale default. That robustness is no longer hypothetical: the base
// locale is 'en' now, so French is reached only through this cookie.
export const test = base.extend({
	context: async ({ context }, use) => {
		await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: E2E_LOCALE, url: E2E_BASE_URL }]);
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
