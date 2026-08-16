#!/usr/bin/env bash
# Renders every Compose file combination the docs tell an operator to run.
#
# The overlays are only ever used stacked — `-f docker-compose.yml -f docker-compose.ai.yml -f
# docker-compose.proxy.yml` — and until this existed nothing checked any of them, alone or
# combined. A key renamed in the base file, or a service the proxy overlay patches that the
# prebuilt file happens to name differently, produces a broken command in the docs that no test
# and no reviewer would see.
#
# `config -q` merges the files and validates the result. That is the whole claim: the combination
# is a valid Compose project. It does not start anything, so it cannot prove the stack works —
# what it catches is the combination being malformed, which is the failure that scales with the
# number of overlays. Every combination below must appear in the docs, and every combination in
# the docs must appear below.

set -euo pipefail

# Values only present so the merge resolves without unset-variable warnings. Compose never
# connects to anything here.
#
# Assigned unconditionally rather than `${VAR:-…}`, and paired with `--env-file /dev/null`
# below, which stops Compose auto-loading ./.env for *interpolation*. On a contributor's machine
# that would otherwise substitute real secrets into the rendered project, and the failure path
# echoes Compose's stderr, which quotes the offending value on an interpolation error.
#
# It does not stop the `env_file: - .env` declared inside the Compose files themselves, which
# loads .env into each service's environment. `config -q` suppresses the rendered project, so
# that content never reaches stdout — but it is NOT true that Compose's errors never quote it.
# Tried, rather than assumed: a line whose *key* is malformed (`FOO$BAR=…`, `"quoted=…`) makes
# the dotenv parser report `unexpected character "$" in variable name "FOO$BAR=<the value>"`,
# with the whole line, value included. A contributor with one stray character in a real .env
# would have printed a secret. Hence redact() below, applied to every Compose error this script
# echoes.
export BOOTSTRAP_TOKEN=compose-check-only
# The two key-shaped values are 64 hex, which the app enforces for both. INERT TODAY: this script
# only runs `docker compose config`, so nothing here ever reaches a booting app and neither value
# has ever been validated. They are valid anyway so that the day this script does boot something,
# it fails on whatever it was actually testing rather than on a fixture nobody had reason to look at.
export RATE_LIMIT_HASH_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef
export TOTP_ENCRYPTION_KEY=c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1
# The two database overlays declare DATABASE_PASSWORD with `:?`, so an unset value is a hard
# Compose error rather than a database published with a blank password. That is the behaviour
# an operator gets, and it means this script has to supply one like any other caller.
export DATABASE_PASSWORD=compose-check-only

# Everything Compose says goes through this before it is echoed. Two rules: strip credentials
# out of anything URL-shaped, and keep only the key of any KEY=VALUE the message quotes back.
# Compose's own diagnostics say what is wrong outside the `=` (line number, offending
# character, missing variable name), so redacting the right-hand side costs no diagnostic value.
redact() {
	sed -E 's#([a-z][a-z0-9+.-]*://)[^@/[:space:]]*@#\1***:***@#gi; s/=[^"[:space:]]*/=<redacted>/g'
}

# Both base files declare `env_file: - .env`, and Compose refuses to render a project whose
# env_file is missing — so on a fresh checkout, which is every CI run, every combination below
# fails on a missing file rather than on anything about the combination. A placeholder stands in,
# and only ever when there is nothing to overwrite.
ENV_FILE=.env
CREATED_ENV_FILE=false

if [ ! -e "$ENV_FILE" ]; then
	printf 'BOOTSTRAP_TOKEN=compose-check-only\n' >"$ENV_FILE"
	CREATED_ENV_FILE=true
fi

cleanup() {
	# `if`, not `[ … ] && rm`: a trailing test that evaluates false makes the trap return 1, and
	# on an EXIT trap that becomes the script's exit status — so the check "failed" on every run
	# where a real .env already existed.
	if [ "$CREATED_ENV_FILE" = true ]; then
		rm -f "$ENV_FILE"
	fi
}
trap cleanup EXIT INT TERM

