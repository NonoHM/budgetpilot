#!/usr/bin/env bash
# Unit tests for the guards in scripts/test-env.sh.
#
# These exist because the guards are the only part of that script whose failure is SILENT.
# Everything else announces itself: a build breaks, a health check times out, a seed prints its
# row count. A teardown that removes the wrong thing, or removes nothing while reporting success,
# looks exactly like a teardown that worked.
#
# The assertion that earns this file on its own is `is_our_volume`. `budgetpilot-test` is a
# PREFIX of `budgetpilot-testenv`, so any guard written with a prefix match answers "ours" for a
# volume belonging to the long-lived instance, and the teardown then destroys it. That case is
# tested here in both directions, because a guard that says yes to everything and a guard that
# says yes to the right things produce the same green on the positive case alone.
#
#   ./scripts/test-env.spec.sh
#
# No docker required: every function under test is pure, and the two that shell out take the
# docker command through a variable so a fake can be injected.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Loads the script's definitions without running anything.
TEST_ENV_LIB_ONLY=1
export TEST_ENV_LIB_ONLY
# shellcheck source=/dev/null
source "$HERE/test-env.sh"
# test-env.sh sets -e, and sourcing applies it here too, so the first failing call under test
# would kill this harness and every later case would be reported by its absence rather than run.
# A run that stops at the first red and one that has no later cases print the same tail.
set +e

pass=0
fail=0

ok() {
	pass=$((pass + 1))
	echo "  ok: $1"
}

bad() {
	fail=$((fail + 1))
	echo "  FAIL: $1" >&2
}

# A missing function exits 127, which is non-zero, so every expect_false below would PASS against
# a script that defines nothing at all. That is the unfailable assertion this repository has
# already paid for more than once: the negative case and the absent case are the same exit code.
# So both helpers refuse a name that is not a defined function, and the first red run of this file
# reported seven failures rather than six passes because of it.
defined() {
	if ! declare -F "$1" >/dev/null 2>&1; then
		bad "$2 (no function named '$1' is defined)"
		return 1
	fi
	return 0
}

# Asserts a function SUCCEEDS (exit 0).
expect_true() {
	local label=$1
	shift
	defined "$1" "$label" || return
	if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label (expected exit 0, got $?)"; fi
}

# Asserts a function FAILS (non-zero). Both directions are needed: a guard that always says yes
# passes every expect_true and is worthless.
expect_false() {
	local label=$1
	shift
	defined "$1" "$label" || return
	if "$@" >/dev/null 2>&1; then bad "$label (expected non-zero, got 0)"; else ok "$label"; fi
}

expect_eq() {
	local label=$1 want=$2 got=$3
	if [ "$want" = "$got" ]; then ok "$label"; else bad "$label (want '$want', got '$got')"; fi
}

echo "--- is_our_volume: the prefix trap ---"
# budgetpilot-test is a prefix of budgetpilot-testenv. These four cases are the whole reason
# the teardown names volumes in full instead of sweeping.
expect_true "our data volume is ours" is_our_volume "budgetpilot-testenv_budgetpilot_data"
expect_true "our model cache is ours" is_our_volume "budgetpilot-testenv_ollama_data"
expect_false "the long-lived instance's data volume is NOT ours" \
	is_our_volume "budgetpilot-test_budgetpilot_data"
expect_false "the long-lived instance's caddy volume is NOT ours" \
	is_our_volume "budgetpilot-test_caddy_data"
expect_false "the long-lived instance's ollama volume is NOT ours" \
	is_our_volume "budgetpilot-test_ollama_data"
expect_false "an unrelated volume is NOT ours" is_our_volume "app_budgetpilot_data"
expect_false "the empty string is NOT ours" is_our_volume ""

echo "--- assert_project_name_safe ---"
expect_true "our project name is accepted" assert_project_name_safe "budgetpilot-testenv"
expect_false "the protected project name is refused" assert_project_name_safe "budgetpilot-test"

