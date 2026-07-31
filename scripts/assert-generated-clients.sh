#!/bin/sh
# Proves the three generated Prisma clients coexist, in the image that ships them.
#
#   usage: assert-generated-clients.sh dirs|bundle <rootfs-dir>
#
# The subject is an image's filesystem extracted onto the host, not the checkout: the claim being
# tested is about the artifact, not about the source tree. The failure it exists to catch is the
# one this repo already shipped once: all three schemas generated to the same default path and
# overwrote each other, so exactly one client existed at a time. Every job in CI still passed,
# because each regenerates its own client and proves that one works alone. Nothing ever looked at
# all three together.
#
# It used to run *inside* the image, via `docker run --entrypoint sh`. It runs on the host now
# because the runtime image is moving to a base with no shell, no grep and no coreutils. Nothing
# about the claim changes — docker export flattens exactly the filesystem a container would see —
# and the assertions gain the ability to run against an image that could not execute them.
#
# Two modes, both required — they check different halves of the pipeline:
#
#   dirs    the builder stage's source tree, i.e. what `prisma generate` actually wrote
#   bundle  the runner image's compiled ./build, i.e. what the published image runs
#
# `dirs` passing while `bundle` fails would mean generation is fine and the bundler dropped two
# clients. `bundle` alone cannot distinguish three distinct clients from one client counted three
# times, which is why the per-directory check exists.

set -eu

MODE=${1:-}
ROOT=${2:-}

# Overridable so the assertions themselves can be tested against a deliberately broken tree —
# a check that has never been seen to fail is not yet a check. Both defaults are the paths as
# they appear inside the image, resolved under the extracted root.
GENERATED_DIR=${GENERATED_DIR:-$ROOT/app/src/lib/server/database/generated}
BUNDLE_DIR=${BUNDLE_DIR:-$ROOT/app/build}
PROVIDERS='sqlite postgresql mysql'

# The datasource block Prisma bakes into each client's `inlineSchema`, as it appears on disk:
# JSON-escaped inside a TypeScript string literal. Matched with `grep -F` so the backslashes and
# quotes stay literal. Deliberately not the `generator` block's `provider`, which reads
# "prisma-client" in all three and would match nothing useful.
marker_for() {
	printf 'provider = \\"%s\\"' "$1"
}

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

count_marker() {
	# grep exits 1 on no match, which is a legitimate count of zero here; the pipeline's status
	# is `wc`'s, so `set -e` does not fire on it.
	grep -rFo "$(marker_for "$2")" "$1" 2>/dev/null | wc -l
}

assert_dirs() {
	for provider in $PROVIDERS; do
		dir="$GENERATED_DIR/$provider"

		[ -d "$dir" ] || fail "$dir does not exist — the client for $provider was never generated"
		[ -n "$(ls -A "$dir")" ] || fail "$dir is empty"

		# Each client must carry its own provider and only its own. Two clients reporting the
		# same datasource is precisely the overwrite bug: the directories exist, both look
		# populated, and one of them silently talks to the wrong engine.
		for marker in $PROVIDERS; do
			count=$(count_marker "$dir" "$marker")
			expected=0
			[ "$marker" = "$provider" ] && expected=1

			[ "$count" -eq "$expected" ] || fail \
				"$dir carries $count occurrence(s) of the \"$marker\" datasource marker, expected $expected"
		done

		echo "ok: $dir is populated and reports datasource provider \"$provider\""
	done
}

assert_bundle() {
	[ -d "$BUNDLE_DIR" ] || fail "$BUNDLE_DIR does not exist"

	for marker in $PROVIDERS; do
		count=$(count_marker "$BUNDLE_DIR" "$marker")

		# Exactly one, not "at least one": a second copy would mean a client got bundled twice
		# and this check could no longer tell three distinct clients from one duplicated.
		[ "$count" -eq 1 ] || fail \
			"$BUNDLE_DIR carries $count occurrence(s) of the \"$marker\" datasource marker, expected exactly 1"

		echo "ok: the shipped bundle carries exactly one \"$marker\" client"
	done
}

[ -n "$ROOT" ] || fail "usage: $0 dirs|bundle <rootfs-dir>"
[ -d "$ROOT" ] || fail "$ROOT is not a directory — nothing was extracted from the image"

case "$MODE" in
	dirs) assert_dirs ;;
	bundle) assert_bundle ;;
	*) fail "usage: $0 dirs|bundle <rootfs-dir>" ;;
esac
