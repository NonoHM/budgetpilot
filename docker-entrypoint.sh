#!/bin/sh
set -e

# No code generation at boot. The image carries a generated Prisma client for every supported
# provider, built into ./build, and the app selects one at runtime from DATABASE_PROVIDER.
# Earlier versions regenerated here for anything but SQLite, which is why the image had to leave
# node_modules/.prisma writable by the app user — write access to code that is then executed.
# /data is the only thing the app user can write to now.
#
# migrate deploy still runs per boot, and still reads the schema and migration history for
# DATABASE_PROVIDER through prisma.config.ts. It writes to the database, never to the image.
#
# The local binary rather than `npx`: npx's documented behaviour when it cannot resolve a
# package is to fetch it from the registry and run it, which is a code-execution path at
# container start that depends on the network. `prisma` is a production dependency, so npx
# resolved it locally in practice, but naming the path removes the fallback entirely.
# CHECKPOINT_DISABLE suppresses Prisma's version-check request and the cache write it makes
# into HOME, so nothing at boot needs a writable home directory.
CHECKPOINT_DISABLE=1 ./node_modules/.bin/prisma migrate deploy

exec node build