# Two bases — docker-compose.yml builds from the checkout, docker-compose.prebuilt.yml pulls the
# published image — each combined with the overlays the docs pair it with.
#
#   docker-compose.yml                     README.md, docs/configuration.md
#   docker-compose.prebuilt.yml            README.md, docs/getting-started.md
#   + docker-compose.ai.yml                docs/ai-insights.md
#   + docker-compose.ai.gpu.yml            docs/ai-insights.md
#   + docker-compose.proxy.yml             docs/reverse-proxy.md
#   + both                                 docs/reverse-proxy.md
#   + docker-compose.postgres.yml          docs/database-providers.md
#   + docker-compose.mysql.yml             docs/database-providers.md
#   + a provider overlay and both others   docs/database-providers.md
#
# The two provider overlays are never stacked with each other — both set DATABASE_URL, so the
# result is one server the app never opens. That combination is documented as forbidden and is
# deliberately absent below.
#
# docker-compose.ai.gpu.yml only ever goes on top of docker-compose.ai.yml: alone it would patch
# a service the project does not define. Its combinations therefore mirror the AI ones rather
# than doubling every row.
#
# Both bases carry the full four-overlay stack now. That used to be the source-build base only,
# and the prebuilt one is the base most operators actually run.
COMBINATIONS=(
	"docker-compose.yml"
	"docker-compose.prebuilt.yml"
	"docker-compose.yml docker-compose.ai.yml"
	"docker-compose.prebuilt.yml docker-compose.ai.yml"
	"docker-compose.yml docker-compose.ai.yml docker-compose.ai.gpu.yml"
	"docker-compose.prebuilt.yml docker-compose.ai.yml docker-compose.ai.gpu.yml"
	"docker-compose.yml docker-compose.proxy.yml"
	"docker-compose.prebuilt.yml docker-compose.proxy.yml"
	"docker-compose.yml docker-compose.ai.yml docker-compose.proxy.yml"
	"docker-compose.prebuilt.yml docker-compose.ai.yml docker-compose.proxy.yml"
	"docker-compose.yml docker-compose.postgres.yml"
	"docker-compose.prebuilt.yml docker-compose.postgres.yml"
	"docker-compose.yml docker-compose.mysql.yml"
	"docker-compose.prebuilt.yml docker-compose.mysql.yml"
	"docker-compose.yml docker-compose.postgres.yml docker-compose.ai.yml docker-compose.proxy.yml"
	"docker-compose.yml docker-compose.mysql.yml docker-compose.ai.yml docker-compose.proxy.yml"
	"docker-compose.prebuilt.yml docker-compose.postgres.yml docker-compose.ai.yml docker-compose.proxy.yml"
	"docker-compose.prebuilt.yml docker-compose.mysql.yml docker-compose.ai.yml docker-compose.proxy.yml"
)

failed=0

for combination in "${COMBINATIONS[@]}"; do
	args=()
	for file in $combination; do
		args+=(-f "$file")
	done

	if output=$(docker compose --env-file /dev/null "${args[@]}" config -q 2>&1); then
		echo "ok:   $combination"
	else
		echo "FAIL: $combination" >&2
		echo "$output" | redact >&2
		failed=1
	fi
done

# The runtime hardening on the app service, asserted on every documented stack rather than on the
# two base files. An overlay patching the `budgetpilot` service — the proxy one already does —
# is one careless key away from resetting any of these back to the Compose default, and the
# result still merges, still validates and still starts. It just starts with a writable root
# filesystem or a full capability set, which nothing else here would notice.
#
# These are *configuration* assertions, and that is their limit. They prove the stack is written
# this way; they cannot prove the kernel then enforces it. That half is proven where it can only
# be proven — in a running container, by attempting the writes and reading /proc/self/status —
# in scripts/docker-smoke.sh. Neither check replaces the other, and note that ownership and
# permissions specifically cannot be asserted from an image export at all: an unprivileged
# `docker export | tar -x` re-owns every file to whoever ran it.
echo
echo "--- runtime hardening on the app service ---"

