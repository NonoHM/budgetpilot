/**
 * The running build's own version, injected by Vite from `package.json` (see `vite.config.ts`).
 *
 * A `define` rather than a runtime `readFileSync`: the production image ships `build/` and does not
 * guarantee a `package.json` next to the server bundle, so reading one at runtime would work in dev
 * and return nothing in the only environment where the question is actually asked.
 *
 * `package.json` is the file release-please bumps on every release, so this needs no maintenance
 * and cannot drift from the tag the image was published under.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = __APP_VERSION__;
