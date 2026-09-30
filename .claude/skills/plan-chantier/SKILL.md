---
name: plan-chantier
description: Use when planning a BudgetPilot release, milestone or chantier ("plan 1.3", "plan the multi-currency version", "what goes in the next release"), or when writing the briefs implementation sessions will run from.
argument-hint: '[release or chantier]'
---

# Plan a chantier

A plan is a reference for briefing PRs, plus the reason behind each ordering decision. It is not an
implementation plan: each PR's own session writes that with superpowers:writing-plans. The plan is
tier 1: nothing in it is measured, and every question that needs a measurement names it, with its
cost, as the first step of a PR.

## Steps

1. **Check every premise before planning on it**, the owner's and your own: what the release is for,
   what an issue says the code does, a severity someone recalls. Read the tree and the tracker. The
   plan opens with « Where the premises failed », counted, in the order they change the plan: a
   premise that fails after the plan is briefed has already been briefed to several sessions.
2. **Inventory in parallel, read-only** (superpowers:dispatching-parallel-agents): the issues on the
   milestone with every comment; the code paths they touch; the design plates and
   `docs/reference/design-referential.md` for anything that renders; what the comparable products do
   (the `cite` skill). Before using any claim that changes an ordering, re-read it yourself.
3. **Separate what is ruled from what is not.** A decision only the owner can take goes in a table:
   question, ruling, REASON, because a ruling without its reason gets proposed again. Ask them all at
   once. Anything reversible you decide, and record where the next reader meets it.
4. **Cut on a chantier boundary.** A release is one chantier or several, never the middle of one: a
   PR blocked on a design session or an open ruling goes to the chantier after. A milestone named for
   a PROPERTY takes an issue only if the issue claims that property.
5. **One unit of work per PR**, each with: the issues it closes, its tier declared now, what it does
   not do, the files it touches, and the standards lines it must satisfy (resolved with `cite`). Each
   PR passes the three questions of AGENTS.md « A task is not a prompt ». Where the starting value
   was not measured, the measurement is the PR's first step.
6. **Chains and parallel work.** PRs that touch the same files form a chain and run in order;
   disjoint chains run in parallel, at most two sessions at once. Give each chain its own port and
   container prefix. The e2e suite has one fixed port, so parallel sessions serialise it on a lock.
7. **Name the boundary**: which PRs let untrusted bytes reach storage, and which only move a screen.
8. **End the chantier with the blind test** (the `walk` skill, blind mode) before the release PR.
9. **Write the plan** to `docs/superpowers/<date>-<name>-plan.md` (gitignored), with a status
   section where RESUME HERE blocks go, newest first. Put the PR list in a tracking issue: it is the
   only form of the plan that survives a clone and that other work can cite.
10. **Write one brief per PR** from [references/brief.md](references/brief.md). The rules live in the
    `ship` skill; a brief does not paste them.

## Report

The premises that failed, the rulings needed (each with your recommendation and its reason), the PR
list with tiers and chains, and what was not read. One screen; the plan file holds the rest.
