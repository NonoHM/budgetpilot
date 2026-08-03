import { describe, it, expect } from 'vitest';
import { baseLocale, locales, strategy } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';

/**
 * The base locale is not a formatting preference, it is the app's answer to two separate
 * questions, and both were French until this file existed:
 *
 *   1. What does a visitor whose browser asks for a locale we do not have get? The `baseLocale`
 *      strategy is the terminal entry of the chain, so a request for `es`, `ja` or one carrying
 *      no Accept-Language header at all lands on it. A Spanish or Japanese speaker reads English
 *      far better than French.
 *   2. What does a key missing from one catalogue render as? Paraglide's compiler builds its
 *      fallback map from `baseLocale` alone (`getFallbackMap` in compile-project.js) — there is
 *      no separate option for it, which is why answering (1) and (2) differently is not possible
 *      without patching the compiler.
 *
 * Neither is observable from a unit test that goes through `getLocale()`, because
 * vitest.server.setup.ts pins that to 'fr' for every other spec in this project. Passing an
 * explicit `{ locale }` is what makes this assertion independent of that pin — without it, this
 * file would be testing the setup file rather than the app.
 */
describe('fallback locale', () => {
	it('falls back to English, not French', () => {
		expect(baseLocale).toBe('en');
	});

	it('offers French as a translation rather than as the source', () => {
		expect(locales).toContain('fr');
		expect(locales).toContain('en');
	});

	it('ends the strategy chain on the base locale, so an unsupported language reaches it', () => {
		// Paraglide throws "No locale found" at runtime if nothing in the chain matches, so this
		// is what turns an es-ES or header-less request into English instead of a 500.
		expect(strategy.at(-1)).toBe('baseLocale');
	});

	it('renders English copy at the base locale', () => {
		// The constant above says which locale is the fallback; this says what that locale
		// actually renders, which is the half a renamed-constant refactor could break silently.
		expect(m.login_heading(undefined, { locale: baseLocale })).toBe('Sign in');
		expect(m.login_heading(undefined, { locale: 'fr' })).toBe('Connexion');
	});
});
