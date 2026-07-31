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

# Fixed, not overridable. `cleanup` force-removes both images on every exit path including
# Ctrl-C, so an `IMAGE=` override would let `IMAGE=budgetpilot:latest ./scripts/docker-smoke.sh`
# destroy a real local image. Nothing needs the override.
IMAGE=budgetpilot:smoke
BUILDER_IMAGE="${IMAGE}-builder"
NETWORK=budgetpilot-smoke
APP_PORT=${APP_PORT:-3999}
BOOT_TIMEOUT=${BOOT_TIMEOUT:-90}

# Throwaway values for containers that live and die inside this script. The two secrets are the
# same shape CI uses elsewhere: 64 hex characters for the TOTP key (crypto.ts decodes it at
# import time and crashes on anything else), any non-empty string for the rest.
#
# Hardcoded rather than `${DB_PASSWORD:-…}`, and that is load-bearing: on failure this script
# echoes container logs into what is a public CI log on pull requests, and a connection string
# is the one thing that can appear there. Do not "harmonise" these into env overrides — a local
# run against a real database would then dump a real password. redact() below is the second
# layer, not the only one.
DB_USER=budgetpilot
DB_PASSWORD=smoke-only-not-a-real-password
DB_NAME=budgetpilot
TOTP_ENCRYPTION_KEY=c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1
RATE_LIMIT_HASH_SECRET=docker-smoke-only-fake-rate-limit-hash-secret
BOOTSTRAP_TOKEN=docker-smoke-only-fake-bootstrap-token

# Strips `user:password@` out of any URL-shaped thing before it reaches stdout. The app itself
# never logs a connection string, but a driver's own parse error does — see toDriverConnectionUrl
# in src/lib/server/database/provider.ts — and that error is exactly what a failing leg would
# dump here.
redact() {
	sed -E 's#([a-z][a-z0-9+.-]*://)[^@/[:space:]]*@#\1***:***@#gi'
}

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
	docker logs "$name" 2>&1 | redact || true
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

# The name-normalization preview, run for real against an empty throwaway database.
#
# docs/operations.md hands an operator exactly this command to read what the one-time name merge
# will do before they upgrade, and hooks.server.ts prints it when the backfill leaves groups it
# refused to merge. It shipped broken for two releases: `scripts/` was not in the runner stage,
# so it failed with MODULE_NOT_FOUND on every Docker install and nothing noticed, because nothing
# else in the image loads those modules.
#
# It stays that way unless something runs it. The script imports the app's own modules through
# relative paths, so adding an import without adding the file to the Dockerfile breaks it again
# and only this step says so. An empty database is enough: the failure being guarded against is
# resolution, not the plan.
echo
echo "=== asserting the documented dry run works in the image ==="
docker run --rm \
	-e DATABASE_PROVIDER=sqlite \
	-e DATABASE_URL=file:/data/smoke.db \
	--entrypoint sh "$IMAGE" -c \
	'./node_modules/.bin/prisma migrate deploy >/dev/null && npm run db:normalize-names -- --dry-run' \
	| tail -n 20

# The builder stage's throwaway values do not reach the shipped image.
#
# The Dockerfile carries `# check=skip=SecretsUsedInArgOrEnv`, because BuildKit fires that check
# on `ENV TOTP_ENCRYPTION_KEY=` and `ENV RATE_LIMIT_HASH_SECRET=` on the strength of the names
# alone, and those two are literal build-only constants that SvelteKit's postbuild `analyse` step
# cannot start without. The skip is file-wide — BuildKit has no per-line form — so on its own it
# would also hide a real leak added later. This is the replacement: it asserts the property the
# check was standing in for, against the built artefact rather than against the instruction.
#
# The values are read out of the Dockerfile rather than repeated here, so editing one there
# cannot leave a stale literal passing here by accident. The count is asserted for the same
# reason: an awk range that stops matching would otherwise scan nothing and report success.
echo
echo "=== asserting no build-time value reaches the final image ==="
mapfile -t BUILD_ONLY_ENV < <(
	awk '
		/^FROM .* AS builder$/ { in_builder = 1; next }
		/^FROM / { in_builder = 0 }
		in_builder && /^ENV [A-Za-z_][A-Za-z0-9_]*=/ { sub(/^ENV /, ""); print }
	' Dockerfile
)

