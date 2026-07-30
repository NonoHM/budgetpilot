#!/bin/sh
set -e

# No code generation at boot. The image carries a generated Prisma client for every supported
# provider, built into ./build, and the app selects one at runtime from DATABASE_PROVIDER.
# Earlier versions regenerated here for anything but SQLite, which is why the image had to leave
# node_modules/.prisma writable by the app user — write access to code that is then executed.
# Nothing in the runtime image is writable to the app user now except /data.
#
# migrate deploy still runs per boot, and still reads the schema and migration history for
# DATABASE_PROVIDER through prisma.config.ts. It writes to the database, never to the image.
npx prisma migrate deploy

exec node build
