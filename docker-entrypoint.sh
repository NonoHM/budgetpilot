#!/bin/sh
set -e

# The published image ships a Prisma client generated for SQLite, the zero-config default.
# That client is provider-specific: it embeds the schema it was generated from, and Prisma
# refuses a driver adapter that does not match it. An operator running PostgreSQL or MySQL
# therefore needs a client generated for their schema, and the operator contract is two
# environment variables and nothing else, so the image has to produce it itself.
#
# Only when the provider is not the default, so a SQLite install pays nothing and boots exactly
# as it did before multi-database support existed. `prisma generate` reads the schema for
# DATABASE_PROVIDER through prisma.config.ts, needs no network, and writes only to
# node_modules/.prisma (the one directory this image leaves writable to the app user).
if [ -n "${DATABASE_PROVIDER}" ] && [ "${DATABASE_PROVIDER}" != "sqlite" ]; then
	echo "DATABASE_PROVIDER=${DATABASE_PROVIDER}: generating the Prisma client for this database"
	npx prisma generate
fi

npx prisma migrate deploy

exec node build
