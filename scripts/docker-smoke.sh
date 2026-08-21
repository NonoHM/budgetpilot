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
# Both key-shaped values are 64 hex characters because the app now REFUSES anything else, and
# this script boots the real image. RATE_LIMIT_HASH_SECRET used to be the readable sentence
# "docker-smoke-only-fake-rate-limit-hash-secret", which was legible and is exactly what the
# check refuses: the value is used directly as an HMAC-SHA256 key, so its length is the key
# strength. `deadbeef` repeated is the compromise — valid hex, and nobody mistakes it for real.
# BOOTSTRAP_TOKEN stays a sentence: it is an opaque shared secret with no format, not a key.
TOTP_ENCRYPTION_KEY=c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1
RATE_LIMIT_HASH_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef
BOOTSTRAP_TOKEN=docker-smoke-only-fake-bootstrap-token

# The runtime posture docker-compose.yml and docker-compose.prebuilt.yml declare, applied to
# every container this script starts from the app image. Not just to one leg: the claim is that
# the app works this way on every provider, and migrate deploy, the two boot backfills and the
# advisory lock all run before a leg answers /login.
#
# Kept as one array so the smoke run and the Compose files cannot drift apart quietly — if a
# flag is ever added back to Compose it belongs here too, and the write probes below say what
# the kernel then actually does about it.
HARDENED=(
	--read-only
	--tmpfs /tmp
	--cap-drop ALL
	--security-opt no-new-privileges
)

# Strips `user:password@` out of any URL-shaped thing before it reaches stdout. The app itself
# never logs a connection string, but a driver's own parse error does — see toDriverConnectionUrl
# in src/lib/server/database/provider.ts — and that error is exactly what a failing leg would
# dump here.
redact() {
	sed -E 's#([a-z][a-z0-9+.-]*://)[^@/[:space:]]*@#\1***:***@#gi'
}

CREATED_CONTAINERS=()
# Image filesystems get extracted here for the host-side assertions, and the dry run below needs
# a scratch volume. Both are cleaned up on every exit path, including Ctrl-C.
WORK_DIR=$(mktemp -d)
DRY_RUN_VOLUME=budgetpilot-smoke-dryrun
UPGRADE_VOLUME=budgetpilot-smoke-upgrade
RENAME_VOLUME=budgetpilot-smoke-rename
# /data has to be a mounted volume now, not a directory in the image's own filesystem: the
# containers below run --read-only, so the image's /data is read-only like everything else. That
# is exactly how the Compose files run it (`budgetpilot_data:/data`), and it is the reason the
# hardened posture does not lock SQLite out — but it does mean a leg that forgets the mount fails
# with a clear message from boot.mjs rather than working by accident.
DATA_VOLUME=budgetpilot-smoke-data

cleanup() {
	local status=$?
	echo
	echo "--- cleanup ---"
	for container in "${CREATED_CONTAINERS[@]:-}"; do
		[ -n "$container" ] && docker rm -f "$container" >/dev/null 2>&1 || true
	done
	docker network rm "$NETWORK" >/dev/null 2>&1 || true
	docker volume rm -f "$DRY_RUN_VOLUME" "$UPGRADE_VOLUME" "$RENAME_VOLUME" "$DATA_VOLUME" \
		>/dev/null 2>&1 || true
	docker image rm -f "$IMAGE" "$BUILDER_IMAGE" >/dev/null 2>&1 || true
	rm -rf "$WORK_DIR"
	exit "$status"
}
trap cleanup EXIT INT TERM

