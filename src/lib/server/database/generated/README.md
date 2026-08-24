# Generated Prisma clients

Build output. Not authored, not committed, never edited by hand.

**`npm run db:generate` writes one client per provider here**, `sqlite/`, `postgresql/` and
`mysql/`, each from its own schema in `prisma/`. It is a separate `prisma generate` pass per
provider, each with its own `DATABASE_PROVIDER`, which is what `scripts/generate-prisma-clients.mjs`
exists to run.

**`npx prisma generate` on its own writes only the client for the provider you have configured**,
and `database/client.ts` imports all three statically, so a tree that has only ever run the bare
command does not build. That is #474, and it is what made a clean clone unbuildable after the
documented setup.

The `output` path lives in each schema's `generator` block and is derived by `schemaGenerator.ts`,
so it is not edited directly either: change `prisma/schema.prisma`, run `npm run db:schemas`, then
`npm run db:generate`.

Everything in this directory except this README is gitignored. If it is missing or stale, the app
will not build; regenerate rather than reaching for a copy.

## Why three

All three ship in the published image regardless of which provider is active, and `client.ts`
picks one at runtime from `DATABASE_PROVIDER`. A generated client embeds the schema it came from
and refuses a driver adapter that does not match it, so one client cannot serve three engines.

Generating all three at build time is what lets `node_modules` stay read-only to the app user: the
image previously shipped a SQLite client and regenerated at boot for anything else, which meant
granting write access to a directory that then executes.

See `docs/superpowers/specs/2026-07-30-bundle-three-prisma-clients-design.md` for the full
reasoning, including the image-size trade-off.
