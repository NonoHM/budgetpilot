---
name: start-session
description: Start or resume a BudgetPilot working session from the newest RESUME HERE block, and close it with a new one.
argument-hint: '[what this session is for]'
disable-model-invocation: true
allowed-tools: Bash(bash .claude/skills/start-session/scripts/state.sh)
---

# Start a session

State below, read at load. Snapshot: re-read before acting on any line.

!`bash .claude/skills/start-session/scripts/state.sh`

Owner's note: $ARGUMENTS

## Before any work

1. **Reconcile.** Each branch the RESUME HERE block names: worktree HEAD = remote = SHA recorded,
   tree clean. Mismatch = first line of first report.
2. **UNCOMMITTED worktree = possible open break.** A break in new uncommitted code is an ABSENT line:
   no diff read finds it. Ask the owning session, or read the break runner's restore copy; else save
   a patch, reset to pushed HEAD, re-apply under fresh red and breaks. Never clear from a diff alone;
   never delete a worktree you did not create.
3. **What moved since.** Open PRs and main's runs above, `gh issue list` for new issues. Tracker is
   authoritative.
4. **One piece.** The bar (AGENTS.md « Security boundaries ») first, whatever the block's order;
   else the block's next step. One piece per sitting, merged by its end if possible. Max two
   implementation sessions: `sonnet` tier 1-2, `opus` tier 3 and contradiction passes.
5. **Tier in the first message, before work**, with its clause from AGENTS.md « How much rigour a
   change earns ». Found wrong later: report it, never raise it silently.
6. **Skill for the job**: `ship` (a PR), `plan-chantier` (a plan), `walk` (a browser check). Decide
   the reversible yourself (same AGENTS.md section, last paragraph); stop only where it says.

## While working

- Report per PR, one screen: PR and state, what it closes and does NOT, gate figures as read, what is
  left. Detail in the PR body, not chat.
- Explain a change as before/after, in integrity, confidentiality, availability terms.
- A figure carries the command that re-derives it; an estimate carries its method in the same
  sentence.

## Ending the session

When the piece merges, the owner stops, or usage runs low:

1. All branches pushed, trees clean, no break in any file; name any break in flight.
2. New block at the top of the plan's status section: `#### RESUME HERE (<date>, <why stopped>)` with
   **Verify first**, **Merged** (PR, SHA), **In flight** (branch, pushed SHA, left, next step),
   **Next**, **Filed**. No plan file: create one under `docs/superpowers/` (gitignored). What must
   survive a clone goes in an issue.
3. Suggest a `/rename`; say `/clear` is safe. Prefer `/clear` plus this block over `/compact`.
