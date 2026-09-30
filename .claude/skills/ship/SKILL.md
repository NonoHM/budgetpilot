---
name: ship
description: Use when taking a BudgetPilot issue or branch to a merged pull request ("ship #N", "fix #N", "take #N", "finish the PR on this branch"), or when resuming a PR that is not merged yet.
argument-hint: '[issue number or branch]'
---

# Ship a PR

One issue, one merged PR. AGENTS.md is the rulebook, not restated; this is the order, and where each
barrier lies.

1. **Tier in the first message, before reading code deeply**, with its clause from AGENTS.md « How
   much rigour a change earns ». The tier picks the techniques, not only their amount.
2. **Issue and every comment** (`gh issue view N --json title,body,comments,labels`), plus linked
   rulings. Each claim about the code is a premise: read the code first; count failed premises in the
   report.
3. **Verified base.** `git fetch origin`; assert `git rev-parse origin/main` =
   `git ls-remote origin refs/heads/main | cut -f1`; branch from `origin/main` (or the brief's stacked
   base). `npm ci`, `npm run db:generate` (no clients, no type check). Clean tree, atomic commits.
4. **Defect order is fixed** (AGENTS.md « Order »): measure; test reproducing the measured figure,
   red; fix; break each clause the test claims; measurement returns. Feature: red before green,
   superpowers:test-driven-development. Break mechanics: AGENTS.md « After writing »; as steps, the
   personal `calibrate` skill where installed.
5. **Code to [references/code.md](references/code.md)**: centralised, secure, minimal data, strings,
   gates, the UI path (canvas first when no plate draws the screen).
6. **Tier 3: [references/tier3.md](references/tier3.md)**: three engines, ownership db-smoke,
   contradiction pass. No tier 3 PR before that pass.
7. **Screen moved: `walk` skill**, 390 and 1280, on the build, before the PR.
8. **Every barrier in [references/barriers.md](references/barriers.md)**, each figure read. Each lies
   in a known direction; the file says which.
9. **PR per [references/pr-body.md](references/pr-body.md)**: write, scan, open, read back.
10. **Merge, by role:**
    - **Implementation session under a controller**: never merge, never arm `gh pr merge --auto`,
      never push to `main`. Tier 3: push the branch, open no PR; the controller runs the pass.
    - **Controller, or alone**: an agent merges its own work only if the owner's settings grant it,
      and only by one path: read the PR, then exactly `docs/superpowers/tools/merge_pr.sh <n>` (waits
      for every check job, runs leak, PII and gitleaks scans calibrated, squash-merges). Never
      `gh pr merge` directly. Call refused, grant absent, or owner said so: stop at green, hand the
      merge. Never add or widen a permission yourself; never route around a refusal.
11. **Report, one screen**: PR and state; closes and does NOT do; first measurement with its
    calibration; each break (clause, red or green, the two states it separates); gate figures as
    read; screenshots by path and what the eye would fail; findings filed. Never overstate.

A finding outside scope is filed with a milestone (`github-issues`, body in a file), not fixed,
unless it meets the bar in AGENTS.md « Security boundaries ». Say which.