# Copies an image's filesystem onto the host — all of it, or one path out of it — so that the
# assertions below run here rather than inside the image under test. They then need nothing
# (no sh, no grep, no coreutils) in that image, which is what makes a distroless image as
# assertable as a Debian one. `docker export` flattens the final filesystem, which is also the
# honest artifact: it is what a container actually sees.
#
# The whole-filesystem form is used where the claim is about the whole filesystem (the leak
# scan). Where the claim is about one directory, the third argument copies just that: the
# builder stage is several gigabytes and writing all of it to disk to read one tree is how a
# CI runner runs out of space.
extract_from_image() {
	local image=$1 dest=$2 path=${3:-}
	local cid
	cid=$(docker create "$image")

	if [ -n "$path" ]; then
		mkdir -p "$(dirname "$dest")"
		docker cp "$cid:$path" "$dest" >/dev/null
	else
		mkdir -p "$dest"
		docker export "$cid" | tar -x -C "$dest"
	fi
	docker rm "$cid" >/dev/null

	# An extraction that quietly produced nothing would make every assertion below pass by
	# finding nothing — the "scanned nothing, reported success" failure this repo has already
	# had once, in the awk range that feeds the leak scan.
	if [ -z "$(ls -A "$dest" 2>/dev/null)" ]; then
		echo "FAIL: extracting ${path:-the filesystem} from $image produced an empty tree" >&2
		exit 1
	fi

	# Everything here is owned by us, so this always succeeds, and it removes the one way a
	# host-side scan can be weaker than the in-container one it replaces: a file the archive
	# stored unreadable would otherwise be skipped, and "cannot read it" would be silently
	# counted as "nothing in it".
	chmod -R u+rwX "$dest"
}

# A fresh, empty /data for whichever container is about to run. Recreated rather than emptied,
# because emptying it would need a shell somewhere and this is the cheaper honest option.
fresh_data_volume() {
	docker volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
	docker volume create "$DATA_VOLUME" >/dev/null
}

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

# The final image's whole filesystem, extracted once and read twice: by the bundle assertion
# just below and by the leak scan further down.
IMAGE_ROOTFS="$WORK_DIR/image-rootfs"
BUILDER_ROOTFS="$WORK_DIR/builder-rootfs"
extract_from_image "$IMAGE" "$IMAGE_ROOTFS"
# Only the generated tree is needed out of the builder, and the builder is the big stage.
extract_from_image "$BUILDER_IMAGE" \
	"$BUILDER_ROOTFS/app/src/lib/server/database/generated" \
	/app/src/lib/server/database/generated

echo
echo "=== asserting all three generated clients exist and are distinct ==="
./scripts/assert-generated-clients.sh dirs "$BUILDER_ROOTFS"
echo
echo "=== asserting the shipped bundle carries all three ==="
./scripts/assert-generated-clients.sh bundle "$IMAGE_ROOTFS"

# ---------------------------------------------------------------------------------------------
# The distroless base's properties, each proven the way it can actually fail
# ---------------------------------------------------------------------------------------------

# "There is no shell in the image" is a claim about what can be executed, so it is asserted by
# trying to execute one, not only by looking for the files. The two halves catch different
# things: a shell added back by a future COPY or base change shows up in the file scan, and a
# shell reachable under a name nobody listed shows up in the exec attempt. `stat` said one thing
# and `mv` said another once already in this repo; only the attempt is evidence.
echo
echo "=== asserting the final image has no shell ==="
for candidate in bin/sh bin/bash bin/dash usr/bin/sh usr/bin/bash usr/bin/env busybox/sh; do
	if [ -e "$IMAGE_ROOTFS/$candidate" ]; then
		echo "FAIL: the final image contains /$candidate" >&2
		exit 1
	fi
done
for entrypoint in /bin/sh /bin/bash /busybox/sh /usr/bin/env; do
	set +e
	docker run --rm --entrypoint "$entrypoint" "$IMAGE" -c true >/dev/null 2>&1
	shell_status=$?
	set -e
	if [ "$shell_status" -eq 0 ]; then
		echo "FAIL: $entrypoint executed inside the final image" >&2
		exit 1
	fi
done
echo "  ok: no shell on disk, and none of 4 candidate interpreters can be executed"

# What boot.mjs needs in order to migrate, and the uid it runs as.
#
# node_modules/prisma/build/index.js is the CLI's declared bin entry rather than a documented
# API surface, and it is the one unversioned assumption in the boot path: a future Prisma
# release that moved it would break every container start, at boot, in production. Asserting
# the file exists turns that into a build-time failure here instead.
echo
echo "=== asserting the migrate path and runtime uid survive the base swap ==="
[ -f "$IMAGE_ROOTFS/app/node_modules/prisma/build/index.js" ] \
	|| { echo "FAIL: prisma CLI bin entry missing. Check prisma's package.json \"bin\" mapping" >&2; exit 1; }
