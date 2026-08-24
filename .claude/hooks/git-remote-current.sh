#!/usr/bin/env bash
#
# Is the ref you are about to build on actually current with the remote?
#
# ## Why this is a PreToolUse hook and not the SessionStart one
#
# The SessionStart hook runs `git diff --stat HEAD`, which answers a different question: what is in
# the working tree. It says nothing about whether local `main` is current, and it could not have
# caught either occurrence of the trap below.
#
# The obvious fix is to add a fetch to SessionStart. Measured 2026-08-22, that is the wrong place:
# session start is not when the answer is CONSUMED. The answer is consumed when a branch is created
# or a rebase is run, which in the session that produced this hook was forty minutes later. A fetch
# at 09:00 presented as current at 11:00 is a stale figure wearing a fresh one's clothes, which is
# the exact class of error this check exists to catch. So the fetch runs at the moment of use, where
# it cannot go stale, and costs nothing on the sessions that never branch.
#
# ## THE FLAGS ON THE FETCH ARE LOAD BEARING, NOT DEFENSIVE
#
# `timeout 5`, `BatchMode=yes` and `ConnectTimeout=3` are not belt and braces. MEASURED against an
# unroutable remote: a bare `git fetch origin --quiet` was STILL RUNNING at 30 s when an external
# timeout killed it. It does not fail, it waits out the SSH connect budget. Without these three the
# failure mode is a HANG at the moment you type `git rebase`, and a hang there is worse than an
# error, because an error gets read and a hang gets waited on. With them the same case fails
# cleanly in 3.0 s and this hook stays silent.
#
# ## What it catches, both measured in this repository
#
# 1. Local `main` behind `origin/main`. Recorded 2026-08-22 after a rebase dropped a PR's work as a
#    duplicate: local main was one commit behind, and that commit was the SQUASH of the PR whose
#    work was being dropped. Every check made that day was right about what the rebase DID and
#    silent about what it was measured AGAINST.
#
# 2. A ref whose work is already in `origin/main` under different commits. Fired three days later:
#    a local feature branch was not an ancestor of `origin/main`, so it looked unmerged, while
#    `git diff origin/main <ref>` was EMPTY because the branch had been squash-merged. Branching
#    from it would have put twelve duplicate commits in the next PR with nothing going red.
#
# Check 1 catches the first case and catches the second only indirectly. Check 2 is what actually
# settles the second, and it says so in one line instead of leaving a diff to be read.
#
# Warns, never blocks: exit 0 always. A network hiccup must not stop a git command, and this hook
# has no business deciding that a branch point is wrong. It reports; the reader decides.
#
# Silent when everything is current. An empty result here means the same thing the SessionStart
# hook's empty result means, and for the same reason: it was calibrated by being pointed at a real
# instance first. See the calibration note at the end of this file.

set -uo pipefail

payload=$(cat)
command=$(printf '%s' "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")' 2>/dev/null)

