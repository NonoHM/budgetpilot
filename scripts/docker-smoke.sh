#!/usr/bin/env bash
# Builds the real Docker image and boots it against every supported database.
#
# This exists because CI cannot otherwise see two whole classes of failure:
#
#   1. The image does not build. CI never builds it — the publish workflow does, on release, and
#      by then the tag is cut. A Dockerfile change once merged green and only failed when someone
#      finally ran `docker build` by hand.
#   2. The three generated Prisma clients do not coexist. Every other job regenerates its own
#      client and proves that one works alone; nothing else ever looks at all three in one
#      artifact. See scripts/assert-generated-clients.sh.
#
# Depth is deliberately capped at boot. The db-matrix job already exercises real read/write
# semantics on PostgreSQL and MariaDB, so repeating that here would buy nothing. What only this
# check can prove is that the *image* starts on each provider — and a served request is already
# strong evidence: adapter-node awaits hooks.server.ts's `init` before it opens the socket, and
# `init` queries the database (bootstrap-token check, two backfills). An HTTP 200 therefore means
# the generated client for that provider loaded and ran real queries against that engine.
#
# Run it locally exactly as CI does:  ./scripts/docker-smoke.sh
# Needs docker and roughly 4 GB of free disk. Cleans up everything it creates, including on
# failure and on Ctrl-C.

set -euo pipefail

IMAGE=${IMAGE:-budgetpilot:smoke}
BUILDER_IMAGE="${IMAGE}-builder"
NETWORK=${NETWORK:-budgetpilot-smoke}
APP_PORT=${APP_PORT:-3999}
BOOT_TIMEOUT=${BOOT_TIMEOUT:-90}

# Throwaway values for containers that live and die inside this script. The two secrets are the
# same shape CI uses elsewhere: 64 hex characters for the TOTP key (crypto.ts decodes it at
# import time and crashes on anything else), any non-empty string for the rest.
DB_USER=budgetpilot
DB_PASSWORD=smoke-only-not-a-real-password
DB_NAME=budgetpilot
TOTP_ENCRYPTION_KEY=c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1
RATE_LIMIT_HASH_SECRET=docker-smoke-only-fake-rate-limit-hash-secret
BOOTSTRAP_TOKEN=docker-smoke-only-fake-bootstrap-token

CREATED_CONTAINERS=()

cleanup() {
	local status=$?
	echo
	echo "--- cleanup ---"
	for container in "${CREATED_CONTAINERS[@]:-}"; do
		[ -n "$container" ] && docker rm -f "$container" >/dev/null 2>&1 || true
	done
	docker network rm "$NETWORK" >/dev/null 2>&1 || true
	docker image rm -f "$IMAGE" "$BUILDER_IMAGE" >/dev/null 2>&1 || true
	exit "$status"
}
trap cleanup EXIT INT TERM

run_container() {
	local name=$1
	shift
	CREATED_CONTAINERS+=("$name")
	docker run -d --name "$name" --network "$NETWORK" "$@" >/dev/null
}

# Waits for a database to accept connections. Both images ship their own probe, and using each
# image's own is the only way to be sure the server is ready rather than merely listening.
wait_for_db() {
	local name=$1
	shift
	for _ in $(seq 1 60); do
		if docker exec "$name" "$@" >/dev/null 2>&1; then
			echo "  $name is ready"
			return 0
		fi
		sleep 2
	done
	docker logs "$name" || true
	echo "FAIL: $name never became ready" >&2
	return 1
}

# ---------------------------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------------------------

echo "=== building $BUILDER_IMAGE (builder stage) ==="
docker build --target builder -t "$BUILDER_IMAGE" .

echo
echo "=== building $IMAGE (final image) ==="
# Reuses every layer from the build above; only the stages after `builder` are new work.
docker build -t "$IMAGE" .

# ---------------------------------------------------------------------------------------------
# Coexistence assertions
# ---------------------------------------------------------------------------------------------

echo
echo "=== asserting all three generated clients exist and are distinct ==="
# Mounted rather than baked in, so the assertions can change without invalidating the build
# cache, and so the same script runs against both stages.
assert_in_image() {
	docker run --rm \
		-v "$PWD/scripts/assert-generated-clients.sh:/assert.sh:ro" \
		--entrypoint sh "$1" /assert.sh "$2"
}

assert_in_image "$BUILDER_IMAGE" dirs
echo
echo "=== asserting the shipped bundle carries all three ==="
assert_in_image "$IMAGE" bundle

# ---------------------------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------------------------

docker network create "$NETWORK" >/dev/null

echo
echo "=== starting throwaway databases ==="
run_container smoke-postgres \
	-e POSTGRES_USER="$DB_USER" \
	-e POSTGRES_PASSWORD="$DB_PASSWORD" \
	-e POSTGRES_DB="$DB_NAME" \
	postgres:17-alpine
