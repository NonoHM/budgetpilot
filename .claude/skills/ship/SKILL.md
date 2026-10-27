---
name: ship
# Quoted: unquoted, ` #N` starts a YAML comment and the description ended at `("ship`.
description: 'Use when taking a BudgetPilot issue or branch to a merged pull request ("ship #N", "fix #N", "take #N", "finish the PR on this branch"), or when resuming a PR that is not merged yet.'
argument-hint: '[issue number or branch]'
---

# Ship a PR

One issue, one merged PR. AGENTS.md is the rulebook, not restated; this is the order, and where each
barrier lies.

## Checklist (copy into the final report, each line ticked or `skip: <reason>`)

The owner pasted this order into 23 sessions; a line left out of the report is a line not done.

```
- [ ] Tier declared, with its AGENTS.md clause, before reading code deeply
- [ ] Tier 3: the ruling red as failing tests at agreed seams, before any design
- [ ] Tier 3: design note (at most 10 lines), one contradiction pass on it, before code
- [ ] Tier 2-3: design checked against the leading reference method (`cite`), before code
- [ ] Red before green; each clause broken on purpose and seen red
- [ ] Iterated on targeted suites only
- [ ] Engines, full e2e, walk: ONCE after the last code change, in the background, one at a time
- [ ] Tier 3: contradiction pass on the final code; a second on the fixes; stop at nothing at the bar
- [ ] Reversible choices decided, citing the practice (`cite`); asked only where AGENTS.md says stop
- [ ] Every standard cited through `cite`; research written to docs/superpowers/ before quoting
- [ ] Screen moved: `walk` at 390 and 1280; chantier end: blind test and clumsy-user pentest
- [ ] Out of scope below the bar: filed with a milestone, not folded in
- [ ] Promises ledger empty (step 9)
- [ ] Closing block (step 11)
```

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
9. **Promises ledger, before the PR opens.** List every « heads up », every check you said you
   would run, every code change after the last pass or review, every judgment made without the
   owner. Each becomes done, an issue (number in the body), or dropped with the reason; a residual
   found late is filed, not coded. Then the PR per [references/pr-body.md](references/pr-body.md):
   write, scan, open, read back. The agent hook refuses most first attempts to publish; the shape it
   accepts:
   - the body or message written with the Write tool to a file under `docs/superpowers/tools/`;
   - then ONE separate command with literal arguments: `gh pr create --body-file <path>`,
     `git commit -F <path>`;
   - no variable in a path, no `git -C "$dir"`, no unquoted heredoc, no `python`/`sed`/`xargs`
     wrapping git or gh, no stdin-fed script, never a `core.hooksPath` change.
10. **Merge, by role:**
    - **Implementation session under a controller**: never merge, never arm `gh pr merge --auto`,
      never push to `main`. Tier 3: push the branch, open no PR; the controller runs the pass.
    - **Controller, or alone**: an agent merges its own work only if the owner's settings grant it,
      and only by one path: read the PR, then exactly `docs/superpowers/tools/merge_pr.sh <n>`, the
      maintainer's local script, absent from a clone (waits for every check job, runs leak, PII and
      gitleaks scans calibrated, squash-merges). Never `gh pr merge` directly. Call refused, grant
      absent, or owner said so: stop at green, hand the merge. Never add or widen a permission
      yourself; never route around a refusal.
11. **Report, one screen**: PR and state; closes and does NOT do; first measurement with its
    calibration; each break (clause, red or green, the two states it separates); gate figures as
    read; screenshots by path and what the eye would fail; findings filed; the checklist above.
    Never overstate. Then the **closing block**, unasked (the owner asked for it 50 times):
    - before/after as a small ASCII schema, in integrity, confidentiality, availability terms;
    - where this sits on the roadmap: done, this session, next;
    - what is left, as an estimate in sessions with its method in the same sentence;
    - `/rename <slug>`, and whether `/clear` is safe now and why (nothing in flight, block written).

A finding outside scope is filed with a milestone (`github-issues`, or
`gh issue create --body-file <path>` when the GitHub MCP is down), not fixed, unless it meets the bar
in AGENTS.md « Security boundaries ». Say which.
