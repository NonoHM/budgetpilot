# check=skip=SecretsUsedInArgOrEnv
# ^ Parser directive, so it has to be line 1: BuildKit stops looking for these after the first
# comment or instruction. The reasoning is at the `ENV` block in the `builder` stage below, and
# so is the check that keeps the skip honest. Do not remove either half without reading it.

FROM node:24.18.0-trixie-slim AS deps
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		python3 \
		build-essential \
		pkg-config \
		ca-certificates \
		openssl \
	&& rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund


FROM node:24.18.0-trixie-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# One generated client per provider, all three baked into the image. A generated client embeds
# the schema it came from and refuses a driver adapter that does not match it, so a single client
# cannot serve three engines, and client.ts picks the right one at runtime from
# DATABASE_PROVIDER.
#
# Generating all three here rather than at boot is what lets node_modules stay read-only to the
# app user in the runner stage: the alternative this replaced regenerated on startup and needed
# write access to a directory that then executes.
#
# Each client is written into src/lib/server/database/generated/<provider> (the `output` in each
# schema's generator block), so they are compiled into the build output below and reach the
# runner through the existing `COPY --from=builder /app/build`. Nothing here needs a COPY of its
# own, which is the point: a client that lived in node_modules could go missing at runtime if a
# future refactor dropped a COPY step.
#
# `svelte-kit sync` first, and it is not optional here. The `prisma-client` generator emits
# TypeScript and reads tsconfig.json to do it; this repo's tsconfig.json extends
# ./.svelte-kit/tsconfig.json, which only exists once SvelteKit has synced. Locally and in CI it
# is already there (npm's `prepare` script runs it during `npm ci`), but this stage installs
# nothing — it copies node_modules from `deps` — so nothing has created it yet, and
# `prisma generate` fails with "File './.svelte-kit/tsconfig.json' not found."
RUN npx svelte-kit sync \
	&& npm run db:generate

# SvelteKit's postbuild analysis step imports every server module to find prerendering
# candidates, which runs each module's top-level validation — these throwaway build-time
# values (never baked into the /app/build output, never used at runtime) satisfy that
# check the same way CI's test-and-build job does. Real values are supplied via env/volume
# when the image actually runs.
#
# BuildKit's SecretsUsedInArgOrEnv check fires on the two lines below, on the strength of the
# variable *names* alone. It is a false positive here, and the `# check=skip=` directive at the
# top of this file is what silences it. Four facts, each confirmed by running the thing rather
# than by reading the Dockerfile:
#
#   1. No real value can reach these lines. Both are literal constants in a tracked file. There
#      is no ARG, no `--mount=type=secret` and no `build.args` in any compose file, so nothing
#      an operator supplies is interpolated here. An injection path would have to be added on
#      purpose.
#   2. Neither value survives into the shipped image. The `runner` stage starts its own
#      `FROM node:...` rather than deriving from `builder`, and COPYs only build artefacts out
#      of it. `docker inspect --format '{{json .Config.Env}}'`, `docker history --no-trunc` and
#      a recursive grep of /app in the built image all come back empty for both values and for
#      this stage's placeholder DATABASE_URL.
#   3. They are not removable, which is the tempting "fix". Deleting both was tried: the build
#      dies at `npm run build` with `Error: TOTP_ENCRYPTION_KEY is required (set it in your
#      environment)`, thrown from crypto.ts inside the `analyse` step described above.
#   4. The generated Prisma clients carry no credential either. The datasource block in every
#      schema has no `url` field, so the `inlineSchema` baked into each client holds no
#      connection string.
#
# The one real cost of the skip is that it is file-wide: BuildKit has no per-line suppression,
# so a genuinely leaked secret in some future ENV would no longer be flagged. That is covered by
# the "no build-time value in the final image" assertion in scripts/docker-smoke.sh, which
# checks the artefact instead of the instruction and runs in CI on every change. Keep them
# together: dropping the assertion turns the skip into an actual blind spot.
#
# So: nothing to fix here, only to document. Do not "solve" this by moving these to build ARGs
# (same warning, same non-problem) or by deleting them (see 3).
ENV DATABASE_URL=file:/tmp/build-placeholder.db
ENV TOTP_ENCRYPTION_KEY=c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1
ENV RATE_LIMIT_HASH_SECRET=docker-build-only-fake-rate-limit-hash-secret-do-not-reuse

RUN npm run build


