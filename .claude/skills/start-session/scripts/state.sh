#!/usr/bin/env bash
# Prints the state a session starts from: the newest RESUME HERE block, every worktree against its
# remote branch, and what is open on GitHub. Read-only, and it always exits 0, because the skill that
# runs it injects its output: a failing command would abort the skill instead of showing the state.
#
# The skill injects this with `!` and its frontmatter pre-approves exactly `bash
# .claude/skills/start-session/scripts/state.sh` in `allowed-tools`. Measured 2026-09-30: without that
# line the injection is refused before it runs (injected commands cannot prompt), and the command
# renders NOTHING, exit 0, zero turns. Change the path in both places or in neither.
#
# Each network call carries `timeout` and SSH BatchMode for the reason
# .claude/hooks/git-remote-current.sh measured: a bare fetch against an unreachable remote does not
# fail, it hangs, and a hang at session start gets waited on instead of read.

export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=3"
root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not inside a git repository"; exit 0; }
cd "$root" || exit 0

echo "## Newest RESUME HERE block"
# The plan lives in the main checkout's gitignored docs/superpowers/, which a linked worktree does not
# have, so look there through the common git directory.
main_root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
plan=$(grep -l -- 'RESUME HERE' "$main_root"/docs/superpowers/*.md 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
if [ -z "$plan" ]; then
	echo "none found under docs/superpowers/ (read $(ls "$main_root"/docs/superpowers/*.md 2>/dev/null | wc -l) files); the tracker is the state"
else
	echo "file: ${plan#"$main_root"/}  (modified $(date -r "$plan" '+%Y-%m-%d %H:%M'))"
	# The block runs from its heading to the next heading of the same or higher level.
	awk '/^#+ .*RESUME HERE/ && !found { found=1; lvl=index($0, " "); print; next }
	     found && /^#+ / && index($0, " ") <= lvl { exit }
	     found { print }' "$plan"
fi

echo
echo "## Worktrees that need a look (dirty, or not equal to their remote branch)"
remote=$(timeout 10 git ls-remote --heads origin 2>/dev/null)
[ -z "$remote" ] && echo "(origin unreachable: every remote column below is unknown, not equal)"
# A branch whose pull request merged is finished even when its remote moved afterwards (the merge
# script updates a branch that is behind), so it is counted, not listed, unless it is dirty.
merged=$(timeout 20 gh pr list --state merged -L 2000 --json headRefName --jq '.[].headRefName' 2>/dev/null)
total=0
quiet=0
done_count=0
while read -r wt; do
	total=$((total + 1))
	branch=$(git -C "$wt" symbolic-ref --short -q HEAD || echo "(detached)")
	head=$(git -C "$wt" rev-parse --short HEAD 2>/dev/null)
	dirty=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l)
	rsha=$(printf '%s\n' "$remote" | awk -v r="refs/heads/$branch" '$2==r {print substr($1,1,7)}')
	if [ -z "$remote" ]; then cmp="remote ?"; elif [ -z "$rsha" ]; then cmp="no remote branch"; elif [ "$rsha" = "$head" ]; then cmp="= remote"; else cmp="remote is $rsha"; fi
	if [ "$dirty" -eq 0 ] && [ "$cmp" = "= remote" ]; then quiet=$((quiet + 1)); continue; fi
	if [ "$dirty" -eq 0 ] && printf '%s\n' "$merged" | grep -qxF -- "$branch"; then done_count=$((done_count + 1)); continue; fi
	note=""
	[ "$dirty" -gt 0 ] && note="  UNCOMMITTED: possible open break"
	printf '%s  %s  %s  %s  dirty %s%s\n' "${wt#"$main_root"/}" "$branch" "$head" "$cmp" "$dirty" "$note"
done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')
echo "read $total worktrees: $quiet clean and equal to their remote, $done_count clean with a merged PR (removable), not listed; merged heads read: $(printf '%s\n' "$merged" | grep -c .) (limit 2000)"
echo "stashes: $(git stash list | wc -l)"
echo "origin/main: $(printf '%s\n' "$remote" | awk '$2=="refs/heads/main"{print substr($1,1,7)}')  local main: $(git rev-parse --short main 2>/dev/null)"

echo
echo "## Open pull requests"
timeout 15 gh pr list --state open --json number,title,headRefName,isDraft \
	--jq '.[] | "#\(.number) \(.headRefName)\(if .isDraft then " (draft)" else "" end): \(.title)"' 2>/dev/null ||
	echo "(gh unavailable)"
echo
echo "## Last runs on main"
timeout 15 gh run list --branch main -L 3 --json workflowName,conclusion,headSha \
	--jq '.[] | "\(.workflowName): \(.conclusion // "running") at \(.headSha[0:7])"' 2>/dev/null ||
	echo "(gh unavailable)"
exit 0
