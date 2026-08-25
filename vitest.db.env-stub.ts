/**
 * `$env/dynamic/private` for the db-smoke suite, which runs in plain node.
 *
 * `vitest.db.config.ts` deliberately does NOT load the SvelteKit plugin: these specs talk to a real
 * database and nothing else, and pulling the whole framework in to reach one module would make the
 * suite slower and its failures harder to read. But `$env` is a SvelteKit virtual module, so any
 * server module that transitively imports it (here `server/crypto.ts`, reached from
 * `banking/sync/service.ts`) is unresolvable without a shim.
 *
 * EMPTY ON PURPOSE, and it is the reason this is safe rather than a hole: a db-smoke spec that
 * needed a real secret would read `undefined` and fail loudly at the point of use, rather than
 * quietly running against a default. Nothing in the suite should depend on one; if something ever
 * does, it belongs behind an explicit fixture, not behind this file growing values.
 */
export const env: Record<string, string | undefined> = {};
