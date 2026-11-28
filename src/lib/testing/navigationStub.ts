/**
 * `$app/navigation` without a router, for component specs that mock it (#1336).
 *
 * SvelteKit 3's real module cannot be loaded from inside a mock of itself: its graph comes back to
 * `app/navigation/index.js` (`forms/client.js` imports it), so the factory waits on its own result.
 * Measured: a factory awaiting `importOriginal`, or importing SvelteKit's navigation file directly,
 * times out, and the whole client project hung on the first such spec. A component spec has no router either, so
 * each real function would only register a callback that never fires, or throw. These do nothing,
 * and a spec overrides the one it asserts on: `{ ...navigationStub, goto: navigation.goto }`.
 * Imports nothing from SvelteKit, which is what keeps it out of the cycle.
 */
export const afterNavigate = (): void => {};
export const beforeNavigate = (): void => {};
export const onNavigate = (): void => {};
export const disableScrollHandling = (): void => {};
export const goto = async (): Promise<void> => {};
export const invalidate = async (): Promise<void> => {};
export const invalidateAll = async (): Promise<void> => {};
export const refreshAll = async (): Promise<void> => {};
export const preloadCode = async (): Promise<void> => {};
export const preloadData = async (): Promise<void> => {};
export const pushState = (): void => {};
export const replaceState = (): void => {};