# Not a git repository: nothing to say about anything below.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# ---------------------------------------------------------------------------------------------
# STASH GUARD. A different question from the branch-point one below, sharing this hook because it
# shares the moment: both are about building on something other than what you think you are.
#
# MEASURED 2026-08-22, twice in this repository, the second time on the session that had just read
# the written rule. `git stash push -m <msg> -- <pathspec>` saves NOTHING when the pathspec names
# no tracked modification, and there are two ways to get there: the path is clean, or the path is
# UNTRACKED, which stash ignores without `-u`. The bare `git stash pop` on the next line then takes
# `stash@{0}` regardless of whose it is. On the second occurrence that stash belonged to a
# different branch and was applied over work another task had just committed, surfacing a hundred
# lines away as `Parsing error: Merge conflict marker encountered`.
#
# Costs nothing: no network, no fetch, pure local ref reads.
# ---------------------------------------------------------------------------------------------
stash_lines=()
case "$command" in
	*"git stash pop"*|*"git stash apply"*)
		# Only a BARE pop or apply is dangerous. One naming a stash explicitly has already
		# answered the question this guard asks.
		if ! printf '%s' "$command" | grep -q 'stash@{'; then
			if git rev-parse --verify --quiet 'stash@{0}' >/dev/null 2>&1; then
				subject=$(git log -1 --format=%s 'stash@{0}' 2>/dev/null)
				# `On <branch>: msg` and `WIP on <branch>: msg` are the two shapes git writes.
				stash_branch=$(printf '%s' "$subject" | sed -n 's/^\(WIP on\|On\) \([^:]*\):.*/\2/p')
				current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
				if [ -n "$stash_branch" ] && [ "$stash_branch" != "$current_branch" ]; then
					stash_lines+=("[git-stash] stash@{0} was created on '${stash_branch}' and you are on '${current_branch}'. A bare pop takes stash@{0} whoever made it. Pop by name, or check: git stash list")
				fi
				# A stash whose base is not in your history will conflict on content you
				# never wrote, which is the shape that reads like a real merge conflict.
				base=$(git rev-parse --verify --quiet 'stash@{0}^1' 2>/dev/null)
				if [ -n "$base" ] && ! git merge-base --is-ancestor "$base" HEAD 2>/dev/null; then
					stash_lines+=("[git-stash] stash@{0} was taken from a commit that is not in this branch's history, so a conflict here is about a different branch's work rather than yours. A conflicted pop does NOT drop the stash: record 'git rev-parse stash@{0}' first, then resolve with 'git checkout HEAD -- <paths>', never 'git reset --hard'.")
				fi
			fi
		fi
		;;
esac

case "$command" in
	*"git stash push"*|*"git stash save"*)
		# A pathspec that names no tracked modification saves nothing and reports success.
		# Everything after `--` is the pathspec; without a `--` there is nothing to check here.
		if printf '%s' "$command" | grep -q ' -- '; then
			paths=${command#* -- }
			saveable=0
			for path in $paths; do
				case "$path" in -*) continue ;; esac
				status=$(git status --porcelain -- "$path" 2>/dev/null | grep -cv '^??' || true)
				saveable=$(( saveable + ${status:-0} ))
			done
			if [ "$saveable" -eq 0 ]; then
				stash_lines+=("[git-stash] that pathspec names no TRACKED modification, so this stash push saves nothing and still exits 0. Untracked files need -u. A later bare 'git stash pop' would then take somebody else's stash.")
			fi
		fi
		;;
esac

if [ ${#stash_lines[@]} -gt 0 ]; then
	printf '%s\n' "${stash_lines[@]}"
fi

# ---------------------------------------------------------------------------------------------
# BRANCH POINT. Only the commands that CONSUME the answer. A `git status` or a `git log` does not.
# ---------------------------------------------------------------------------------------------
case "$command" in
	*"git switch -c"*|*"git switch --create"*|*"git checkout -b"*|*"git rebase"*|*"git merge"*|*"git worktree add"*) ;;
	*) exit 0 ;;
esac

# No `origin`: nothing to be current with, and nothing to say about it.
git remote get-url origin >/dev/null 2>&1 || exit 0

# See the header. These three flags are the difference between a 3 s failure and a hang.
timeout 5 env GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=3' \
	git fetch origin --quiet >/dev/null 2>&1
fetch_status=$?

git rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0

lines=()

if [ "$fetch_status" -ne 0 ]; then
	# Said out loud rather than swallowed. A check that could not run and a check that found
	# nothing are the same silence otherwise, which is the failure this repository keeps
	# measuring. The figures below are still printed, from whatever `origin/main` was last
	# fetched, and they are labelled as possibly stale rather than presented as current.
	lines+=("[git-remote] could not reach origin (exit ${fetch_status}); figures below are from the LAST fetch and may be stale")
fi

# Check 1: is local `main` behind the remote?
if git rev-parse --verify --quiet main >/dev/null 2>&1; then
	behind=$(git rev-list --count main..origin/main 2>/dev/null || echo 0)
	if [ "${behind:-0}" -gt 0 ]; then
		lines+=("[git-remote] local main is ${behind} commit(s) BEHIND origin/main. Branch from origin/main, not from main.")
	fi
fi