echo "--- removable_volumes: teardown removes the data volume, never the model cache ---"
removable=$(removable_volumes)
expect_eq "exactly the data volume is removable" "budgetpilot-testenv_budgetpilot_data" "$removable"

echo "--- port_holder: who is sitting on the port ---"
# docker is injected, so these are decisions about output rather than about a live daemon.
fake_docker_ours() { echo "budgetpilot-testenv"; }
fake_docker_foreign() { echo "budgetpilot-test"; }
fake_docker_nobody() { :; }

DOCKER=fake_docker_ours
expect_eq "a port held by a previous run of this script" \
	"ours" "$(port_holder 3210)"
DOCKER=fake_docker_foreign
expect_eq "a port held by another compose project" \
	"foreign" "$(port_holder 3210)"
DOCKER=fake_docker_nobody
expect_eq "a port held by a non-compose process" \
	"foreign" "$(port_holder 3210)"
DOCKER=docker

echo "--- parse_args ---"
reset_flags() {
	QUIET=0
	NO_WAIT=0
	PURGE=0
}

reset_flags
expect_true "no arguments is valid" parse_args
expect_eq "  quiet defaults off" "0" "$QUIET"
expect_eq "  no-wait defaults off" "0" "$NO_WAIT"
expect_eq "  purge defaults off" "0" "$PURGE"

reset_flags
parse_args --quiet >/dev/null 2>&1
expect_eq "--quiet sets QUIET" "1" "$QUIET"

reset_flags
parse_args --no-wait >/dev/null 2>&1
expect_eq "--no-wait sets NO_WAIT" "1" "$NO_WAIT"

reset_flags
parse_args --purge >/dev/null 2>&1
expect_eq "--purge sets PURGE" "1" "$PURGE"

reset_flags
parse_args --quiet --no-wait --purge >/dev/null 2>&1
expect_eq "flags combine (quiet)" "1" "$QUIET"
expect_eq "flags combine (no-wait)" "1" "$NO_WAIT"
expect_eq "flags combine (purge)" "1" "$PURGE"

reset_flags
expect_false "an unknown flag is refused" parse_args --bogus
reset_flags
expect_false "a typo of a real flag is refused" parse_args --quite
reset_flags
expect_false "a bare word is refused" parse_args please

echo "--- every supported flag is parseable AND documented ---"
# Anti-drift: adding a flag to supported_flags without teaching parse_args about it, or without
# writing it into the help, fails here rather than being discovered by someone whose flag is
# silently rejected. Both halves are needed, and they fail for different reasons.
help_text=$(usage_text)
[ -n "$help_text" ] || bad "usage_text produced nothing"
while IFS= read -r flag; do
	[ -n "$flag" ] || continue
	# In a SUBSHELL, because --help legitimately calls exit. Run directly, that exit terminates
	# this harness: the first version of this loop did exactly that, and the run reported exit 0
	# with no summary line, which reads like a pass. Hence the summary-line check at the bottom.
	if (parse_args "$flag" >/dev/null 2>&1); then
		ok "$flag is accepted by parse_args"
	else
		bad "$flag is rejected by parse_args although supported_flags lists it"
	fi
	case "$help_text" in
	*"$flag"*) ok "$flag appears in the help" ;;
	*) bad "$flag is supported but absent from the help" ;;
	esac
done < <(supported_flags)

echo
# A run that stopped early and a run where nothing failed both exit 0 otherwise, so the count is
# asserted rather than merely printed. This caught a --help case that exited the harness.
# 13 guard cases + 13 parse_args cases, then 2 per supported flag (parseable, and documented),
# so adding a flag does not need this line edited.
expected_cases=$((26 + 2 * $(supported_flags | grep -c .)))
echo "passed=$pass failed=$fail total=$((pass + fail)) expected=$expected_cases"
if [ $((pass + fail)) -ne "$expected_cases" ]; then
	echo "FAIL: ran $((pass + fail)) cases, expected $expected_cases. The run stopped early." >&2
	exit 1
fi
[ "$fail" -eq 0 ]