run_container smoke-mariadb \
	-e MARIADB_USER="$DB_USER" \
	-e MARIADB_PASSWORD="$DB_PASSWORD" \
	-e MARIADB_DATABASE="$DB_NAME" \
	-e MARIADB_ROOT_PASSWORD="$DB_PASSWORD-root" \
	mariadb:11

wait_for_db smoke-postgres pg_isready -U "$DB_USER" -d "$DB_NAME"
wait_for_db smoke-mariadb healthcheck.sh --connect --innodb_initialized

# One leg per configuration an operator can actually write, not one per provider:
#
#   label | DATABASE_PROVIDER | DATABASE_URL scheme | resolves to
#   ------|-------------------|---------------------|------------
#   1     | (unset)           | file:               | sqlite      the zero-config default
#   2     | postgresql        | postgresql:         | postgresql
#   3     | mysql             | mysql:              | mysql
#   4     | mariadb           | mariadb:            | mysql
#
# Leg 4 is not redundant. `mariadb` is an accepted DATABASE_PROVIDER and `mariadb://` an accepted
# URL scheme, so an operator running MariaDB writes both — and that combination used to boot the
# app cleanly and then die at `prisma migrate deploy` with P1013, an error naming neither
# variable. See toPrismaConnectionUrl in src/lib/server/database/provider.ts.
LEGS=(
	"sqlite||file:/data/dev.db"
	"postgresql|postgresql|postgresql://__USER__:__PASSWORD__@smoke-postgres:5432/__DB__"
	"mysql|mysql|mysql://__USER__:__PASSWORD__@smoke-mariadb:3306/__DB__"
	"mariadb|mariadb|mariadb://__USER__:__PASSWORD__@smoke-mariadb:3306/__DB__"
)

for leg in "${LEGS[@]}"; do
	IFS='|' read -r label provider url_template <<<"$leg"

	url=${url_template//__USER__/$DB_USER}
	url=${url//__PASSWORD__/$DB_PASSWORD}
	url=${url//__DB__/$DB_NAME}

	# What the app is expected to *resolve* the provider to, which is what the startup log
	# prints. "mariadb" is an alias for "mysql"; an empty DATABASE_PROVIDER defaults to sqlite.
	expected_provider=${provider:-sqlite}
	[ "$expected_provider" = "mariadb" ] && expected_provider=mysql

	# Left unset on the sqlite leg on purpose: that is the zero-config default an existing
	# install runs on, and passing it explicitly would stop testing the default.
	provider_args=()
	[ -n "$provider" ] && provider_args=(-e "DATABASE_PROVIDER=$provider")

	echo
	echo "=== leg: $label (DATABASE_PROVIDER=${provider:-<unset>}, ${url%%:*}:// URL) ==="

	app="smoke-app-$label"
	run_container "$app" \
		-p "127.0.0.1:$APP_PORT:3000" \
		"${provider_args[@]}" \
		-e DATABASE_URL="$url" \
		-e ORIGIN="http://127.0.0.1:$APP_PORT" \
		-e PUBLIC_INSTANCE=false \
		-e TOTP_ENCRYPTION_KEY="$TOTP_ENCRYPTION_KEY" \
		-e RATE_LIMIT_HASH_SECRET="$RATE_LIMIT_HASH_SECRET" \
		-e BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
		"$IMAGE"

	ready=false
	for _ in $(seq 1 "$BOOT_TIMEOUT"); do
		if [ "$(docker inspect -f '{{.State.Running}}' "$app")" != "true" ]; then
			break
		fi
		# Connection refused/reset is the expected state while the container is still running
		# migrations, so the poll stays quiet and lets the timeout report the failure.
		if curl -fs -o /dev/null "http://127.0.0.1:$APP_PORT/login" 2>/dev/null; then
			ready=true
			break
		fi
		sleep 1
	done

	logs=$(docker logs "$app" 2>&1 || true)

	if [ "$ready" != true ]; then
		echo "$logs"
		echo "FAIL: the image never served /login on the $label leg" >&2
		exit 1
	fi

	# migrate deploy runs at boot, before the server starts. Its output is the only proof the
	# provider's own migration history applied to this engine rather than being skipped.
	if ! grep -qE 'migration(s)? have been successfully applied|No pending migrations' <<<"$logs"; then
		echo "$logs"
		echo "FAIL: no evidence that migrate deploy ran on the $label leg" >&2
		exit 1
	fi

	# The startup line reports which client actually loaded. An alias resolving to the wrong
	# engine would otherwise be invisible: the app would start and quietly use another schema.
	if ! grep -q "database-provider=$expected_provider" <<<"$logs"; then
		echo "$logs"
		echo "FAIL: startup log does not report database-provider=$expected_provider" >&2
		exit 1
	fi

	echo "  ok: migrations applied, served /login, reported database-provider=$expected_provider"

	# Freed before the next leg so the published port is available again.
	docker rm -f "$app" >/dev/null
done

echo
echo "=== docker smoke passed on all ${#LEGS[@]} legs ==="
