---
name: cite
description: Use before writing a standard's identifier into a BudgetPilot PR, issue, doc or comment (ASVS, AISVS, WCAG, CWE, ATT&CK, ATLAS, NIST, CIS, ANSSI, ISO/IEC), before calling something industry practice, and when asked what Actual Budget, Firefly III, YNAB or Monarch do.
argument-hint: '[identifier or question]'
---

# Cite what you read

An identifier with plausible text is the failure this skill exists for: it reached a published page
here once (#650). Every citation is resolved from a primary text before it is written, and quoted
inline, because the local copies are gitignored and a reader has only the quote.

## Standards

Which standards bind, and where, is AGENTS.md « References »; the row-by-row ASVS position is
`SECURITY.md`. Their standing decides the verb: ASVS 5.0.0 Level 2 is what we are held to. MITRE, NIST
and CIS are « to explore », and ANSSI is « proposed, not mapped »: cite them as read and relevant, never
as satisfied.

1. **ASVS and AISVS: resolve before writing.**
   `node .claude/skills/cite/scripts/resolve.mjs 8.2.2 2.3.1 aisvs:9.2.1` prints each identifier in
   full form with its level and text, marks a level above 2, and exits 1 on any identifier that does
   not exist. The copies it reads: `scripts/security/asvs-5.0-source/` (#601) and
   `scripts/security/aisvs-1.0-source/` (#536, pinned commit in its `PROVENANCE.md`).
2. **Write the full form with the text quoted**: `ASVS v5.0.0-8.2.2` (Level 1): « Verify that ... ».
   Say whether the change SATISFIES the line, CONTRIBUTES to it, or leaves a deviation, and name what
   is still missing. A partial control is not a satisfied requirement.
3. **Everything else** (WCAG 2.2, CWE, ATT&CK, ATLAS, NIST, CIS, ANSSI, ISO/IEC): local copy first.
   `scr/references/guards/` and `scr/references/gates/` each carry a `MANIFEST.md` (URL, date, size,
   sha256): quote the saved file with its MANIFEST URL and date. `scr/` is gitignored, so a linked
   worktree has none: read it in the main checkout (`$(git rev-parse --git-common-dir)/..`). Not
   saved: read the primary page, quote it with URL and date read, and add it to a MANIFEST. Never
   from memory.

## What the comparable products do

The rule, and the products in their order, is AGENTS.md « Before citing an industry pattern ». Their
own documentation or source, never a generic search.

1. **Check the tracker for a ruling first**: `gh issue list --state all --search "<topic>"`. A question
   already ruled is quoted with its issue number, not reopened.
2. **Read every product AGENTS.md lists, or mark it « not read » with the reason.** Each one's own
   text. Source: `git ls-remote` for the commit, then cite
   `repo@<sha>:<path>`. Documentation: the URL and the date read. A summarising fetch that finds no
   mention covers only the pages it read: say which pages.
3. **Write what each does, and why if it says why, in a small table**; then where BudgetPilot matches,
   where it does better, and the reason. « Nobody does X » needs every product's reading behind it.
4. **An academic question** (a method, an algorithm, a usability figure) goes to `literature-review`
   or `paper-lookup`; name the databases searched and the identifiers retrieved.

## Figures

A figure you publish carries the command that re-derives it. An estimate carries its method in the
same sentence, or it comes back later as someone's measurement.
