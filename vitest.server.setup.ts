import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Pins Paraglide's locale for node-environment specs, the mirror of vitest.client.setup.ts.
//
// Ten server specs assert French copy produced by server code — form-action error messages,
// the anonymised labels sent to the LLM, dashboard takeaways. That used to happen by itself:
// there is no request and therefore no AsyncLocalStorage context in a unit test, so
// getLocale() fell through the strategy chain to `baseLocale`, which was 'fr'. Making 'en' the
// base locale flipped all of it at once.
//
// Pinning is the right answer rather than translating 52 assertions, because none of those
// specs is a claim about which locale the app serves by default — they check that a function
// returns the right *message*, and the locale it renders in was incidental. What was wrong was
// leaving it implicit. It is explicit now, and 'fr' keeps those specs readable next to the
// French `it(...)` titles they already carry.
//
// The one thing this must not do is hide the default it overrides, so
// src/lib/i18n/fallbackLocale.spec.ts asserts the base locale independently, passing an
// explicit `{ locale }` so this pin cannot mask a regression of it.
overwriteGetLocale(() => 'fr');
