# Bundling three Prisma clients in one image

Multi-DB chantier, Part 2 (PR 1 of 2). Design approved 2026-07-30.

## Problem

The published Docker image supports one database. `DATABASE_PROVIDER=postgresql` works in CI's
db-matrix but not in the real image, and the image papers over that with a boot-time
`npx prisma generate` in `docker-entrypoint.sh`.

That workaround costs the read-only posture of `node_modules`. The Dockerfile grants:

```dockerfile
RUN chown -R app:app /app/node_modules/.prisma
```

which its own comment concedes is "write access to something that then executes".

### What was actually on disk before this change

Worth stating, because it contradicts the assumption the work started from:

- All three schemas declared `generator client { provider = "prisma-client-js" }` with **no
  `output`**, so all three generated to the same default path and overwrote each other. Exactly
  one client existed at a time — `node_modules/.prisma/client/schema.prisma` read
  `provider = "sqlite"`.
- CI's db-matrix passed because it regenerates per matrix job with `DATABASE_PROVIDER` set. That
  proves each client works in isolation. It never proved three coexisting.
- `client.ts` dispatched _driver adapters_ across three providers (real), but the generated client
  was a single static `import prismaClientPkg from '@prisma/client'`. Nothing selected a client.

So bundling all three was not a Docker wiring task awaiting hookup. It was unimplemented, and the
repo had committed in writing to the opposite design.

## Approach

Generate all three clients at build time, ship all three in the image, dispatch at runtime. No
codegen at boot, so `node_modules` goes fully read-only again.

### Output location

Each schema's generator writes into the source tree:

| schema                            | output                                            |
| --------------------------------- | ------------------------------------------------- |
| `prisma/schema.prisma`            | `../src/lib/server/database/generated/sqlite`     |
| `prisma/schema.postgresql.prisma` | `../src/lib/server/database/generated/postgresql` |
| `prisma/schema.mysql.prisma`      | `../src/lib/server/database/generated/mysql`      |

Not `node_modules`. Generating there is Prisma's legacy pattern and carries a documented
multi-stage-COPY hazard: the generated client goes silently missing at runtime if a future
Dockerfile refactor drops a COPY step. That is precisely the class of bug this change exists to
remove, so reintroducing it in a different shape would be a poor trade. Source-tree output is
Prisma's current recommended practice and needs no Dockerfile handling at all — `src/` is already
copied and built normally, and the clients ride into the image inside the existing
`COPY --from=builder /app/build`.

The directory is gitignored and carries a `README.md` marking it as build output, never
hand-edited.

### Generator: `prisma-client`, not `prisma-client-js`

`prisma-client-js` is in maintenance mode and slated for removal, so keeping it would mean adopting
deprecated tooling on day one for something meant to last. `prisma-client` is also Rust-free: no
native query-engine binary at all, which meaningfully shrinks the opaque, unauditable surface of a
security-first project, alongside a smaller bundle and faster queries. It is designed for exactly
the source-tree output already chosen.

**Gate:** a spike confirms it bundles cleanly under Vite/SvelteKit before anything else is built. A
Webpack-specific ESM import-extension issue is documented upstream; whether Vite is affected is
unverified and must be established empirically, not assumed. If an extension mismatch appears, the
fix is the generator's own `generatedFileExtension` / `importFileExtension` options pointing at
`.ts` directly — not an external workaround. The spike result is reported before implementation
proceeds.

### Runtime dispatch

`client.ts` statically imports all three generated clients and picks one with a `switch` on the
resolved provider. This mirrors `adapter.ts`, which already statically imports all three drivers,
for the reason stated there: making the module async would push `await` into every one of the
~50 modules that import `prisma`.

The `PrismaClient` type comes from the sqlite client. All three are structurally identical by
construction — they are derived from one authored schema by `schemaGenerator.ts`, which varies only
the datasource block and native column types.

`schemaGenerator.ts` gains responsibility for rewriting the `generator` block's `output` too, so
the derived schemas stay fully derived and `--check` keeps proving they are not stale.

## Docker

- `builder`: generate all three before `npm run build`
- `prod-deps`: `npx prisma generate` deleted, nothing consumes it
- `runner`: the `chown` on `.prisma` deleted with its justification, which stops being true
- `docker-entrypoint.sh`: boot-time regen deleted, leaving `migrate deploy` then `exec node build`

## Other changes in scope

- **Dependabot lockstep:** a group covering `prisma`, `@prisma/client` and every `@prisma/adapter-*`
  so they only bump together. Version skew between CLI, client and adapters is a known source of
  confusing runtime errors.
- **Boot log:** `database-provider=<value>` joins the existing startup line next to
  `cookies-secure`. Non-secret diagnostic detail that removes any reason to ask an operator for
  `DATABASE_URL` during support.
- **CI:** generation is now provider-independent, so the db-matrix needs `DATABASE_PROVIDER` only at
  test time, not at generate time.

## Accepted trade-offs

**All three clients ship in every image**, regardless of which provider is active. Deployment
simplicity — one image, two environment variables — is worth more than minimal image size here, and
`prisma-client`'s Rust-free footprint mitigates most of the cost versus the legacy generator.
Revisit only if image size becomes a real operational problem.

**Three migration histories grow independently**, the permanent cost of schema-per-provider, already
accepted in Part 1. No action now; worth a periodic look if any single history becomes hard to read.

## Verification

Unit tests for the generator's `output` rewrite and for the client dispatch, plus the full
`lint` / `check` / `test:unit` suite.

Then a real Docker smoke test, mandatory before merge — CI's non-Docker db-matrix does not
substitute. The image must build, boot on `DATABASE_PROVIDER=sqlite` (the unchanged default), and
boot separately against throwaway `postgres:17-alpine` and `mariadb:11` containers, running
`migrate deploy` and a working login on each. Containers and images cleaned up after. This closes
the gap from the prior session, where a Dockerfile change merged without ever being build-tested
because the machine was out of disk.

Security review is mandatory: this changes the Docker read-only posture.

## Out of scope

Compose overlays and all operator docs (PR 2). The `hashFingerprint` rename, the 13 remaining
`backup/schema.ts` bounds, and the non-ASCII invitation edge case stay separate follow-ups so this
PR stays reviewable.
