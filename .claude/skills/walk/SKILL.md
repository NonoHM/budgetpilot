---
name: walk
description: Use when a BudgetPilot change moved a screen and must be seen working in a real browser at 390 and 1280 before its PR, when the owner asks to walk or check a page, or at the end of a chantier for the blind user test and the clumsy-user pentest.
argument-hint: '[route or PR] | blind'
---

# Walk the app

Two modes. A **walk** checks one change on the build before its PR. The **blind test** checks a
whole chantier on the image before its release: read [references/blind-test.md](references/blind-test.md)
whole before starting one.

A screen that works and a screen that is dead both render, so geometry proves nothing: the walk is a
journey, and every count it reads carries the byte length of the page it read it from.

## A walk

1. **Serve the build, on your own port.** `npm run build`, then
   `npm run preview -- --port <port> --strictPort`. Dev adds `'unsafe-inline'` to `style-src` and
   loads `.env`, so a style or a form action the production image refuses still works in dev. Use dev
   only for a quick look while building. Walking `main` means a tree at `origin/main`: a branch or a
   worktree created with plain `git`, which is allowed (only the worktree SKILL is denied).
2. **Data is synthetic**: `node scripts/synthetic/make-synthetic.mjs <dir under scr/>` (holder Paul
   Mercier) or inline literals, never a real statement. A fresh database already holds one user, so
   freshness is « transactions = 0 », not a user count.
3. **Drive it with a throwaway headless Playwright script** in your scratchpad, against your port.
   The shared `playwright` MCP browser serves one session at a time and can hang at Chrome startup;
   `claude mcp list` reporting it connected says nothing about whether it can open a page.
4. **Per route, a new browser context**, at 390x844 and at 1280x800. A long-lived page dies after a
   few navigations and then answers politely with a few dozen bytes. Print `page.content()`'s length
   beside every count.
5. **Do the journey**: arrive, do the thing the screen exists for, and observe the outcome ELSEWHERE:
   the transactions list, the account total, a database count. A programmatic click is not a
   journey: assert the primary control is unobstructed and wholly inside the viewport at each width,
   and that a focused control is not hidden under the fixed bottom bar at 390 (WCAG 2.2, 2.4.11).
6. **Ask the 30-second question on each screen met for the first time**, before acting: what is this
   screen for, and what do you do first? Then record whether the first action was the right one. A
   screen misread is a finding even when the journey succeeds.
7. **Be the clumsy user** where the change touched the flow (list in
   [references/clumsy-user.md](references/clumsy-user.md)). The oracle for each case: the sentence
   shown, the rows written (counts only), and whether the reader can tell what to do next.
8. **Run axe-core** (WCAG A and AA) at both widths on every screen the change moved.
9. **Screenshots go under `scr/<chantier>/<pr>/`**: check `git check-ignore -v` on the path first,
   look at every image before citing it, and name it in the PR by path, never attach or commit it.

Playwright traps that have cost sessions here: `page.route` globs treat `?` as a one-character
wildcard (use a predicate, `(url) => url.pathname === '/transactions'`, and count the
interceptions); `aria-disabled="true"` makes Playwright wait forever (click the element directly,
with a comment saying why); a second `vite dev` in the tree forces a full reload and loses module
state.

## Report

Per width: the journey and its oracle's answer, the 30-second answers, byte lengths, screenshot
paths, axe violations, and each finding with a severity from 0 to 4 (4: a 500, a blank screen or a
wrong row). Say what was not walked.
