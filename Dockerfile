# check=skip=SecretsUsedInArgOrEnv
# ^ Parser directive, so it has to be line 1: BuildKit stops looking for these after the first
# comment or instruction. The reasoning is at the `ENV` block in the `builder` stage below, and
# so is the check that keeps the skip honest. Do not remove either half without reading it.

# Every FROM is pinned by digest, and specifically by the *index* (manifest-list) digest rather
# than a per-architecture one: the publish workflow builds linux/amd64 and linux/arm64 from these
# same lines, and a per-arch digest would pin the build to one of them. `docker buildx imagetools
# inspect <ref>` prints the index digest first, then the per-arch manifests it covers — the first
# one is what belongs here.
#
# Dependabot updates these in place under the existing `docker` ecosystem block, no config
# change. Two quirks worth knowing rather than fixing: a digest-only bump renders as "from
# `nonroot` to `nonroot`" because there is no version string to show, and a digest PR that is
# *closed* is not re-offered until the next digest lands upstream — so do not close one expecting
# it back.
#
# Builder and runtime are the same Debian release on purpose (trixie = Debian 13, glibc 2.41,
# Node 24.18.0 in both, verified by running both images). better-sqlite3, bcrypt and Prisma's
# schema-engine are native ELFs compiled in the builder stages and executed in the runtime one;
# a base pair that drifted apart in glibc or in NODE_MODULE_VERSION would break them at boot.
FROM node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS deps
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


FROM node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS builder
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
#   3. TWO OF THE THREE ARE GONE, and the reason they could not go before is worth keeping.
#      This block used to carry TOTP_ENCRYPTION_KEY and RATE_LIMIT_HASH_SECRET as well, and
#      said they were not removable: deleting both had been tried and the build died with
#      `TOTP_ENCRYPTION_KEY is required`, thrown from crypto.ts inside the `analyse` step.
#      That was true while those modules threw from their top-level bodies. They now validate
#      through the boot collector (src/lib/server/env/assertConfigured.ts) and read their key
#      lazily, so nothing evaluates a secret at build time. Re-measured 2026-08-16 rather than
#      reasoned about: a full `docker build` with both lines deleted exits 0.
#
#      Deleting them was not tidying. The wave that moved these checks also gave
#      RATE_LIMIT_HASH_SECRET the 64-hex format check the docs had promised since it existed,
#      and the placeholder above was `docker-build-only-fake-rate-limit-hash-secret-do-not-reuse`
#      — not hex, not 64 characters. Had the check stayed at module level, this build would have
#      failed and the obvious fix would have been to replace that placeholder with something
#      that LOOKS like a real key, in a tracked file, which is exactly what the last line of this
#      comment tells the next person not to do.
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
# With both secret-named ENVs gone, the `# check=skip=` directive at the top of this file may now
# be unnecessary — DATABASE_URL below does not match BuildKit's secret-name patterns. NOT
# measured, so it stays: removing it is a separate claim and needs its own build to confirm the
# warning does not come back.
#
# Do not "solve" the remaining line by moving it to a build ARG (same warning, same non-problem),
# and do not add a secret back here.
ENV DATABASE_URL=file:/tmp/build-placeholder.db

RUN npm run build

# The runtime stage is distroless: no shell, so no RUN, so no `mkdir` and no `chown` there. The
# /data mount point and its ownership by the runtime uid are prepared here and COPYed across.
# Docker seeds a named volume from the image's contents at that path on first use, ownership
# included, which is what lets the app create its SQLite database in a fresh volume.
RUN mkdir -p /out/data && chown 65532:65532 /out/data


FROM node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS prod-deps
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
ENV DATABASE_URL=file:/data/budgetpilot.db

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