[ -x "$IMAGE_ROOTFS/app/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x" ] \
	|| { echo "FAIL: the schema-engine binary is missing or not executable in the image" >&2; exit 1; }
image_user=$(docker inspect --format '{{.Config.User}}' "$IMAGE")
[ "$image_user" = "65532" ] \
	|| { echo "FAIL: image USER is '$image_user', expected 65532" >&2; exit 1; }
# /data has to arrive owned by the runtime uid: a fresh named volume inherits its ownership from
# the image, and that inheritance is the only reason a zero-config SQLite install can write.
#
# Asked of a running container rather than of $IMAGE_ROOTFS, and that is not a style choice: the
# export is unpacked by an unprivileged user, so every file in it belongs to whoever ran this
# script. Ownership is one of the few things the extracted tree cannot answer — no permission or
# ownership assertion belongs there.
data_owner=$(docker run --rm "$IMAGE" \
	-e 'const s = require("node:fs").statSync("/data"); console.log(`${s.uid}:${s.gid}`)')
[ "$data_owner" = "65532:65532" ] \
	|| { echo "FAIL: /data in the image is owned by $data_owner, expected 65532:65532" >&2; exit 1; }
echo "  ok: prisma CLI entry, schema engine, USER 65532, /data owned by 65532:65532"

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
#
# This one stays a real execution in a live container, and deliberately so: it is the only check
# here whose subject is that the command *runs*. Asserting the file's presence in the extracted
# rootfs — which is what the two assertions above do, correctly, for their own subject — would
# be strictly weaker than what it replaces. scripts/normalize-names.mjs was present in the image
# throughout the two releases in which this command was broken.
#
# What changed is only the shell: the migrate step and the dry run are now two runs against the
# node entrypoint, sharing one throwaway volume, with no `sh -c` and no `npm` between them.
echo
echo "=== asserting the documented dry run works in the image ==="
docker volume create "$DRY_RUN_VOLUME" >/dev/null
dry_run_env=(-e DATABASE_PROVIDER=sqlite -e DATABASE_URL=file:/data/smoke.db)
# The Prisma CLI at its declared bin entry, not node_modules/.bin/prisma: that shim is a
# `#!/usr/bin/env node` script, and the image this will soon be has no /usr/bin/env. Same
# invocation boot.mjs makes.
docker run --rm "${HARDENED[@]}" -v "$DRY_RUN_VOLUME:/data" "${dry_run_env[@]}" \
	"$IMAGE" node_modules/prisma/build/index.js migrate deploy >/dev/null
# The published command from docs/operations.md, verbatim after `docker run`. A named volume
# inherits /data's ownership from the image, so the `app` user can write to it; if that ever
# stopped being true this run would be the thing that says so.
docker run --rm "${HARDENED[@]}" -v "$DRY_RUN_VOLUME:/data" "${dry_run_env[@]}" \
	"$IMAGE" scripts/normalize-names.mjs --dry-run \
	| tail -n 20
docker volume rm "$DRY_RUN_VOLUME" >/dev/null

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

# Pinned as an EXACT SET, where this used to be "at least 3".
#
# The builder stage also carried TOTP_ENCRYPTION_KEY and RATE_LIMIT_HASH_SECRET placeholders,
# because those modules validated at module load and `npm run build` could not run without them.
# They now validate through the boot collector (src/lib/server/env/assertConfigured.ts) and read
# their keys lazily, so nothing evaluates a secret at build time, and both lines were deleted.
# Measured rather than assumed: a full `docker build` with them gone exits 0.
#
# The floor's job was to stop the leak loop below from silently iterating over an empty list once
# the Dockerfile moved things. An exact set does that AND fails when an ENV is ADDED back, which
# is the direction that matters now: the file-wide `# check=skip=` directive in the Dockerfile
# means BuildKit will no longer warn about a secret-looking name, so this assertion is what is
# left watching. Keep them together.
if [ "${#BUILD_ONLY_ENV[@]}" -ne 1 ]; then
	echo "FAIL: expected exactly 1 ENV line in the builder stage, found ${#BUILD_ONLY_ENV[@]}." >&2
	echo "      Added one? Add it here too, and make sure it is not a secret: the Dockerfile's" >&2
	echo "      check=skip directive means BuildKit will not warn you about the name." >&2
	echo "      Removed one? Update this assertion rather than deleting it." >&2
	exit 1