if [ "${#BUILD_ONLY_ENV[@]}" -lt 3 ]; then
	echo "FAIL: expected at least 3 ENV lines in the builder stage, found ${#BUILD_ONLY_ENV[@]}." >&2
	echo "      The Dockerfile moved them; update this assertion rather than deleting it." >&2
	exit 1
fi

image_config=$(docker inspect "$IMAGE")
image_history=$(docker history --no-trunc "$IMAGE")
leaked=0

for pair in "${BUILD_ONLY_ENV[@]}"; do
	name=${pair%%=*}
	value=${pair#*=}

	# The runner stage sets DATABASE_URL to its own runtime default, so only the builder's
	# placeholder value is ever searched for, never the variable name.
	for surface in config history; do
		case $surface in
			config) haystack=$image_config ;;
			history) haystack=$image_history ;;
		esac
		# A here-string, not `printf … | grep -qF`. Under `set -o pipefail` that pipeline
		# reports failure on a *match*: grep -q exits the moment it finds one, printf is
		# still writing, and the SIGPIPE it takes becomes the pipeline's status. The small
		# `docker inspect` output fits the pipe buffer and matched fine; the 90 KB of
		# `docker history` did not, so the leak this is here to catch went unreported.
		# Found by planting a leak on purpose and noticing only one of two surfaces failed.
		if grep -qF -- "$value" <<<"$haystack"; then
			echo "FAIL: builder-stage $name reached the final image's $surface." >&2
			leaked=1
		fi
	done

	# As root, not as the image's `app` user: /app is deliberately root-owned and the scan
	# must not mistake "cannot read it" for "nothing in it".
	if ! docker run --rm --user 0 --entrypoint sh "$IMAGE" -c \
		'grep -rqF -- "$1" /app 2>/dev/null && exit 1 || exit 0' sh "$value"; then
		echo "FAIL: builder-stage $name was found in the final image's filesystem under /app." >&2
		leaked=1
	fi
done

if [ "$leaked" -ne 0 ]; then
	echo "A build-time value is baked into the shipped image. Do not silence this by widening" >&2
	echo "the check=skip directive in the Dockerfile: this is the leak that skip assumes away." >&2
	exit 1
fi

echo "  ok: ${#BUILD_ONLY_ENV[@]} builder-stage values, none in the image's env, history or /app"

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

	# Redacted at capture, not at each echo below, so there is no unredacted copy in scope for a
	# later edit to print by accident. Redaction touches only `scheme://user:pass@`, which none
	# of the three assertions below match on.
	logs=$(docker logs "$app" 2>&1 | redact || true)

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

# ---------------------------------------------------------------------------------------------
# boot.mjs: the two properties the four legs above cannot see
# ---------------------------------------------------------------------------------------------

# The legs prove the happy path. They would keep passing if boot.mjs started the server anyway
# after a failed migration — which is exactly what the shell entrypoint's `set -e` used to
# prevent and what a JavaScript rewrite has to re-establish by hand. Serving requests against a
# schema the migration failed to apply is the failure this guards: the app would answer, and
# answer wrongly.
#
# The exit code alone is NOT evidence here, and this was watched rather than assumed: with the
# exit-code check in boot.mjs disabled on purpose, the container still exited non-zero — the
# server started, hooks.server.ts's init queried the same unreachable database, and the process
# died a few seconds later. A "container exited non-zero" assertion goes green on a boot.mjs
# that no longer refuses anything. What separates the two is which of them decided: boot.mjs
# saying so before the import, with no adapter-node line after it.
echo
echo "=== asserting a failed migration aborts boot ==="
failpath_app=smoke-app-failpath
CREATED_CONTAINERS+=("$failpath_app")
set +e
timeout 120 docker run --name "$failpath_app" --network "$NETWORK" \
	-e DATABASE_PROVIDER=postgresql \
	-e DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@no-such-host:5432/$DB_NAME" \
	-e ORIGIN="http://127.0.0.1:$APP_PORT" \
	-e PUBLIC_INSTANCE=false \
	-e TOTP_ENCRYPTION_KEY="$TOTP_ENCRYPTION_KEY" \
	-e RATE_LIMIT_HASH_SECRET="$RATE_LIMIT_HASH_SECRET" \
	-e BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
	"$IMAGE" >/dev/null 2>&1