FROM node:24.18.0-trixie-slim AS prod-deps
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		python3 \
		build-essential \
		pkg-config \
		ca-certificates \
		openssl \
	&& rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3
ENV NODE_ENV=production
ENV DATABASE_URL=file:/data/dev.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
# prisma.config.ts resolves the schema and the migration history from DATABASE_PROVIDER, so it
# imports this one module. Dependency-free by design, precisely so it can be dropped into a
# stage that has no application source.
COPY src/lib/server/database/provider.ts ./src/lib/server/database/provider.ts

# No `prisma generate` here. The three clients this image runs on are generated in the builder
# stage and compiled into the build output; this stage exists only for the production
# dependency tree and for the schemas `prisma migrate deploy` reads at boot.


FROM node:24.18.0-trixie-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATABASE_URL=file:/data/dev.db

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		openssl \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --system app \
	&& useradd --system --gid app --home /home/app --create-home app \
	&& mkdir -p /data \
	&& chown -R app:app /data /home/app

# /app stays root-owned, and the app user's home is deliberately NOT /app.
#
# Owning the entries is not enough: unlink and rename are governed by the write bit on the
# *parent directory*, not by the ownership of what sits inside it. While the app user owned
# /app it could `mv /app/build /app/build.bak` and put its own there — same for
# docker-entrypoint.sh and node_modules, root-owned and 555 though they are. That turns any
# RCE in the app into persistence across a restart, which is the exact property removing the
# boot-time `prisma generate` was meant to eliminate.
#
# /app had to be writable while the entrypoint ran `npx prisma generate` at boot, because npx
# wants a writable HOME. Nothing regenerates code at boot any more, so nothing needs it, and
# /data is the only writable thing left in the image.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# Same reason as the prod-deps stage: the CMD below runs `prisma migrate deploy`, which loads
# prisma.config.ts, which imports this module to pick the provider's migration history.
COPY --from=builder /app/src/lib/server/database/provider.ts ./src/lib/server/database/provider.ts

# The name-normalization preview, and everything it imports.
#
# docs/operations.md tells an operator to read exactly which rows the one-time name merge will
# join, by name, before upgrading, and hooks.server.ts prints the same command when the
# backfill leaves groups it refused to merge. Both said
# `docker compose run --rm budgetpilot npm run db:normalize-names -- --dry-run`, and neither
# could ever work: `scripts/` was not in this stage, so the one preview of an irreversible
# change to financial data failed with MODULE_NOT_FOUND on every Docker install.
#
# The script imports the app's own modules through relative `.ts` paths, which Node runs
# directly (type stripping, on by default since Node 22.18). So what ships is source, listed
# file by file rather than as a directory: `src/lib/server/database/` also holds *.spec.ts and
# the db-smoke suite, which have no business in a production image. Adding an import to any of
# these modules without adding the file here breaks the command again, silently, since nothing
# else in the image loads them. scripts/docker-smoke.sh runs the dry run against the built image
# on every change, which is what turns that back into a build-time failure.
#
# The generated clients are the bulk of it (~5 MB) and are copied as source even though the app
# already carries them compiled inside `build`: client.ts imports all three statically, and the
# CLI resolves them from the source tree the same way the builder did. Two copies of one
# generated artifact, produced by the same `npm run db:generate` in the same stage, so they
# cannot disagree.
COPY --from=builder /app/scripts/normalize-names.mjs ./scripts/normalize-names.mjs
COPY --from=builder /app/src/lib/domain/normalize.ts ./src/lib/domain/normalize.ts
COPY --from=builder /app/src/lib/server/dbTransaction.ts ./src/lib/server/dbTransaction.ts
COPY --from=builder /app/src/lib/server/database/adapter.ts \
	/app/src/lib/server/database/advisoryLock.ts \
	/app/src/lib/server/database/client.ts \
	/app/src/lib/server/database/types.ts \
	./src/lib/server/database/
COPY --from=builder /app/src/lib/server/database/generated ./src/lib/server/database/generated
COPY --from=builder /app/src/lib/server/naming/backfill.ts \
	/app/src/lib/server/naming/mergePlan.ts \
	/app/src/lib/server/naming/nameKey.ts \
	/app/src/lib/server/naming/report.ts \
	./src/lib/server/naming/

COPY package.json package-lock.json ./
COPY --chmod=555 docker-entrypoint.sh ./docker-entrypoint.sh

USER app

EXPOSE 3000

CMD ["./docker-entrypoint.sh"]