fi

if [ "${BUILD_ONLY_ENV[0]%%=*}" != "DATABASE_URL" ]; then
	echo "FAIL: expected the builder's only ENV to be DATABASE_URL, found ${BUILD_ONLY_ENV[0]%%=*}." >&2
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

	# The filesystem surface, scanned on the host over the *whole* extracted root rather than
	# in-image over /app. Both halves of that are improvements and neither is cosmetic: the
	# scan no longer needs a shell in the image under test, and it now covers everything a
	# container would see — a value written outside /app used to be invisible to it. The
	# extraction made every file readable by us, so there is no "cannot read it" hole left for
	# the old `--user 0` to have covered.
	if grep -rqF -- "$value" "$IMAGE_ROOTFS"; then
		echo "FAIL: builder-stage $name was found in the final image's filesystem." >&2
		leaked=1
	fi
done

if [ "$leaked" -ne 0 ]; then
	echo "A build-time value is baked into the shipped image. Do not silence this by widening" >&2
	echo "the check=skip directive in the Dockerfile: this is the leak that skip assumes away." >&2
	exit 1
fi

echo "  ok: ${#BUILD_ONLY_ENV[@]} builder-stage values, none in the image's env, history or filesystem"

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
	"sqlite||file:/data/budgetpilot.db"
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
	fresh_data_volume
	run_container "$app" \
		"${HARDENED[@]}" \
		-v "$DATA_VOLUME:/data" \
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
	"${HARDENED[@]}" \
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
	echo "FAIL: the container exited 0 with an unreachable database, so a failed migrate deploy no longer aborts boot" >&2
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

# What the hardening flags actually do, asked of the kernel rather than of Compose.
#
# check-compose-combinations.sh asserts every documented stack is *written* this way. It cannot
# assert what happens next, and the two questions have different answers often enough that this
# repo has a rule about it: a protection claim is verified by attempting the thing it forbids.
# `stat` once said node_modules was unwritable while `mv` renamed the whole tree.
#
# So: write to a path in the read-only root, expecting EROFS; write to the two paths that must
# stay writable, expecting success; and read the capability sets and NoNewPrivs out of
# /proc/self/status. All of it through the node entrypoint — there is no shell to run a probe in.
#
# Ownership is asked here too, for a reason worth keeping written down: it cannot be asked of
# the extracted rootfs at all. `docker export | tar -x` as an unprivileged user re-owns every
# file to whoever ran the script, so the export can answer "does this file exist" and never
# "who owns it".
echo
echo "=== asserting the hardened posture holds inside a running container ==="
probe_app=smoke-app-hardened
fresh_data_volume
run_container "$probe_app" \
	"${HARDENED[@]}" \
	-v "$DATA_VOLUME:/data" \
	-e DATABASE_URL="file:/data/budgetpilot.db" \
	-e ORIGIN="http://127.0.0.1:$APP_PORT" \
	-e PUBLIC_INSTANCE=false \
	-e TOTP_ENCRYPTION_KEY="$TOTP_ENCRYPTION_KEY" \
	-e RATE_LIMIT_HASH_SECRET="$RATE_LIMIT_HASH_SECRET" \
	-e BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
	"$IMAGE"

# The container has to be up before docker exec can reach it; /login is not needed here, only a
# live process, so this waits on the process rather than on the port.
#
# The explicit "did it stay up" check below is not ceremony. Without it, a container that exits
# during this wait turns every probe into `Error response from daemon: container … is not
# running`, and the script dies on that instead of on anything it was asserting — which is what
# happened while breaking this check on purpose with --user 0. Worth knowing why that exits, and
# it is not obvious: --cap-drop ALL removes CAP_DAC_OVERRIDE, so uid 0 loses its usual right to
# ignore file permissions and cannot write a /data owned by 65532 either.
for _ in $(seq 1 "$BOOT_TIMEOUT"); do
	[ "$(docker inspect -f '{{.State.Running}}' "$probe_app")" = true ] && break
	sleep 1