failpath_status=$?
set -e
failpath_logs=$(docker logs "$failpath_app" 2>&1 | redact || true)

if [ "$failpath_status" -eq 124 ]; then
	echo "$failpath_logs"
	echo "FAIL: the container hung with an unreachable database instead of exiting" >&2
	exit 1
fi
if [ "$failpath_status" -eq 0 ]; then
	echo "$failpath_logs"
	echo "FAIL: the container exited 0 with an unreachable database — a failed migrate deploy no longer aborts boot" >&2
	exit 1
fi
if ! grep -q 'refusing to start' <<<"$failpath_logs"; then
	echo "$failpath_logs"
	echo "FAIL: boot.mjs did not refuse to start after migrate deploy failed; whatever exited, it was not the guard" >&2
	exit 1
fi
# adapter-node prints this once it holds the socket. Its absence is what proves the import
# below the guard never ran, rather than having run and crashed on its own.
if grep -q 'Listening on' <<<"$failpath_logs"; then
	echo "$failpath_logs"
	echo "FAIL: the server started despite a failed migrate deploy" >&2
	exit 1
fi
echo "  ok: refused to start, never listened, exited $failpath_status"
docker rm -f "$failpath_app" >/dev/null

# The container has to stop on SIGTERM by draining, not by being killed 10 seconds later.
# `exec node build` gave that for free: node was PID 1 and adapter-node's own SIGTERM handler
# ran. boot.mjs keeps node as PID 1 and starts the server by *importing* the build output, in
# the same process, precisely so that stays true — a version that spawned the server as a child
# would look identical here until docker stop, and then take the full timeout and get SIGKILLed.
echo
echo "=== asserting SIGTERM stops the container promptly (no SIGKILL) ==="
term_app=smoke-app-sigterm
run_container "$term_app" \
	-p "127.0.0.1:$APP_PORT:3000" \
	-e DATABASE_URL="file:/data/dev.db" \
	-e ORIGIN="http://127.0.0.1:$APP_PORT" \
	-e PUBLIC_INSTANCE=false \
	-e TOTP_ENCRYPTION_KEY="$TOTP_ENCRYPTION_KEY" \
	-e RATE_LIMIT_HASH_SECRET="$RATE_LIMIT_HASH_SECRET" \
	-e BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
	"$IMAGE"

ready=false
for _ in $(seq 1 "$BOOT_TIMEOUT"); do
	if curl -fs -o /dev/null "http://127.0.0.1:$APP_PORT/login" 2>/dev/null; then
		ready=true
		break
	fi
	sleep 1
done
if [ "$ready" != true ]; then
	docker logs "$term_app" 2>&1 | redact || true
	echo "FAIL: the SIGTERM leg never served /login" >&2
	exit 1
fi

# Well above a clean drain and well under docker's own 10s default, so a container that ignores
# the signal is reported by this script rather than silently SIGKILLed by docker.
stop_started=$SECONDS
docker stop --timeout 30 "$term_app" >/dev/null
stop_elapsed=$((SECONDS - stop_started))
term_status=$(docker inspect -f '{{.State.ExitCode}}' "$term_app")

if [ "$term_status" -eq 137 ]; then
	echo "FAIL: the container ignored SIGTERM and was SIGKILLed (exit 137)" >&2
	exit 1
fi
if [ "$stop_elapsed" -ge 10 ]; then
	echo "FAIL: SIGTERM took ${stop_elapsed}s to stop the container; the handler is not draining" >&2
	exit 1
fi
echo "  ok: stopped in ${stop_elapsed}s with exit code $term_status"
docker rm -f "$term_app" >/dev/null

echo
echo "=== docker smoke passed on all ${#LEGS[@]} legs ==="
