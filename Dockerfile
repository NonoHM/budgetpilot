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
# Linters (e.g. Docker Scout) may flag these as "sensitive data in ENV" — false positive
# for this specific case: they're declared ONLY in this `builder` stage, which the final
# `runner` stage below never derives FROM (it starts its own `FROM node:...`) and never
# COPYs anything from except the compiled `build` output, `prisma`, and `prisma.config.ts`
# — never the builder's image config/layers. Verified empirically via `docker inspect
# --format '{{json .Config.Env}}'` and `docker history --no-trunc` on a locally built
# image: neither value (nor this stage's placeholder DATABASE_URL) appears anywhere in
# the final `runner` image's env or layer history. Do not "fix" this by moving them to
# build ARGs or otherwise restructuring — there is nothing to fix, only document.
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
	&& useradd --system --gid app --home /app app \
	&& mkdir -p /data \
	&& chown -R app:app /app /data

# node_modules is root-owned and stays that way: nothing in this image regenerates code at
# boot any more, so the app user never needs to write to anything it will later execute. The
# three provider clients arrive compiled inside ./build below.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# Same reason as the prod-deps stage: the CMD below runs `prisma migrate deploy`, which loads
# prisma.config.ts, which imports this module to pick the provider's migration history.
COPY --from=builder /app/src/lib/server/database/provider.ts ./src/lib/server/database/provider.ts
COPY package.json package-lock.json ./
COPY --chmod=555 docker-entrypoint.sh ./docker-entrypoint.sh

USER app

EXPOSE 3000

CMD ["./docker-entrypoint.sh"]