done
if [ "$(docker inspect -f '{{.State.Running}}' "$probe_app")" != true ]; then
	docker logs "$probe_app" 2>&1 | redact || true
	echo "FAIL: the container did not stay up under the hardened flags (exit $(docker inspect -f '{{.State.ExitCode}}' "$probe_app"))" >&2
	exit 1
fi

# Runs a snippet in the probe container and prints what it said. Failures of `docker exec`
# itself are turned into a diagnostic here rather than being left to `set -e`: the container can
# die between the liveness check above and this call — it did, while breaking this check with
# --user 0 — and what reaches the log then is "Error response from daemon: … is not running",
# with the script exiting on the assignment before any of its own messages run.
exec_in_probe() { # <node source> -> prints the snippet's output
	local output
	if ! output=$(docker exec "$probe_app" /nodejs/bin/node -e "$1" 2>&1); then
		docker logs "$probe_app" 2>&1 | redact || true
		echo "FAIL: could not run a probe in the hardened container: $output" >&2
		return 1
	fi
	printf '%s' "$output"
}

probe_write() { # <path> -> prints WROTE or the errno
	exec_in_probe "try { require('node:fs').writeFileSync('$1', 'x'); console.log('WROTE') } catch (error) { console.log(error.code) }"
}

for target in /app/smoke-probe /smoke-probe /nodejs/smoke-probe; do
	result=$(probe_write "$target") || exit 1
	if [ "$result" != EROFS ]; then
		echo "FAIL: writing $target in the hardened container returned '$result', expected EROFS" >&2
		exit 1
	fi
done
for target in /tmp/smoke-probe /data/smoke-probe; do
	result=$(probe_write "$target") || exit 1
	if [ "$result" != WROTE ]; then
		echo "FAIL: writing $target in the hardened container returned '$result', expected success" >&2
		exit 1
	fi
done