for combination in "${COMBINATIONS[@]}"; do
	args=()
	for file in $combination; do
		args+=(-f "$file")
	done

	if ! project=$(docker compose --env-file /dev/null "${args[@]}" config --format json 2>/dev/null); then
		echo "FAIL: $combination could not be rendered (see the combination above for the reason)" >&2
		failed=1
		continue
	fi

	read_only=$(jq -r '.services.budgetpilot.read_only // false' <<<"$project")
	caps=$(jq -r '(.services.budgetpilot.cap_drop // []) | join(",")' <<<"$project")
	added_caps=$(jq -r '(.services.budgetpilot.cap_add // []) | length' <<<"$project")
	no_new_privs=$(jq -r '[(.services.budgetpilot.security_opt // [])[] | select(. == "no-new-privileges:true")] | length' <<<"$project")
	tmpfs_mounts=$(jq -r '(.services.budgetpilot.tmpfs // []) | join(",")' <<<"$project")
	# Absent is correct and expected: the image carries its own exec-form HEALTHCHECK, so there
	# is deliberately nothing to declare here. What must never appear is a shell-form one — the
	# image has no shell, so `test: ["CMD-SHELL", …]` would fail every probe and mark a healthy
	# container unhealthy forever.
	healthcheck_kind=$(jq -r '(.services.budgetpilot.healthcheck.test // [])[0] // "inherited-from-image"' <<<"$project")
	healthcheck_disabled=$(jq -r '.services.budgetpilot.healthcheck.disable // false' <<<"$project")
	# The keys that do not *look* like they belong to this list, and undo it anyway. Asserting
	# the four flags are present says nothing while one of these is around to override them:
	# `privileged: true` restores the whole capability set and drops seccomp/AppArmor without
	# touching cap_drop; `security_opt` is a sequence and Compose *appends* across -f files, so
	# an overlay can leave no-new-privileges in place and add `seccomp:unconfined` next to it;
	# and `user:` puts the container back on whatever uid it names, no matter what the image
	# says. Each merges cleanly and starts. This is the repo's recurring failure mode — a check
	# that asserts the presence of what it knows about instead of the absence of what overrides
	# it — so it is worth re-reading this list whenever Compose grows a new escape hatch.
	privileged=$(jq -r '.services.budgetpilot.privileged // false' <<<"$project")
	extra_security_opts=$(jq -r '[(.services.budgetpilot.security_opt // [])[] | select(. != "no-new-privileges:true")] | join(",")' <<<"$project")
	run_as=$(jq -r '.services.budgetpilot.user // ""' <<<"$project")

	if [ "$read_only" != true ]; then
		echo "FAIL: $combination leaves the app's root filesystem writable (read_only: $read_only)" >&2
		failed=1
		continue
	fi
	if [ "$caps" != ALL ]; then
		echo "FAIL: $combination drops capabilities \"$caps\", expected exactly ALL" >&2
		failed=1
		continue
	fi
	if [ "$added_caps" != 0 ]; then
		echo "FAIL: $combination adds $added_caps capability/capabilities back; none is needed" >&2
		failed=1
		continue
	fi
	if [ "$no_new_privs" != 1 ]; then
		echo "FAIL: $combination does not set no-new-privileges:true on the app service" >&2
		failed=1
		continue
	fi
	if [ "$tmpfs_mounts" != /tmp ]; then
		echo "FAIL: $combination mounts tmpfs \"$tmpfs_mounts\", expected exactly /tmp" >&2
		failed=1
		continue
	fi
	if [ "$healthcheck_kind" = CMD-SHELL ]; then
		echo "FAIL: $combination gives the app a shell-form healthcheck; the image has no shell" >&2
		failed=1
		continue
	fi
	# `disable: true` renders with no `test` at all, which reads exactly like "inherited from the
	# image" — the healthy-looking answer for a container that has no healthcheck whatsoever.
	if [ "$healthcheck_disabled" = true ]; then
		echo "FAIL: $combination disables the app's healthcheck" >&2
		failed=1
		continue
	fi
	if [ "$privileged" != false ]; then
		echo "FAIL: $combination runs the app privileged, which restores every dropped capability" >&2
		failed=1
		continue
	fi
	if [ -n "$extra_security_opts" ]; then
		echo "FAIL: $combination adds security_opt entries \"$extra_security_opts\"; confinement must not be relaxed" >&2
		failed=1
		continue
	fi
	if [ -n "$run_as" ]; then
		echo "FAIL: $combination overrides the app's user to \"$run_as\"" >&2
		failed=1
		continue
	fi

	echo "ok:   $combination (read-only root, all capabilities dropped, no-new-privileges, tmpfs=/tmp)"
