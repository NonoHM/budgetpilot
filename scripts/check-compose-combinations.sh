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
export RATE_LIMIT_HASH_SECRET=compose-check-only
export TOTP_ENCRYPTION_KEY=compose-check-only
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
# env_file is missing — so on a fresh checkout, which is every CI run, all seven combinations
# fail on a missing file rather than on anything about the combination. A placeholder stands in,
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
#   + docker-compose.proxy.yml             docs/reverse-proxy.md
#   + both                                 docs/reverse-proxy.md
#   + docker-compose.postgres.yml          docs/database-providers.md
#   + docker-compose.mysql.yml             docs/database-providers.md
#   + a provider overlay and both others   docs/database-providers.md
#
# The two provider overlays are never stacked with each other — both set DATABASE_URL, so the
# result is one server the app never opens. That combination is documented as forbidden and is
# deliberately absent below.
COMBINATIONS=(
	"docker-compose.yml"
	"docker-compose.prebuilt.yml"
	"docker-compose.yml docker-compose.ai.yml"
	"docker-compose.prebuilt.yml docker-compose.ai.yml"
	"docker-compose.yml docker-compose.proxy.yml"
	"docker-compose.prebuilt.yml docker-compose.proxy.yml"
	"docker-compose.yml docker-compose.ai.yml docker-compose.proxy.yml"
	"docker-compose.yml docker-compose.postgres.yml"
	"docker-compose.prebuilt.yml docker-compose.postgres.yml"
	"docker-compose.yml docker-compose.mysql.yml"
	"docker-compose.prebuilt.yml docker-compose.mysql.yml"
	"docker-compose.yml docker-compose.postgres.yml docker-compose.ai.yml docker-compose.proxy.yml"
	"docker-compose.yml docker-compose.mysql.yml docker-compose.ai.yml docker-compose.proxy.yml"
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

# A valid project is not the claim that matters for the database overlays. Two of their
# properties are load-bearing and both are one careless edit away from being silently lost, with
# a stack that still merges, still validates and still starts:
#
#   - the app is actually pointed at the server the overlay starts. Drop DATABASE_PROVIDER and
#     the base file's `sqlite` default wins: the database container runs, the app writes to a
#     file on the volume, and every screen looks fine while the server stays empty.
#   - the database port is not published. Add a `ports:` entry and the server is reachable from
#     the whole LAN, with its password the only thing in front of every account's financial data.
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

		echo "ok:   $label (app on $expected_provider, $service port unpublished)"
	done
done

exit "$failed"