# The bounding set matters as much as the effective one: a non-empty CapBnd is a capability a
# process could still acquire, which is the thing --cap-drop ALL is for.
#
# Read from /proc/1/status, not /proc/self/status: self is this `docker exec`, which is not the
# process serving requests. Docker applies the same confinement to an exec today, so the two
# agree — but the claim is about the server, and the server is PID 1.
# Parsed by splitting on the tab /proc writes, not with a regex: the regex form had to survive
# a shell single-quoted string on its way into node -e, and what arrived was mangled enough to
# match nothing at all — which read as four empty fields, i.e. a green-looking "no capabilities"
# if the comparison had been any looser. The expected string is compared whole for that reason.
caps=$(exec_in_probe '
	const wanted = ["CapPrm", "CapEff", "CapBnd", "NoNewPrivs"];
	const found = new Map(
		require("node:fs")
			.readFileSync("/proc/1/status", "utf8")
			.split("\n")
			.map((line) => line.split(":"))
			.filter((parts) => parts.length === 2)
			.map(([key, value]) => [key.trim(), value.trim()])
	);
	console.log(wanted.map((key) => found.get(key) ?? "MISSING").join(" "));
') || exit 1
if [ "$caps" != "0000000000000000 0000000000000000 0000000000000000 1" ]; then
	echo "FAIL: capability state is '$caps', expected all-zero sets with NoNewPrivs 1" >&2
	exit 1
fi

# Same reasoning as the capability read above: the uid that matters is PID 1's.
runtime_identity=$(exec_in_probe '
	const status = require("node:fs").readFileSync("/proc/1/status", "utf8");
	const field = (name) =>
		(status.split("\n").find((line) => line.startsWith(`${name}:`)) ?? "").split(/\s+/)[1];
	const stats = require("node:fs").statSync("/data");
	console.log(`${field("Uid")}:${field("Gid")} ${stats.uid}:${stats.gid}`);
') || exit 1
if [ "$runtime_identity" != "65532:65532 65532:65532" ]; then
	echo "FAIL: running as / owning /data is '$runtime_identity', expected 65532:65532 for both" >&2
	exit 1
fi
echo "  ok: EROFS on 3 root paths, writable /tmp and /data, no capabilities, NoNewPrivs, uid 65532"
docker rm -f "$probe_app" >/dev/null

# The other half of the /data preflight, and the half that had no check at all until the review
# of this change asked for one. boot.mjs distinguishes two reasons /data cannot be written —
# EROFS (read-only root, nothing mounted there) from EACCES (mounted, owned by the old uid) —
# and only the second was exercised, by the upgrade leg below. A regression collapsing both into
# one message, or dropping the EROFS branch so it fell through to the generic errno text, would
# have left every assertion green while an operator with a missing volume was told to chown one.
#
# So the discriminating assertion is the negative one: the ownership advice must NOT appear here.
echo
echo "=== asserting a missing /data mount is diagnosed as read-only, not as ownership ==="
novolume_app=smoke-app-novolume
CREATED_CONTAINERS+=("$novolume_app")
set +e
timeout 60 docker run --name "$novolume_app" "${HARDENED[@]}" \
	-e DATABASE_URL="file:/data/budgetpilot.db" \
	-e ORIGIN="http://127.0.0.1:$APP_PORT" \
	-e PUBLIC_INSTANCE=false \
	-e TOTP_ENCRYPTION_KEY="$TOTP_ENCRYPTION_KEY" \
	-e RATE_LIMIT_HASH_SECRET="$RATE_LIMIT_HASH_SECRET" \
	-e BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
	"$IMAGE" >/dev/null 2>&1
novolume_status=$?
set -e
novolume_logs=$(docker logs "$novolume_app" 2>&1 | redact || true)
docker rm -f "$novolume_app" >/dev/null

if [ "$novolume_status" -eq 0 ]; then
	echo "$novolume_logs"
	echo "FAIL: the app started with no volume mounted at /data under a read-only root" >&2
	exit 1
fi
if ! grep -q 'read-only filesystem' <<<"$novolume_logs"; then
	echo "$novolume_logs"
	echo "FAIL: a missing /data mount was not diagnosed as a read-only filesystem" >&2
	exit 1
fi
if grep -q 'chown -R 65532:65532' <<<"$novolume_logs"; then
	echo "$novolume_logs"
	echo "FAIL: a missing /data mount printed the volume-ownership remediation, which cannot help here" >&2
	exit 1
fi
echo "  ok: refused with the read-only diagnosis, and without the ownership advice"

# The upgrade path from any pre-distroless image, which is the one operator-breaking change in
# this base swap. Those images ran as a `useradd --system` uid (999 here), this one runs as
# 65532, and an existing SQLite install's volume is still owned by the old uid. Without the
# preflight in boot.mjs the first symptom is Prisma's SQLITE_CANTOPEN, which names neither the
# cause nor the fix — and the fix cannot run in this image, because it has no chown.
#
# Both halves are asserted: that it refuses with the remediation, and that the remediation it
# prints actually works. A message nobody has followed end to end is not a remediation.
echo
echo "=== asserting an old-uid volume is refused, and that the printed fix resolves it ==="
docker volume create "$UPGRADE_VOLUME" >/dev/null
# busybox, exactly as the message tells an operator to do it — the helper image is the whole
# point, since neither chown nor a shell exists in the app image.
docker run --rm -v "$UPGRADE_VOLUME:/data" busybox:1.37 \
	sh -c 'touch /data/dev.db && chown -R 999:999 /data' >/dev/null

upgrade_app=smoke-app-upgrade
CREATED_CONTAINERS+=("$upgrade_app")
set +e
timeout 120 docker run --name "$upgrade_app" -v "$UPGRADE_VOLUME:/data" \
	"${HARDENED[@]}" \
	-e DATABASE_URL="file:/data/dev.db" \
	-e ORIGIN="http://127.0.0.1:$APP_PORT" \
	-e PUBLIC_INSTANCE=false \
	-e TOTP_ENCRYPTION_KEY="$TOTP_ENCRYPTION_KEY" \
	-e RATE_LIMIT_HASH_SECRET="$RATE_LIMIT_HASH_SECRET" \
	-e BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
	"$IMAGE" >/dev/null 2>&1
upgrade_status=$?
set -e
upgrade_logs=$(docker logs "$upgrade_app" 2>&1 | redact || true)
docker rm -f "$upgrade_app" >/dev/null

if [ "$upgrade_status" -eq 0 ]; then
	echo "$upgrade_logs"
	echo "FAIL: the container started on a volume owned by the old uid" >&2
	exit 1
fi
# The remediation string itself, not merely "it failed": an operator who cannot act on the
# message is no better off than with SQLITE_CANTOPEN.
if ! grep -q 'chown -R 65532:65532 /data' <<<"$upgrade_logs"; then
	echo "$upgrade_logs"
	echo "FAIL: the refusal did not print the chown remediation" >&2
	exit 1
fi
# Prisma must never have been reached: the whole value of the preflight is that it speaks before
# the driver produces its opaque error.
if grep -qE 'SQLITE_CANTOPEN|unable to open database file' <<<"$upgrade_logs"; then
	echo "$upgrade_logs"
	echo "FAIL: Prisma's own error surfaced, so the preflight did not run first" >&2
	exit 1
fi
echo "  ok: refused with the remediation, before Prisma saw the volume"

# Now follow the printed instruction verbatim and boot again.
docker run --rm -v "$UPGRADE_VOLUME:/data" busybox:1.37 chown -R 65532:65532 /data >/dev/null
upgrade_app=smoke-app-upgraded
run_container "$upgrade_app" \
	"${HARDENED[@]}" \
	-p "127.0.0.1:$APP_PORT:3000" \
	-v "$UPGRADE_VOLUME:/data" \
	-e DATABASE_URL="file:/data/budgetpilot.db" \
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
upgrade_logs=$(docker logs "$upgrade_app" 2>&1 | redact || true)
if [ "$ready" != true ]; then
	echo "$upgrade_logs"
	echo "FAIL: the remediation the image prints does not actually make it bootable" >&2
	exit 1
fi
if ! grep -qE 'migration(s)? have been successfully applied|No pending migrations' <<<"$upgrade_logs"; then
	echo "$upgrade_logs"
	echo "FAIL: no evidence that migrate deploy ran after the remediation" >&2
	exit 1
fi
echo "  ok: after the printed chown, migrations applied and /login served"
docker rm -f "$upgrade_app" >/dev/null
docker volume rm "$UPGRADE_VOLUME" >/dev/null

# The database default moved from /data/dev.db to /data/budgetpilot.db, and boot.mjs adopts the
# old file when it is the one that exists. Both directions are asserted here because only the
# pair says anything: a shim that ALWAYS returned the legacy path would satisfy the upgrade case
# on its own, and a shim that never fired would satisfy the new-install case on its own.
#
# Neither can be checked from inside the image, which has no shell: the assertions read the
# volume through busybox, which is how every other volume assertion in this file works.
#
# DATABASE_URL is deliberately NOT passed to either container. That is the whole point: the
# variable's absence is what makes the image's own ENV default apply, which is the path an
# operator who never edited .env actually takes, and the path that would have silently produced
# an empty database.
echo
echo "=== asserting the database default moved, and that an old install is adopted ==="

docker volume rm -f "$RENAME_VOLUME" >/dev/null 2>&1 || true
docker volume create "$RENAME_VOLUME" >/dev/null
docker run --rm -v "$RENAME_VOLUME:/data" busybox:1.37 chown -R 65532:65532 /data >/dev/null

# Boots the image once against $RENAME_VOLUME and stops it as soon as it serves.
#
# Readiness is /login answering, the same signal every other boot in this file waits on, and not
# "a .db file appeared": the legacy leg starts with a dev.db already present, so a
# file-existence poll would return before migrate deploy had done anything and the assertions
# would be about the fixture rather than about the boot.
boot_once_for_rename() {
	local name=$1
	run_container "$name" \
		"${HARDENED[@]}" \
		-p "127.0.0.1:$APP_PORT:3000" \
		-v "$RENAME_VOLUME:/data" \
		-e ORIGIN="http://127.0.0.1:$APP_PORT" \
		-e PUBLIC_INSTANCE=false \
		-e TOTP_ENCRYPTION_KEY="$TOTP_ENCRYPTION_KEY" \
		-e RATE_LIMIT_HASH_SECRET="$RATE_LIMIT_HASH_SECRET" \
		-e BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
		"$IMAGE"
	local ready=false
	for _ in $(seq 1 "$BOOT_TIMEOUT"); do
		if curl -fs -o /dev/null "http://127.0.0.1:$APP_PORT/login" 2>/dev/null; then
			ready=true
			break
		fi
		sleep 1
	done
	docker stop -t 10 "$name" >/dev/null 2>&1 || true
	[ "$ready" = true ]
}

volume_has() {
	docker run --rm -v "$RENAME_VOLUME:/data" busybox:1.37 test -f "/data/$1"
}

rename_new=smoke-app-rename-new
if ! boot_once_for_rename "$rename_new"; then
	docker logs "$rename_new" 2>&1 | redact || true
	echo "FAIL: the image did not boot on a fresh volume with no DATABASE_URL set" >&2
	exit 1
fi
rename_new_logs=$(docker logs "$rename_new" 2>&1 | redact || true)
docker rm -f "$rename_new" >/dev/null 2>&1 || true

# CALIBRATION, and it runs first on purpose. Without it, an adoption that fired unconditionally
# would pass the upgrade case below and this whole section would certify the opposite of what it
# claims.
if ! volume_has budgetpilot.db; then
	echo "$rename_new_logs"
	echo "FAIL: a fresh volume did not get /data/budgetpilot.db, so the new default is not in use" >&2
	exit 1
fi
if volume_has dev.db; then
	echo "FAIL: a fresh volume got a dev.db, so the old default is still being written" >&2
	exit 1
fi
echo "  ok: a new install creates /data/budgetpilot.db and no dev.db"

# Now the upgrade direction, on a volume that holds only the legacy name.
docker volume rm -f "$RENAME_VOLUME" >/dev/null 2>&1 || true
docker volume create "$RENAME_VOLUME" >/dev/null
docker run --rm -v "$RENAME_VOLUME:/data" busybox:1.37 \
	sh -c 'touch /data/dev.db && chown -R 65532:65532 /data' >/dev/null

rename_old=smoke-app-rename-legacy
if ! boot_once_for_rename "$rename_old"; then
	docker logs "$rename_old" 2>&1 | redact || true
	echo "FAIL: the image did not boot on a volume holding only the legacy dev.db" >&2
	exit 1
fi
rename_old_logs=$(docker logs "$rename_old" 2>&1 | redact || true)
docker rm -f "$rename_old" >/dev/null 2>&1 || true

if volume_has budgetpilot.db; then
	echo "$rename_old_logs"
	echo "FAIL: an install holding dev.db was given a second, empty budgetpilot.db" >&2
	exit 1
fi
# The message, not merely the behaviour: an operator whose app quietly opened a different file
# than the default says it opens has no way to find that out except from the log.
if ! grep -q '/data/dev.db' <<<"$rename_old_logs"; then
	echo "$rename_old_logs"
	echo "FAIL: the adoption was silent, so nothing tells the operator which file is open" >&2
	exit 1
fi
echo "  ok: an install holding dev.db keeps it, and says so"
docker volume rm -f "$RENAME_VOLUME" >/dev/null 2>&1 || true

# The container has to stop on SIGTERM by draining, not by being killed 10 seconds later.
# `exec node build` gave that for free: node was PID 1 and adapter-node's own SIGTERM handler
# ran. boot.mjs keeps node as PID 1 and starts the server by *importing* the build output, in
# the same process, precisely so that stays true — a version that spawned the server as a child
# would look identical here until docker stop, and then take the full timeout and get SIGKILLed.
echo
echo "=== asserting SIGTERM stops the container promptly (no SIGKILL) ==="
term_app=smoke-app-sigterm
fresh_data_volume
run_container "$term_app" \
	"${HARDENED[@]}" \
	-v "$DATA_VOLUME:/data" \
	-p "127.0.0.1:$APP_PORT:3000" \
	-e DATABASE_URL="file:/data/budgetpilot.db" \
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