done

# A valid project is not the claim that matters for the database overlays. Two of their
# properties are load-bearing and both are one careless edit away from being silently lost, with
# a stack that still merges, still validates and still starts:
#
#   - the app is actually pointed at the server the overlay starts. Drop DATABASE_PROVIDER and
#     the base file's `sqlite` default wins: the database container runs, the app writes to a
#     file on the volume, and every screen looks fine while the server stays empty.
#   - the database port is not published. Add a `ports:` entry and the server is reachable from
#     the whole LAN, with its password the only thing in front of every account's financial data.
#   - PostgreSQL's app account is not the cluster's bootstrap superuser. The image makes
#     POSTGRES_USER one, and PostgreSQL will not let that role drop the attribute afterwards,
#     so the app gets a separate role created by an inline initdb script. Point DATABASE_URL
#     back at POSTGRES_USER and the stack still merges, still validates, still starts — with an
#     app holding COPY … TO PROGRAM.
#
# Asserted against the *merged* project — the same thing `up` would run — because that is where
# an overlay ordering or a stray key from another file decides the answer. Only these extracted
# fields are ever printed; the rendered project carries DATABASE_URL, which is a credential.
echo
echo "--- database overlay properties ---"

DATABASE_OVERLAY_CASES=(
	"docker-compose.postgres.yml|postgres|postgresql"
	"docker-compose.mysql.yml|mysql|mysql"
)

