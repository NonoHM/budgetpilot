#!/usr/bin/env bash
# A full BudgetPilot stack, built from the working tree, on an isolated Docker network, seeded and
# waiting in a browser. One command, Ctrl-C to remove it.
#
#   ./scripts/test-env.sh              build, boot, seed, print the URL, wait
#   ./scripts/test-env.sh --no-wait    the same, then tear down immediately (for scripted checks)
#   ./scripts/test-env.sh --purge      also remove the Ollama model cache and the fixtures
#
# ## Why it exists
#
# A change could not be exercised before its image was published, so features and fixes reached a
# real browser for the first time after they shipped. scripts/docker-smoke.sh proves the image
# BOOTS on three engines; nothing let anyone USE it. This does, and it is deliberately not a gate:
# it runs in no workflow and blocks no merge.
#
# ## The safety property, which outranks everything else here
#
# A long-lived deployment lives beside this one under Compose project `budgetpilot-test`, holding
# real data. This script must not be able to touch it, so:
#
#   * The project name is the constant PROJECT below and is never incremented. `budgetpilot-test`
#     is a PREFIX of `budgetpilot-testenv`, so every additional name is one more string a careless
#     prefix match could reach. One name, and a guard refusing the protected one outright.
#   * NOTHING here matches a name by prefix. Volumes are named in full and checked against an
#     exact list (is_our_volume), which scripts/test-env.spec.sh tests in both directions.
#   * Teardown is `down` WITHOUT `-v`, plus an explicit `docker volume rm` of the one volume this
#     script created. `down -v` would also take the model cache, and a `-v` aimed at the wrong
#     project takes someone's real data.
#   * Every docker command is scoped by `-p "$PROJECT"`, so a teardown run while the long-lived
#     instance is up does nothing to it.
#
# ## Bank sync is out of scope, and cannot be brought in
#
# It needs a redirect URL registered with Enable Banking and a real authorisation from a real
# bank, against a real account. Neither can be pointed at a throwaway stack that changes port
# between runs, and no synthetic fixture substitutes for the consent flow. BANK_SYNC_ENABLED is
# set to false below, explicitly rather than by omission. Exercise that path on the long-lived
# instance, which has the registration and the keys.
#
# ## Plain HTTP, and what that loses
#
# No Caddy, no TLS, and this was measured rather than preferred. The long-lived instance's Caddy
# holds host ports 80 and 443, and docker-compose.proxy.yml PINS the subnet 172.28.5.0/24, which
# that instance's network already occupies, so bringing the proxy overlay up here fails on an
# address-pool overlap. `tls internal` on some other port would buy a browser warning on every
# first visit and cover nothing that is in scope, since the only thing needing real TLS is bank
# sync, which is out.
#
# What it costs, named rather than glossed:
#
#   * PUBLIC_INSTANCE=false is required for plain http, so session cookies ship WITHOUT the Secure
#     flag and HSTS is absent. The secure-cookie path is NOT exercised here. It is visible rather
#     than silent: hooks.server.ts prints PUBLIC_INSTANCE and cookies-secure on every boot.
#   * TRUSTED_PROXIES and X-Forwarded-For handling go unexercised, both being proxy concerns.
#
# ## No secret, and one value worth naming
#
# The three throwaway values below are the ones scripts/docker-smoke.sh already carries. They are
# hardcoded rather than read from the environment, for the reason that script gives: a run in a
# shell exporting real values would otherwise bake them into a container and print them on a
# failure path. Nothing here reads ../budgetpilot-test/.env, mounts its keys, or enables bank sync.
#
# LLM_MODEL is a constant for a related reason. It is not a secret, but someone pasting the model
# name from a real environment triggers a multi-gigabyte pull into a throwaway cache: the model on
# the long-lived instance is 9.1 GB, against 397 MB for the one used here.

set -euo pipefail

# ---------------------------------------------------------------------------------------------
# Constants. PROJECT is fixed on purpose; see the safety property above.
# ---------------------------------------------------------------------------------------------

PROJECT=budgetpilot-testenv
# The long-lived deployment this script must never touch.
PROTECTED_PROJECT=budgetpilot-test

APP_CONTAINER="$PROJECT-app"
OLLAMA_CONTAINER="$PROJECT-ollama"
NETWORK="${PROJECT}_default"
# Compose names a volume <project>_<key>, and these two keys come from docker-compose.yml and
# docker-compose.ai.yml. Written out in full because every check against them is an exact match.
DATA_VOLUME="${PROJECT}_budgetpilot_data"
MODEL_VOLUME="${PROJECT}_ollama_data"

