# Generated Prisma clients

Build output. Not authored, not committed, never edited by hand.

`npx prisma generate` writes one client per provider here — `sqlite/`, `postgresql/`, `mysql/` —
each from its own schema in `prisma/`. The `output` path lives in each schema's `generator` block
and is derived by `schemaGenerator.ts`, so it is not edited directly either: change
`prisma/schema.prisma`, run `npm run db:schemas`, then `npx prisma generate`.

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