# Runtime: Google Distroless Node.js. Debian 13 (trixie) and glibc 2.41, the same release the
# builder stages run, so better-sqlite3, bcrypt and Prisma's schema-engine execute against the
# ABI they were compiled for. What the base contains beyond node: libstdc++/libgcc/libssl3/
# zlib1g, CA certificates, tzdata, /etc/passwd, and a writable /tmp. What it does not contain:
# a shell, /usr/bin/env, npm, a package manager, coreutils. Nothing here can `RUN`.
#
# The :nonroot tag runs as uid/gid 65532 and its ENTRYPOINT is already ["/nodejs/bin/node"], so
# the CMD below is node argv and needs no ENTRYPOINT line of its own — the same shape the slim
# base was given in the previous release, which is why the documented
# `docker compose run --rm budgetpilot scripts/normalize-names.mjs --dry-run` is unaffected.
#
# Debugging: `docker compose exec budgetpilot sh` no longer exists. Use the same base's
# debug-nonroot variant locally (`--entrypoint /busybox/sh`), never in production; see
# docs/operations.md. `docker compose logs budgetpilot` is unchanged.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATABASE_URL=file:/data/budgetpilot.db
# Read by the `prisma migrate deploy` boot.mjs spawns, which inherits this environment. They
# were an inline prefix on the shell entrypoint's command line before there was an image-level
# place to put them. CHECKPOINT_DISABLE suppresses Prisma's version-check request *and the
# cache write it makes into HOME* — that second half is what keeps boot from needing a writable
# home directory, so do not drop it as a mere network optimisation.
ENV CHECKPOINT_DISABLE=1
ENV PRISMA_HIDE_UPDATE_MESSAGE=1

# The apt-get layer the Debian-based runner used to need is gone with the base: ca-certificates
# and openssl are both already in distroless (the schema-engine's libssl.so.3 is satisfied by the
# base's libssl3t64 — proven by executing the engine inside this image, not by reading a package
# list). So are the user and the group, hence no groupadd/useradd either.
#
# /data is the one exception, because a mount point cannot be created without a RUN: the builder
# stage makes it and chowns it to 65532, and it arrives here as a COPY. Docker seeds a fresh
# named volume from this, ownership included.
COPY --from=builder --chown=65532:65532 /out/data /data

# /app stays root-owned, and the runtime user's home is deliberately NOT /app.
#
# Owning the entries is not enough: unlink and rename are governed by the write bit on the
# *parent directory*, not by the ownership of what sits inside it. While the app user owned
# /app it could `mv /app/build /app/build.bak` and put its own there — same for boot.mjs and
# node_modules, root-owned though they are. That turns any RCE in the app into persistence
# across a restart, which is the exact property removing the boot-time `prisma generate` was
# meant to eliminate.
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
COPY --from=builder /app/src/lib/domain/normalize.ts \
	/app/src/lib/domain/money.ts \
	./src/lib/domain/
COPY --from=builder /app/src/lib/server/dbTransaction.ts ./src/lib/server/dbTransaction.ts
COPY --from=builder /app/src/lib/server/database/adapter.ts \
	/app/src/lib/server/database/advisoryLock.ts \
	/app/src/lib/server/database/client.ts \
	/app/src/lib/server/database/minorUnits.ts \
	/app/src/lib/server/database/moneyColumns.ts \
	/app/src/lib/server/database/types.ts \
	./src/lib/server/database/
COPY --from=builder /app/src/lib/server/database/generated ./src/lib/server/database/generated
COPY --from=builder /app/src/lib/server/naming/backfill.ts \
	/app/src/lib/server/naming/mergePlan.ts \
	/app/src/lib/server/naming/nameKey.ts \
	/app/src/lib/server/naming/report.ts \
	./src/lib/server/naming/

# package.json is not documentation here: jwt.ts resolves the project root by walking up to the
# nearest one, so dropping it breaks token signing at runtime.
COPY package.json package-lock.json ./
# No --chmod on either: they are never executed directly, only read by node.
COPY boot.mjs ./boot.mjs
COPY healthcheck.mjs ./healthcheck.mjs

# Restating what the :nonroot tag already sets, on purpose. Removing this line changes nothing
# today — tried, and `docker inspect` still reported 65532 — which is exactly why it stays: it
# is the difference between running unprivileged by intent and by inheritance, and a future
# digest bump onto a tag without the nonroot default would land back on root silently. The
# smoke suite asserts the built image's USER for the same reason, and that assertion was proven
# by setting this to `root` and watching it fail.
USER 65532

EXPOSE 3000

# Exec form, and it has to be: the shell form would need /bin/sh inside the container, and the
# usual `curl -f localhost:3000` is doubly impossible — no curl either. The probe is node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
	CMD ["/nodejs/bin/node", "healthcheck.mjs"]

# No ENTRYPOINT line: the base already sets ["/nodejs/bin/node"], so this is node argv.
CMD ["boot.mjs"]