DEFAULT_PORT=3210
# A bound rather than an open-ended search, so a machine with a busy range fails with a message
# instead of scanning forever.
PORT_ATTEMPTS=12

# Small, CPU-friendly, and pinned: see the LLM_MODEL note in the header.
LLM_MODEL=qwen2.5:0.5b
MODEL_DOWNLOAD_MB=397

# Fixtures and the generated overlay live here. Kept between runs, like the model cache and like
# Docker's own layer cache: they are regenerated inputs, not state the app can inherit. The app's
# STATE is the data volume, and that is removed on every teardown. --purge removes both.
WORK_DIR=".test-env"
FIXTURE_DIR="$WORK_DIR/fixtures"
OVERLAY="$WORK_DIR/compose.generated.yml"

# Throwaway values, identical in shape to scripts/docker-smoke.sh: 64 hex for the two key-shaped
# ones because the app refuses anything else, an opaque sentence for the bootstrap token.
TOTP_ENCRYPTION_KEY=c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1
RATE_LIMIT_HASH_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef
BOOTSTRAP_TOKEN=test-env-only-fake-bootstrap-token
export TOTP_ENCRYPTION_KEY RATE_LIMIT_HASH_SECRET BOOTSTRAP_TOKEN

SEED_EMAIL=dev@budgetpilot.local
SEED_PASSWORD='DevBudgetPilot123!'

# Indirection so scripts/test-env.spec.sh can inject a fake. Never call `docker` directly in a
# function the spec exercises.
DOCKER=${DOCKER:-docker}

APP_PORT=""
PORT_VERDICT=""
PURGE=0
NO_WAIT=0
QUIET=0

# Step counter, so a long run says where it is rather than only that it is busy.
STEP_N=0
TOTAL_STEPS=9
STARTED_AT=$SECONDS
SPINNER_PID=""

# ---------------------------------------------------------------------------------------------
# Guards. Pure, and unit-tested by scripts/test-env.spec.sh.
# ---------------------------------------------------------------------------------------------

# The volumes this script is allowed to remove, one per line. The model cache is NOT here: it
# survives teardown so a run does not re-download the model, and only --purge removes it.
removable_volumes() {
	echo "$DATA_VOLUME"
}

# Exact membership, never a prefix or a glob. `budgetpilot-test_budgetpilot_data` belongs to the
# long-lived instance and differs from ours only by the four characters `env`, which is precisely
# what a prefix match cannot see.
is_our_volume() {
	local name=${1-}
	[ -n "$name" ] || return 1
	case "$name" in
	"$DATA_VOLUME" | "$MODEL_VOLUME") return 0 ;;
	*) return 1 ;;
	esac
}

assert_project_name_safe() {
	local name=${1-}
	[ -n "$name" ] || return 1
	[ "$name" != "$PROTECTED_PROJECT" ] || return 1
	return 0
}

# Who is publishing $1: this script's own previous run, or anything else.
#
# "ours" only when docker reports at least one container on that port AND every one of them
# carries our project label. Empty output means the holder is not a container docker knows about
# (a host process, or nothing), which is "foreign" because tearing it down is not ours to do.
port_holder() {
	local port=$1 line any=0
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		any=1
		[ "$line" = "$PROJECT" ] || {
			echo foreign
			return 0
		}
	done < <("$DOCKER" ps --all --filter "publish=$port" \
		--format '{{.Label "com.docker.compose.project"}}' 2>/dev/null)
	if [ "$any" -eq 1 ]; then echo ours; else echo foreign; fi
}

# ---------------------------------------------------------------------------------------------
# Arguments
#
# supported_flags is the single list. parse_args must accept every entry and the help must
# mention every entry, both asserted by scripts/test-env.spec.sh, so a flag added to one place
# and forgotten in another fails a test instead of reaching someone as a silent rejection.
# ---------------------------------------------------------------------------------------------

supported_flags() {
	cat <<-'FLAGS'
		--purge
		--no-wait
		--quiet
		--help
	FLAGS
}

