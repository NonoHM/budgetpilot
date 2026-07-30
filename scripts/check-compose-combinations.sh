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
# loads .env into each service's environment. That content is never printed: `config -q`
# suppresses the rendered project, and Compose's validation errors do not quote it.
export BOOTSTRAP_TOKEN=compose-check-only
export RATE_LIMIT_HASH_SECRET=compose-check-only
export TOTP_ENCRYPTION_KEY=compose-check-only

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
COMBINATIONS=(
	"docker-compose.yml"
	"docker-compose.prebuilt.yml"
	"docker-compose.yml docker-compose.ai.yml"
	"docker-compose.prebuilt.yml docker-compose.ai.yml"
	"docker-compose.yml docker-compose.proxy.yml"
	"docker-compose.prebuilt.yml docker-compose.proxy.yml"
	"docker-compose.yml docker-compose.ai.yml docker-compose.proxy.yml"
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
		echo "$output" >&2
		failed=1
	fi
done

exit "$failed"