for case in "${DATABASE_OVERLAY_CASES[@]}"; do
	IFS='|' read -r overlay service expected_provider <<<"$case"

	for base in docker-compose.yml docker-compose.prebuilt.yml; do
		label="$base $overlay"

		# stderr goes nowhere, deliberately: a warning merged into `$project` would corrupt the
		# JSON, and jq quotes its input back on a parse error — input that is the rendered
		# project, DATABASE_URL and all. The loop above already renders every one of these
		# combinations and reports what Compose said, so nothing diagnostic is lost here.
		if ! project=$(docker compose --env-file /dev/null -f "$base" -f "$overlay" config --format json 2>/dev/null); then
			echo "FAIL: $label could not be rendered (see the combination above for the reason)" >&2
			failed=1
			continue
		fi

		provider=$(jq -r --arg s budgetpilot '.services[$s].environment.DATABASE_PROVIDER // ""' <<<"$project")
		if [ "$provider" != "$expected_provider" ]; then
			echo "FAIL: $label leaves the app on DATABASE_PROVIDER=\"$provider\", expected \"$expected_provider\"" >&2
			failed=1
			continue
		fi

		published=$(jq -r --arg s "$service" '.services[$s].ports // [] | length' <<<"$project")
		if [ "$published" != 0 ]; then
			echo "FAIL: $label publishes $published host port(s) on the $service service" >&2
			failed=1
			continue
		fi

		# PostgreSQL only: the app must not connect as the cluster's bootstrap superuser, and the
		# role it does connect as has to be created by the initdb script — so all three halves
		# are asserted. Static by nature: this proves the stack is *configured* that way. That
		# the running server then agrees was proven by querying `rolsuper` on a live container,
		# which is where every surprise in this design turned up (Compose eats `$` in
		# `content:`; PostgreSQL will not let the bootstrap superuser give up the attribute).
		if [ "$expected_provider" = postgresql ]; then
			bootstrap_role=$(jq -r --arg s "$service" '.services[$s].environment.POSTGRES_USER // ""' <<<"$project")
			# Only the userinfo's user is extracted, never the password that follows it.
			app_role=$(jq -r --arg s budgetpilot \
				'.services[$s].environment.DATABASE_URL // "" | capture("^postgresql://(?<user>[^:@/]+)").user // ""' \
				<<<"$project")
			target=$(jq -r --arg s "$service" \
				'[(.services[$s].configs // [])[] | select(.source == "postgres_least_privilege") | .target][0] // ""' \
				<<<"$project")
			content=$(jq -r '.configs.postgres_least_privilege.content // ""' <<<"$project")

			if [ -z "$app_role" ] || [ "$app_role" = "$bootstrap_role" ]; then
				echo "FAIL: $label connects as \"$app_role\", which is the cluster's bootstrap superuser" >&2
				failed=1
				continue
			fi

			case "$target" in
			/docker-entrypoint-initdb.d/*) ;;
			*)
				echo "FAIL: $label does not mount the least-privilege config into initdb (target: \"$target\")" >&2
				failed=1
				continue
				;;
			esac

			if [[ "$content" != *"CREATE ROLE $app_role LOGIN"* ]]; then
				echo "FAIL: $label no longer creates \"$app_role\" as a plain LOGIN role" >&2
				failed=1
				continue
			fi

			# Drop this statement and everything above still passes, while the cluster keeps a
			# superuser reachable over the Compose network on the same password the app holds.
			if [[ "$content" != *"ALTER ROLE $bootstrap_role PASSWORD NULL"* ]]; then
				echo "FAIL: $label leaves \"$bootstrap_role\" with a password the app also knows" >&2
				failed=1
				continue
			fi

			# The password must reach psql through the environment, never through a `$`-prefixed
			# substitution: Compose interpolates `content:`, so `$APP_DB_PASSWORD` written with
			# one dollar becomes the empty string and the app role is created with no password.
			# The role is still created, so every other assertion here would stay green.
			if [[ "$content" != *'\getenv pw APP_DB_PASSWORD'* ]]; then
				echo "FAIL: $label no longer reads the app password with psql's \\getenv" >&2
				failed=1
				continue
			fi

			echo "ok:   $label (app on $expected_provider as \"$app_role\", not the bootstrap superuser, $service port unpublished)"
			continue
		fi

		echo "ok:   $label (app on $expected_provider, $service port unpublished)"
	done
done

# The AI overlay must start on a machine with no GPU, and the GPU overlay must actually ask for
# one. `config -q` above cannot see either: a device reservation is valid Compose and only fails
# at `up`, on the hosts least able to debug it. Asserted against the merged project, so moving
# the block back into docker-compose.ai.yml fails here rather than in an operator's terminal.
echo
echo "--- ai overlay device reservations ---"

ai_devices() {
	local project
	if ! project=$(docker compose --env-file /dev/null "$@" config --format json 2>/dev/null); then
		echo "render-failed"
		return
	fi
	jq -r '[.services.ollama.deploy.resources.reservations.devices // [] | .[]] | length' <<<"$project"
}

cpu_devices=$(ai_devices -f docker-compose.yml -f docker-compose.ai.yml)
if [ "$cpu_devices" != 0 ]; then
	echo "FAIL: docker-compose.ai.yml reserves $cpu_devices device(s); it must run on CPU anywhere" >&2
	failed=1
else
	echo "ok:   docker-compose.ai.yml reserves no device (starts without a GPU)"
fi

gpu_devices=$(ai_devices -f docker-compose.yml -f docker-compose.ai.yml -f docker-compose.ai.gpu.yml)
if [ "$gpu_devices" = 0 ] || [ "$gpu_devices" = render-failed ]; then
	echo "FAIL: docker-compose.ai.gpu.yml no longer reserves a GPU device (got: $gpu_devices)" >&2
	failed=1
else
	echo "ok:   docker-compose.ai.gpu.yml reserves $gpu_devices device(s)"
fi

exit "$failed"