usage_text() {
	cat <<-EOF
		A full BudgetPilot stack built from the working tree, seeded, in your browser.

		  ./scripts/test-env.sh [--purge] [--no-wait] [--quiet] [--help]

		  --purge     Also remove the Ollama model cache ($MODEL_VOLUME) and $WORK_DIR
		              on teardown. Without it both survive, so the next run does not
		              re-download the ${MODEL_DOWNLOAD_MB} MB model.
		  --no-wait   Build, boot, seed, print the report, then tear down immediately
		              instead of waiting. For scripted checks.
		  --quiet     No progress display and no build chatter. Warnings, failures and
		              the final report still print. Combine with --no-wait for scripts.
		  --help      This text.

		Default run: builds the image, starts the app plus Ollama on an isolated network
		as Compose project '$PROJECT', seeds an account with example data, prints
		http://127.0.0.1:$DEFAULT_PORT and waits. Ctrl-C removes everything it created.

		It cannot touch the long-lived '$PROTECTED_PROJECT' deployment: every command is
		scoped by project, volumes are matched by exact name and never by prefix, and
		teardown never uses 'down -v'. Bank sync is out of scope and disabled; see the
		comments at the top of this file for why, and for what plain HTTP costs.
	EOF
}

usage() {
	usage_text
	exit 0
}

parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--purge) PURGE=1 ;;
		--no-wait) NO_WAIT=1 ;;
		--quiet) QUIET=1 ;;
		-h | --help) usage ;;
		*)
			printf 'FAIL: unknown argument: %s\n\n' "$1" >&2
			usage_text >&2
			return 1
			;;
		esac
		shift
	done
	return 0
}

# ---------------------------------------------------------------------------------------------
# Output helpers
#
# Failures always print, on stderr, whatever --quiet says: a script that swallows its own error
# message is the confident-zero failure wearing a flag.
# ---------------------------------------------------------------------------------------------

