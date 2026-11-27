import { beforeEach, vi } from 'vitest';
import { unreachableAnswer } from '$lib/testing/actionAnswers';
// Pins Paraglide's locale for browser-mode component specs. See vite.config.ts's 'client'
// project comment for why: without this, the app falls back to the browser's own default
// language, which is French on a dev machine but en-US on GitHub's runners. Load-bearing in
// both directions since 'en' became the base locale: nothing else in a browser-mode spec
// would produce French.
document.cookie = 'PARAGLIDE_LOCALE=fr; path=/';

// SvelteKit 3's `deserialize`, which `use:enhance` runs on every action answer, throws until the
// client router has called `init_transport`, and no router starts in a component spec. The throw is
// swallowed into an error result whose handler then reads the absent router, so the submit callback
// never runs (#1336). This app declares no `transport` hook, so `{}` is what the router passes too.
// Imported by path because SvelteKit does not export it; Vite serves it as the same module instance.
import { init_transport } from './node_modules/@sveltejs/kit/src/runtime/app/internal/transport.js';
init_transport({});

// The same absent router one step later: `update()` applies an in-place result through
// `applyAction` and `refreshAll`, which write the router's state and throw without it, so a page's
// callback stopped at `await update()`. SvelteKit 2 skipped both in the test page (its action and the
// page differed in path), so no component spec ever exercised them; the e2e suite does (#1336). The
// real `enhance` still posts and parses; only `update` is replaced, by the one step that needs no
// router: resetting the form after a success. Mocked at our module because SvelteKit's own modules
// import each other, and a factory awaiting one of them deadlocks. A spec mocking this module wins.
vi.mock('$lib/forms/enhance', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/forms/enhance')>();
	const enhance: typeof real.enhance = (form, submit) =>
		real.enhance(form, async (input) => {
			const callback = await submit?.(input);
			return async (opts) => {
				const update: typeof opts.update = async (options) => {
					if (opts.result.type === 'success' && (options?.reset ?? true)) {
						HTMLFormElement.prototype.reset.call(opts.formElement);
					}
				};
				return callback ? callback({ ...opts, update }) : update();
			};
		});
	return { enhance };
});

// A form submission no spec answered went to the test server, which is not SvelteKit, and SvelteKit
// 3 handles that answer through the absent router (#1336). It now gets the result the app would build
// for it. A spec that stubs `fetch` replaces this, and any other request still goes out unchanged.
const realFetch = globalThis.fetch.bind(globalThis);
beforeEach(() => {
	vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
		new Headers(init?.headers).get('x-sveltekit-action') === 'true'
			? Promise.resolve(unreachableAnswer())
			: realFetch(input, init)
	);
});
