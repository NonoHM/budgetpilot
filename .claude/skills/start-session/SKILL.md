---
name: start-session
description: Start or resume a BudgetPilot working session from the newest RESUME HERE block, and close it with a new one.
argument-hint: '[what this session is for]'
disable-model-invocation: true
allowed-tools: Bash(bash .claude/skills/start-session/scripts/state.sh)
---

# Start a session

The state below was read when this skill loaded. It is a snapshot: re-read anything you act on later.

!`bash .claude/skills/start-session/scripts/state.sh`

The owner's note for this session, if any: $ARGUMENTS

## Before any work

1. **Reconcile the snapshot with the RESUME HERE block.** For every branch the block names, the
   worktree HEAD must equal its remote and the SHA the block recorded, and the tree must be clean. A
   mismatch is the first line of your first report, before any plan.
2. **Treat every UNCOMMITTED worktree as a possible open break.** A break in uncommitted new code is
   an ABSENT line, not a removed one, so no diff read and no signature grep can find it. Ask the
   session that owned it, or read the break runner's restore copy. If neither exists, save the work
   as a patch, reset to the pushed HEAD, and re-apply it under a fresh red and break cycle. Never
   clear a worktree from its diff alone, and never delete one you did not create.
3. **Check what moved since the block was written.** The block is a snapshot too: read the open PRs
   and the runs on main above, and `gh issue list` for anything filed since. The tracker is
   authoritative for open work.
4. **Choose one piece.** Anything meeting the bar in AGENTS.md « Security boundaries » comes first,
   whatever the block's order; otherwise the block's next step. One piece per sitting, merged by its
   end if it can be. At most two implementation sessions at once, with `sonnet` for tier 1 and 2 and
   `opus` for tier 3 and for contradiction passes.
5. **Declare the tier in your first message, before the work,** with the clause of AGENTS.md « How
   much rigour a change earns » that decides it. A tier found wrong later is reported, not silently
   raised.
6. **Load the skill for the job**: `ship` for a PR, `plan-chantier` for a plan, `walk` for a browser
   check. Decide anything reversible yourself (AGENTS.md, end of « How much rigour a change earns »);
   stop for the owner only where that paragraph says to.

## While working

- Report per PR, one screen: the PR and its state, what it closes and what it does not, the gate
  figures as read, what is left. Detail goes in the PR body, never in chat.
- The owner is a cybersecurity student, not a developer: explain a change as before and after, in
  integrity, confidentiality and availability terms where they fit.
- A figure carries the command that re-derives it; an estimate carries its method in the same
  sentence, or it comes back later as « your measurement ».

## Ending the session

When the piece is merged, the owner stops, or usage runs low:

1. Every branch pushed, every tree clean, no break left in any file. Name any break still in flight.
2. Write a new block at the top of the plan's status section, newest first, headed
   `#### RESUME HERE (<date>, <why the session stopped>)`, with: **Verify first** (what the next
   session checks before trusting this block), **Merged** (PR and merge SHA), **In flight** (branch,
   pushed SHA, what is left, the next step), **Next**, **Filed**. No plan file yet? Create one under
   `docs/superpowers/` (gitignored). Anything that must survive a clone goes in an issue instead.
3. Suggest a name for `/rename`, and say that `/clear` is now safe. Prefer `/clear` with this block
   over `/compact`, which is itself a large request.