say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
step() {
	STEP_N=$((STEP_N + 1))
	[ "$QUIET" -eq 1 ] || printf '\n[%d/%d] %s\n' "$STEP_N" "$TOTAL_STEPS" "$*"
}
die() {
	spinner_stop
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

# A spinner for the waits that have no output of their own. The steps that DO have their own
# progress display (the image build, the model pull) keep theirs rather than being hidden behind
# this one: docker and ollama both report better than a spinner can.
#
# Silent when quiet, and silent when stdout is not a terminal, so a redirected run produces a log
# rather than thousands of carriage returns.
spinner_start() {
	[ "$QUIET" -eq 1 ] && return 0
	[ -t 1 ] || {
		printf '  %s ...\n' "$1"
		return 0
	}
	local label=$1
	(
		local frames='|/-\' i=0 elapsed
		while :; do
			elapsed=$((SECONDS - STARTED_AT))
			printf '\r  %s %s (%ds elapsed) ' "${frames:i++%4:1}" "$label" "$elapsed"
			sleep 0.2
		done
	) &
	SPINNER_PID=$!
	# Detached from job control so its termination never prints "Terminated" over the report.
	disown "$SPINNER_PID" 2>/dev/null || true
}

# Condenses BuildKit's plain output to one line per stage, plus anything that looks like a
# failure. --line-buffered and sed -u are load bearing: without them each stage sits in a pipe
# buffer and the "progress" arrives in one burst at the end, which is no progress at all.
build_filter() {
	grep --line-buffered -E '^#[0-9]+ \[|^#[0-9]+ ERROR|^ERROR|^failed' |
		sed -u 's/^/  /'
}

# Condenses `ollama pull` to one line per 10 percent. ESC is built with sprintf rather than
# written as an escape, which not every awk understands, and fflush() is load bearing: without it
# awk buffers and the progress arrives after the download it was describing.
pull_filter() {
	awk 'BEGIN { RS = "\r"; ESC = sprintf("%c", 27); last = -1 }
		{ gsub(ESC "\\[[0-9;?]*[a-zA-Z]", "") }
		/%/ {
			if (match($0, /[0-9]+%/)) {
				p = substr($0, RSTART, RLENGTH - 1) + 0
				b = int(p / 10)
				if (b != last) { last = b; printf "  pulling %d%%\n", p; fflush() }
			}
		}
		/success/ { print "  pull complete"; fflush() }'
}

spinner_stop() {
	[ -n "$SPINNER_PID" ] || return 0
	kill "$SPINNER_PID" >/dev/null 2>&1 || true
	wait "$SPINNER_PID" 2>/dev/null || true
	SPINNER_PID=""
	[ -t 1 ] && printf '\r\033[K'
	return 0
}

# ---------------------------------------------------------------------------------------------
# Port selection
# ---------------------------------------------------------------------------------------------

# True when nothing is listening on $1.
#
# `ss` returning nothing is the answer this relies on, so port_check_calibrated below proves the
# command can say "taken" before any of its zeroes are believed. An absent ss and a free port
# print the same empty string otherwise.
port_is_free() {
	local port=$1
	[ -z "$(ss -ltnH "sport = :$port" 2>/dev/null)" ]
}

# Binds a port, asserts port_is_free reports it TAKEN, releases it.
#
# Self-contained on purpose: calibrating against a port that happens to be busy on this machine
# would make the calibration depend on the long-lived instance still running, and it would start
# passing for the wrong reason the day that instance is stopped.
port_check_calibrated() {
	command -v ss >/dev/null 2>&1 || die "ss is not installed, so no port check here can be trusted"
	local probe_port
	# Node picks a free ephemeral port, prints it, and holds it until killed.
	exec {probe_fd}< <(node -e '
		const s = require("node:net").createServer();
		s.listen(0, "127.0.0.1", () => { console.log(s.address().port); });
		setTimeout(() => process.exit(0), 30000);
	')
	read -r probe_port <&$probe_fd || die "could not start the port-check calibration listener"
	[ -n "$probe_port" ] || die "the port-check calibration listener reported no port"
	if port_is_free "$probe_port"; then
		exec {probe_fd}<&-
		die "port_is_free says $probe_port is free while this script is listening on it, so the port check reads nothing and every free verdict below would be meaningless"
	fi
	exec {probe_fd}<&-
	say "  ok: port check calibrated (reported $probe_port taken while it was held)"
}

# Sets APP_PORT and PORT_VERDICT.
#
# The retry is deliberately not a bare increment. A bare increment starts a second stack beside a
# stale one, which is the inherited state this whole script exists to prevent, arriving through
# the mechanism meant to avoid a collision.
select_port() {
	local port=$DEFAULT_PORT attempt=0 holder

	while [ "$attempt" -lt "$PORT_ATTEMPTS" ]; do
		if port_is_free "$port"; then
			APP_PORT=$port
			if [ "$port" -eq "$DEFAULT_PORT" ]; then
				PORT_VERDICT="port $port was free"
			else
				PORT_VERDICT="$DEFAULT_PORT held by something else, using $port"
			fi
			return 0
		fi

		holder=$(port_holder "$port")
		if [ "$holder" = ours ]; then
			say "  port $port is held by a previous run of this script, removing it"
			teardown_stack
			if port_is_free "$port"; then
				APP_PORT=$port
				PORT_VERDICT="reused $port after removing a previous run"
				return 0
			fi
			die "removed a previous run but port $port is still held"
		fi

		say "  port $port is held by something other than this script, trying $((port + 1))"
		port=$((port + 1))
		attempt=$((attempt + 1))
	done

	die "no free port in $DEFAULT_PORT..$((DEFAULT_PORT + PORT_ATTEMPTS)); free one or stop what is holding them"
}

# ---------------------------------------------------------------------------------------------
# Teardown. Reached from the trap on every exit path, and from select_port when reclaiming.
# ---------------------------------------------------------------------------------------------

compose() {
	# --env-file /dev/null stops Compose auto-loading ./.env for interpolation. The overlay's
	# `env_file: !reset []` is the other half: without it the base file's `env_file: - .env`
	# would load this repository's real .env into the container. Both are needed, and this
	# repository HAS a .env.
	"${DETACH[@]}" docker compose -p "$PROJECT" --env-file /dev/null \
		-f docker-compose.yml -f docker-compose.ai.yml -f "$OVERLAY" "$@"
}

# Removes what this script created, and nothing else.
#
# Scoped by -p on every command, and the volume is named in full and checked against the exact
# list first. `down -v` is deliberately not used: it removes every volume the project declares,
# including the model cache that is meant to survive.
teardown_stack() {
	local vol
	if [ -f "$OVERLAY" ]; then
		compose down --remove-orphans --timeout 5 >/dev/null 2>&1 || true
	fi
	# Belt and braces: if the overlay is gone the compose call above is skipped, so name the
	# containers directly. Exact names, never a filter that could widen.
	"${DETACH[@]}" docker rm -f "$APP_CONTAINER" "$OLLAMA_CONTAINER" >/dev/null 2>&1 || true

	while IFS= read -r vol; do
		[ -n "$vol" ] || continue
		is_our_volume "$vol" || die "refusing to remove volume '$vol': it is not one of this script's own"
		"${DETACH[@]}" docker volume rm -f "$vol" >/dev/null 2>&1 || true
	done < <(removable_volumes)

	"${DETACH[@]}" docker network rm "$NETWORK" >/dev/null 2>&1 || true
}

# The calibration the whole teardown rests on: a teardown that removed nothing and one that
# worked print the same success line otherwise.
assert_teardown_removed_something() {
	local existed=$1 vol
	# An empty list would make the loop below pass having inspected nothing, which is this
	# assertion failing in exactly the way it exists to prevent. Found by asking what a break
	# patch emptying removable_volumes would do: every check still went green.
	[ -n "$(removable_volumes)" ] ||
		die "removable_volumes is empty, so the teardown assertion would check nothing"
	# Named explicitly as well as walked, so the check cannot go vacuous if that list changes.
	if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
		die "teardown left the data volume $DATA_VOLUME behind"
	fi
	while IFS= read -r vol; do
		[ -n "$vol" ] || continue
		if docker volume inspect "$vol" >/dev/null 2>&1; then
			die "teardown left volume $vol behind"
		fi
	done < <(removable_volumes)
	if [ "$existed" -eq 1 ]; then
		say "  ok: $DATA_VOLUME existed before teardown and is gone after"
	else
		say "  ok: nothing of this script's was running (no data volume to remove)"
	fi
	if docker ps -a --format '{{.Names}}' | grep -qx "$APP_CONTAINER"; then
		die "teardown left container $APP_CONTAINER behind"
	fi
}

CLEANED=0
INTERRUPTED=0

# Ctrl-C and SIGTERM land here rather than on cleanup directly, so the run ends deliberately
# instead of falling out of the wait loop and reporting the wrong cause.
on_interrupt() {
	INTERRUPTED=1
	printf '\n'
	cleanup
	# 130, the conventional 128+SIGINT, not 0: a scripted caller can then tell an interrupted run
	# from a finished one. Written explicitly because bash produced 130 here anyway and code that
	# says 0 while the shell reports 130 is a discrepancy the next reader has to rediscover.
	exit 130
}
# Prefix for the teardown's docker commands. Empty during normal operation; set to (setsid) once
# teardown begins, which moves each docker child into its own process group.
#
# THIS IS WHAT MAKES A SECOND CTRL-C SAFE, and `trap ''` alone is not enough. A terminal delivers
# SIGINT to the whole FOREGROUND PROCESS GROUP, so ignoring it in this shell still leaves the
# `docker compose down` child receiving it and free to abort halfway, which is the one state that
# leaves containers behind. Measured before the fix: five presses 0.02s apart during teardown
# completed cleanly three times out of three, which is a small sample of a race and not a proof.
# setsid removes the race instead of surviving it.
DETACH=()

cleanup() {
	[ "$CLEANED" -eq 0 ] || return 0
	CLEANED=1
	# Ignored for the duration: an impatient second Ctrl-C is the normal reaction to any pause, and
	# a teardown interrupted halfway is the only way this script leaves the machine dirty.
	trap '' INT TERM
	command -v setsid >/dev/null 2>&1 && DETACH=(setsid)
	# First, so a Ctrl-C during a wait does not leave a spinner writing over the teardown output.
	spinner_stop
	# Printed BEFORE the work, not after: a silent teardown and a hung one are the same experience.
	[ "$QUIET" -eq 1 ] ||
		printf '\n[%d/%d] tearing down (about a second). A second Ctrl-C will not interrupt this.\n' \
			"$((STEP_N + 1))" "$TOTAL_STEPS"
	local existed=0
	docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1 && existed=1
	STEP_N=$((STEP_N + 1))
	teardown_stack
	assert_teardown_removed_something "$existed"

	if [ "$PURGE" -eq 1 ]; then
		docker volume rm -f "$MODEL_VOLUME" >/dev/null 2>&1 || true
		rm -rf "$WORK_DIR"
		say "  purged the model cache and $WORK_DIR"
	else
		rm -f "$OVERLAY"
		say "  kept $MODEL_VOLUME (the model cache) and $FIXTURE_DIR; --purge removes them"
	fi
	say "  the $PROTECTED_PROJECT project was never addressed by any command above"
}

# ---------------------------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------------------------

preflight() {
	step "preflight"

	assert_project_name_safe "$PROJECT" ||
		die "PROJECT is '$PROJECT', which is the protected long-lived deployment. Refusing."
	say "  ok: project '$PROJECT' is not the protected '$PROTECTED_PROJECT'"

	docker info >/dev/null 2>&1 || die "docker is not available"
	[ -f docker-compose.yml ] || die "run this from the repository root"
	command -v node >/dev/null 2>&1 || die "node is required to generate the synthetic fixtures"

	# A container squatting one of our names that is NOT ours is a refusal, not something to
	# remove. Ours is reclaimed by select_port and by the initial teardown below.
	local name label
	for name in "$APP_CONTAINER" "$OLLAMA_CONTAINER"; do
		label=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$name" 2>/dev/null || true)
		if [ -n "$label" ] && [ "$label" != "$PROJECT" ]; then
			die "container '$name' exists and belongs to project '$label'. Refusing to touch it."
		fi
	done
	say "  ok: no foreign container holds the names this script creates"

	port_check_calibrated

	mkdir -p "$FIXTURE_DIR"
}

# ---------------------------------------------------------------------------------------------
# The generated Compose overlay
#
# Generated rather than tracked as a ninth root compose file: it is derived entirely from the
# constants above, so the two cannot drift, and scripts/check-compose-combinations.sh states that
# every combination it renders must appear in the docs and vice versa. An overlay nobody documents
# would sit outside that invariant.
# ---------------------------------------------------------------------------------------------

write_overlay() {
	cat >"$OVERLAY" <<-YAML
		# GENERATED by scripts/test-env.sh. Edits are lost on the next run.
		services:
		  budgetpilot:
		    # The base file names it 'budgetpilot', which the long-lived deployment is already
		    # using. Docker refuses duplicate container names, so without this override the stack
		    # does not start at all.
		    container_name: $APP_CONTAINER
		    # !reset, not an empty list: the base file's 'env_file: - .env' would otherwise load
		    # this repository's real .env into the container. Sequences MERGE by appending across
		    # -f files, so only !reset actually cancels a key.
		    env_file: !reset []
		    # !override for the same reason: a plain list here would APPEND to the base file's
		    # mapping and leave the app published on 0.0.0.0 as well.
		    ports: !override
		      - '127.0.0.1:$APP_PORT:$APP_PORT'
		    environment:
		      # The internal port matches the published one so that a request to
		      # http://127.0.0.1:$APP_PORT carries an Origin the app accepts, whether it comes
		      # from the browser or from the seeder sharing this container's network namespace.
		      PORT: '$APP_PORT'
		      ORIGIN: http://127.0.0.1:$APP_PORT
		      # Required for plain http: without it the session cookie carries Secure and no
		      # browser will send it back over http, so every login silently fails. See the
		      # header for what this costs.
		      PUBLIC_INSTANCE: 'false'
		      DATABASE_PROVIDER: sqlite
		      DATABASE_URL: file:/data/budgetpilot.db
		      BOOTSTRAP_TOKEN: $BOOTSTRAP_TOKEN
		      TOTP_ENCRYPTION_KEY: $TOTP_ENCRYPTION_KEY
		      RATE_LIMIT_HASH_SECRET: $RATE_LIMIT_HASH_SECRET
		      # Explicit rather than absent: see the header on why bank sync cannot be exercised.
		      BANK_SYNC_ENABLED: 'false'
		      LLM_MODEL: $LLM_MODEL
		  ollama:
		    container_name: $OLLAMA_CONTAINER
		    env_file: !reset []
	YAML
}

# ---------------------------------------------------------------------------------------------
# Boot, seed, report
# ---------------------------------------------------------------------------------------------

wait_for_app() {
	local deadline=$((SECONDS + 180))
	spinner_start "waiting for the app to migrate and answer on :$APP_PORT"
	while [ "$SECONDS" -lt "$deadline" ]; do
		# A crashed container is reported now rather than at the timeout, so a boot failure reads
		# as a boot failure instead of as a slow start.
		if ! docker ps --format '{{.Names}}' | grep -qx "$APP_CONTAINER"; then
			spinner_stop
			docker logs "$APP_CONTAINER" 2>&1 | tail -30 >&2
			die "the app container stopped while starting"
		fi
		if curl -fs -o /dev/null "http://127.0.0.1:$APP_PORT/login" 2>/dev/null; then
			spinner_stop
			say "  ok: /login answered on 127.0.0.1:$APP_PORT"
			return 0
		fi
		sleep 2
	done
	spinner_stop
	docker logs "$APP_CONTAINER" 2>&1 | tail -30 >&2
	die "the app did not answer on 127.0.0.1:$APP_PORT within 180s"
}

wait_for_ollama() {
	local deadline=$((SECONDS + 120))
	spinner_start "waiting for ollama"
	while [ "$SECONDS" -lt "$deadline" ]; do
		if docker exec "$OLLAMA_CONTAINER" ollama list >/dev/null 2>&1; then
			spinner_stop
			say "  ok: ollama answered"
			return 0
		fi
		sleep 2
	done
	spinner_stop
	die "ollama did not answer within 120s"
}

ensure_model() {
	# An exact match on the first column. A substring match would accept a different quantisation
	# of the same family and then fail at generation time.
	if docker exec "$OLLAMA_CONTAINER" ollama list 2>/dev/null |
		awk 'NR > 1 { print $1 }' | grep -qx "$LLM_MODEL"; then
		say "  ok: $LLM_MODEL already in $MODEL_VOLUME, no download"
		return 0
	fi
	say ""
	say "  Pulling $LLM_MODEL, about ${MODEL_DOWNLOAD_MB} MB. This is minutes on a first run,"
	say "  and seconds on every run after: the cache volume $MODEL_VOLUME survives teardown."
	say ""
	if [ "$QUIET" -eq 1 ]; then
		docker exec "$OLLAMA_CONTAINER" ollama pull "$LLM_MODEL" >/dev/null 2>&1 ||
			die "could not pull $LLM_MODEL"
	elif [ -t 1 ]; then
		# A terminal gets ollama's own byte-and-rate progress bar, which is the best available
		# answer to "is this working". -t so ollama knows it has one.
		docker exec -t "$OLLAMA_CONTAINER" ollama pull "$LLM_MODEL" ||
			die "could not pull $LLM_MODEL"
	else
		# Redirected to a file or a pipe, ollama still emits its redraw sequences, which turn a
		# log into thousands of unreadable carriage returns. Condensed to one line per 10%.
		docker exec "$OLLAMA_CONTAINER" ollama pull "$LLM_MODEL" 2>&1 | pull_filter
		# PIPESTATUS, not $?: $? here is the filter's status, and a failed pull through a
		# successful filter would report success.
		[ "${PIPESTATUS[0]}" -eq 0 ] || die "could not pull $LLM_MODEL"
	fi
}

# Runs a script inside the app image, sharing the app's network namespace and its data volume.
#
# The app image rather than a stock node image, deliberately: better-sqlite3 and Prisma's engines
# are native ELFs compiled for THIS runtime, and a host node_modules built on a different libc
# would be a coin flip. Everything scripts/seed-dev.mjs imports (database/client.ts,
# naming/nameKey.ts, domain/money.ts) already ships in the image, so only the script itself is
# mounted.
run_in_app_image() {
	local script=$1 host_path=$2
	docker run --rm \
		--network "container:$APP_CONTAINER" \
		--user 65532 \
		--read-only --tmpfs /tmp \
		-v "$DATA_VOLUME:/data" \
		-v "$host_path:/app/scripts/$script:ro" \
		-e DATABASE_PROVIDER=sqlite \
		-e DATABASE_URL=file:/data/budgetpilot.db \
		-e "BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN" \
		-e "TOTP_ENCRYPTION_KEY=$TOTP_ENCRYPTION_KEY" \
		-e "RATE_LIMIT_HASH_SECRET=$RATE_LIMIT_HASH_SECRET" \
		-e "SEED_DEV_BASE_URL=http://127.0.0.1:$APP_PORT" \
		-e CHECKPOINT_DISABLE=1 \
		--entrypoint /nodejs/bin/node \
		"$PROJECT-budgetpilot" "scripts/$script"
}

# Reads the row counts BEFORE seeding, which is the one figure that separates a fresh database
# from an inherited one.
#
# It cannot be read after: scripts/seed-dev.mjs deletes this user's transactions and recreates
# exactly 12, so the post-seed count is 12 whether the volume was fresh or not.
#
# BOTH FIGURES ARE MEASURED RATHER THAN REASONED, AND BOTH CORRECTIONS COST A RUN.
#
# A fresh database holds ONE user, not zero: prisma/migrations/sqlite/20260626094000_add_auth_iam
# applies an unconditional INSERT of 'local-backfill-user', the pre-auth row an upgrading instance
# claims. This assertion was first written expecting users=0 and failed on a database that was
# genuinely fresh.
#
# The inherited figure was then written as users=2 by reasoning that seeding adds an account. It
# does not: routes/register/+page.server.ts calls claimBackfillUser, so the first registration
# CLAIMS that row instead of inserting one, and the count stays 1. A deliberately broken teardown
# measured the real inherited state as transactions=12 users=1.
#
# So TRANSACTIONS is the discriminating figure and users is constant across both states. It is
# still read, because a users count that ever moved would mean something changed underneath this
# assumption, and the whole string is compared.
FRESH_COUNTS="preseed transactions=0 users=1"
INHERITED_COUNTS="preseed transactions=12 users=1"

assert_fresh_database() {
	local counts
	cat >"$WORK_DIR/preseed-count.mjs" <<-'JS'
		import { createPrismaClient } from '../src/lib/server/database/client.ts';
		const prisma = createPrismaClient();
		console.log(`preseed transactions=${await prisma.transaction.count()} users=${await prisma.user.count()}`);
		await prisma.$disconnect();
	JS
	counts=$(run_in_app_image preseed-count.mjs "$PWD/$WORK_DIR/preseed-count.mjs" 2>&1 |
		grep -E '^preseed ' || true)
	# An empty read is a failure, never a pass. A count that could not be taken and a count of
	# zero are the same string otherwise.
	[ -n "$counts" ] || die "could not read the pre-seed row counts, so freshness is unverified"
	say "  $counts"
	if [ "$counts" = "$FRESH_COUNTS" ]; then
		say "  ok: fresh database (an inherited volume reads '$INHERITED_COUNTS' here)"
		return 0
	fi
	die "the database is NOT fresh: read '$counts', expected '$FRESH_COUNTS'. Teardown did not remove $DATA_VOLUME."
}

seed() {
	run_in_app_image seed-dev.mjs "$PWD/scripts/seed-dev.mjs"
}

make_fixtures() {
	node scripts/synthetic/make-synthetic.mjs "$FIXTURE_DIR" >/dev/null
	local n
	n=$(find "$FIXTURE_DIR" -type f | wc -l)
	[ "$n" -gt 0 ] || die "the synthetic generator wrote no files to $FIXTURE_DIR"
	say "  $n synthetic fixtures in $FIXTURE_DIR"
}

report() {
	# Printed even under --quiet: it is the result, not progress.
	local elapsed=$((SECONDS - STARTED_AT))
	cat <<-EOF

		  ==========================================================================
		    BudgetPilot is up:   http://127.0.0.1:$APP_PORT
		    Sign in with:        $SEED_EMAIL / $SEED_PASSWORD

		    Port:                $PORT_VERDICT
		    Import fixtures:     $FIXTURE_DIR
		    AI:                  $LLM_MODEL on CPU, in $OLLAMA_CONTAINER

		    Plain http, so PUBLIC_INSTANCE=false and cookies are NOT Secure.
		    Bank sync is disabled and cannot be exercised here (see the header).

		    Ready in ${elapsed}s.
		    Ctrl-C removes the stack, the network and $DATA_VOLUME.
		  ==========================================================================

	EOF
}

main() {
	parse_args "$@" || exit 1

	preflight

	# Anything left from an earlier run goes before the port is chosen, so a stale stack is
	# removed rather than sidestepped.
	step "removing anything left by a previous run"
	teardown_stack
	say "  ok"

	step "choosing a port"
	select_port
	say "  $PORT_VERDICT"

	write_overlay
	trap on_interrupt INT TERM
	trap cleanup EXIT

	step "building the image from the working tree (this is the long one)"
	if [ "$QUIET" -eq 1 ]; then
		compose --progress quiet build >/dev/null
	else
		# BuildKit's own renderer, deliberately not hidden behind a spinner: it names the stage
		# and the layer, which is more than a spinner can say.
		compose --progress plain build 2>&1 | build_filter
		# PIPESTATUS, not $?, which would be the filter's status. A piped chain reports the LAST
		# command, so reading $? here would call a failed build a success.
		[ "${PIPESTATUS[0]}" -eq 0 ] || die "the image build failed"
	fi
	say "  ok: image built"

	step "starting the stack"
	if [ "$QUIET" -eq 1 ]; then
		compose up -d --no-build >/dev/null 2>&1
	else
		compose up -d --no-build
	fi
	wait_for_app
	wait_for_ollama

	step "checking the database is fresh"
	assert_fresh_database

	step "pulling the model if needed"
	ensure_model

	step "seeding"
	local seed_output
	spinner_start "registering the account and writing example data"
	seed_output=$(seed 2>&1) || {
		spinner_stop
		printf '%s\n' "$seed_output" >&2
		die "seeding failed"
	}
	spinner_stop
	[ "$QUIET" -eq 1 ] || printf '%s\n' "$seed_output" | sed 's/^/  /'
	make_fixtures

	report

	if [ "$NO_WAIT" -eq 1 ]; then
		say "  --no-wait: tearing down now"
		return 0
	fi

	say "  waiting. Ctrl-C to tear down."
	# Waits on a process rather than polling for a condition, so this loop cannot report finished
	# while the stack is still up.
	while docker ps --format '{{.Names}}' | grep -qx "$APP_CONTAINER"; do
		sleep 5
	done
	[ "$INTERRUPTED" -eq 1 ] || say "  the app container went away, tearing down"
}

# Sourced by scripts/test-env.spec.sh, which wants the definitions above and none of the actions
# below. Must be the last thing before main.
[ "${TEST_ENV_LIB_ONLY:-0}" = 1 ] && return 0

main "$@"
