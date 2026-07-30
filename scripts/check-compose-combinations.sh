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
# connects to anything here; nothing is read from a real .env.
export BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN:-compose-check-only}
export RATE_LIMIT_HASH_SECRET=${RATE_LIMIT_HASH_SECRET:-compose-check-only}
export TOTP_ENCRYPTION_KEY=${TOTP_ENCRYPTION_KEY:-compose-check-only}

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

	if output=$(docker compose "${args[@]}" config -q 2>&1); then
		echo "ok:   $combination"
	else
		echo "FAIL: $combination" >&2
		echo "$output" >&2
		failed=1
	fi
done

exit "$failed"