# Check 2: is the ref you are standing on already in origin/main under different commits?
#
# HEAD, plus any local branch named in the command, because `git switch -c new old` and
# `git rebase --onto <ref>` both name their start point there rather than standing on it.
refs=("HEAD")
for word in $command; do
	word=${word#refs/heads/}
	if git show-ref --verify --quiet "refs/heads/${word}" 2>/dev/null; then
		refs+=("$word")
	fi
done

seen=""
for ref in "${refs[@]}"; do
	sha=$(git rev-parse --verify --quiet "${ref}^{commit}" 2>/dev/null) || continue
	case "$seen" in *"$sha"*) continue ;; esac
	seen="${seen} ${sha}"

	# Contained in origin/main already: nothing to say.
	if git merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
		continue
	fi

	name=$(git rev-parse --abbrev-ref "$ref" 2>/dev/null || echo "$ref")

	# NOT an ancestor and yet the trees agree: the work is in origin/main under DIFFERENT
	# commits, which is what a squash merge looks like from here. This is the line that would
	# have replaced reading a diff by hand.
	if git diff --quiet origin/main "$sha" 2>/dev/null; then
		count=$(git rev-list --count origin/main.."$sha" 2>/dev/null || echo "?")
		lines+=("[git-remote] ${name} has the SAME TREE as origin/main but is not an ancestor of it: its work is already merged, almost certainly as a squash. Building on it would add ${count} duplicate commit(s). Branch from origin/main.")
		continue
	fi

	refbehind=$(git rev-list --count "${sha}"..origin/main 2>/dev/null || echo 0)
	if [ "${refbehind:-0}" -gt 0 ]; then
		lines+=("[git-remote] ${name} is ${refbehind} commit(s) behind origin/main.")
	fi
done

# Silent on a clean answer.
[ ${#lines[@]} -eq 0 ] && exit 0

printf '%s\n' "${lines[@]}"
exit 0

# CALIBRATION, and it is why an empty result from this hook means anything.
#
# Pointed at two real instances before any absence was believed, in the repository state that
# produced it on 2026-08-22:
#   - local `main` two commits behind origin/main  -> check 1 fired, "2 commit(s) BEHIND"
#   - feat/dedupe-key-v3, squash-merged            -> check 2 fired, "SAME TREE ... 12 duplicate"
#   - a branch created from origin/main            -> silent, which is the case that must be silent
#   - a command that is not a branch or rebase     -> silent in 19 ms, which is how you can tell
#                                                     no fetch was performed
#   - origin unroutable                            -> the "could not reach origin" line, in 3.0 s
# A detector proven to fire is what separates an empty result from a broken hook.
#
# The stash guard was calibrated the same way, and one of its cases had to be rebuilt mid-run:
#   - bare pop, stash@{0} from another branch  -> both lines fired
#   - pop naming stash@{N} explicitly          -> silent, which it must be
#   - push -- <UNTRACKED path>                 -> fired (the 2026-08-22 variant)
#   - push -- <CLEAN tracked path>             -> fired (the originally recorded variant)
#   - push -- <tracked and MODIFIED path>      -> silent, which is the case that must be silent
#   - an unrelated git command                 -> silent in 20 ms
# The untracked case first came back SILENT and looked like a hole in the guard. It was not: the
# file used as the fixture had been `git add`ed minutes earlier, so it was genuinely saveable and
# the guard was right. The fixture had changed under the test. Same lesson as the note above, one
# layer in: a calibration is a measurement, so it goes stale, and an empty result is a claim about
# the state you actually had rather than the state you meant to build.
#
# The last of those five took two attempts, and the first attempt is the reason this note exists.
# It set `GIT_CONFIG_COUNT` to point `remote.origin.url` at an unroutable host, the hook printed
# nothing, and that read exactly like "the failure branch does not fire". Git does not resolve a
# remote URL through `GIT_CONFIG_*`: the override never took, the fetch SUCCEEDED, and the hook was
# right to stay quiet. The harness was being measured, not the hook. A real clone with a real
# `git remote set-url` is what made the branch fire. An empty result is a claim about whatever was
# actually exercised, which is not always the thing you meant to exercise.
