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

RUN npx prisma generate

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

RUN npx prisma generate


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

COPY --from=prod-deps /app/node_modules ./node_modules
# The generated Prisma client is writable by the app user, so the entrypoint can regenerate it
# when DATABASE_PROVIDER is not sqlite: the client shipped here was generated for the default
# schema, and Prisma refuses an adapter that does not match it.
#
# Be clear about what this grants. `.prisma/client` is not data, it is code that
# `@prisma/client` requires on every boot, so this is write access to something that then
# executes. It is scoped to that one directory rather than `--chown` on the whole COPY, and the
# packages under node_modules stay root-owned.
#
# It is not, however, the tightest thing in this image: `chown -R app:app /app` above owns the
# /app directory itself, and write permission on a directory allows replacing the entries in it
# whoever owns them. Tightening that is worth doing and is deliberately not bundled into this
# change, because the boot-time `npx prisma generate` needs a writable HOME (which is /app) and
# moving it wants an image build to verify.
#
# The alternative that avoids the grant entirely, an image built per provider, would break the
# operator contract this feature exists to keep: two environment variables, nothing else.
RUN chown -R app:app /app/node_modules/.prisma
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