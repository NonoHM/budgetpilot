---
name: ship
description: Use when taking a BudgetPilot issue or branch to a merged pull request ("ship #N", "fix #N", "take #N", "finish the PR on this branch"), or when resuming a PR that is not merged yet.
argument-hint: '[issue number or branch]'
---

# Ship a PR

One issue to one merged PR. AGENTS.md is the rulebook and is not restated here; this is the order,
and the places where each barrier lies.

## Steps

1. **Declare the tier in your first message, before reading code deeply**, with the clause of
   AGENTS.md « How much rigour a change earns » that decides it. The tier chooses the techniques
   below, not only their amount.
2. **Read the issue and every comment** (`gh issue view N --json title,body,comments,labels`) and any
   ruling it links. Every claim the issue makes about the code is a premise: read the code before
   planning on it, and count the premises that failed in your report.
3. **Branch from a verified base.** `git fetch origin`, then assert `git rev-parse origin/main` equals
   `git ls-remote origin refs/heads/main | cut -f1`, then branch from `origin/main` (or the stacked
   base your brief names). `npm ci`, then `npm run db:generate`: nothing type-checks without the
   clients. Clean tree, atomic commits.
4. **On a defect the order is fixed** (AGENTS.md « Order »): measure, write the test that reproduces
   the measured figure and watch it go red, fix, break each clause the test claims, and check the
   measurement returns. On a feature, red before green with superpowers:test-driven-development. The
   break mechanics (unique target, inverse patch, restore in a `finally`, the four meanings of a
   green) are AGENTS.md « After writing »; the personal `calibrate` skill carries them as steps where
   it is installed.
5. **Write the code to [references/code.md](references/code.md).** It covers centralisation, secure
   coding, strings, and the UI path, which starts with a canvas when no plate draws the screen.
6. **Tier 3 only: [references/tier3.md](references/tier3.md)** for the three engines, the ownership
   db-smoke and the contradiction pass. Nothing opens a tier 3 PR before that pass.
7. **A screen moved: use the `walk` skill** at 390 and 1280 on the build, before the PR.
8. **Run every barrier in [references/barriers.md](references/barriers.md)** and read each figure.
   Each one lies in a known direction, and the file says which.
9. **Write the PR to [references/pr-body.md](references/pr-body.md)**, scan it, open it, read it back.
10. **Merge, depending on who you are:**
    - **An implementation session under a controller**: never merge, never arm `gh pr merge --auto`,
      never push to `main`. On tier 3, push the branch and do not open the PR: the controller runs
      the contradiction pass first.
    - **The controller, or a session working alone**: read the PR, then merge with
      `docs/superpowers/tools/merge_pr.sh <n>`, which brings a behind branch up to date, waits for
      every check, runs the pre-merge leak check and gitleaks, calibrated, and squash-merges (owner's
      ruling of 2026-09-26: no human approval step, a gate per risk instead). If the owner said to
      hand them the merge, stop at green and say so.
11. **Report on one screen**: the PR and its state; what it closes and what it does NOT do; the
    first-step measurement with its calibration; each break (clause, red or green, which two states it
    separates); the gate figures as read; screenshots by path and what the eye would fail on; the
    findings filed. Never overstate what was verified.

A finding outside the PR's scope is filed (`github-issues`, body written to a file), not fixed, unless
it meets the bar in AGENTS.md « Security boundaries ». Say which in the report.
