// Pins Paraglide's locale for browser-mode component specs. See vite.config.ts's 'client'
// project comment for why: without this, the app falls back to the browser's own default
// language, which is French on a dev machine but en-US on GitHub's runners. Load-bearing in
// both directions since 'en' became the base locale: nothing else in a browser-mode spec
// would produce French.
document.cookie = 'PARAGLIDE_LOCALE=fr; path=/';
