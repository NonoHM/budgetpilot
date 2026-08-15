# BudgetPilot Agent Guide

Local-first personal budgeting web app. Privacy is a design constraint: no bank cloud sync,
no scraping, no mandatory external calls. Optional features (Ollama, PSD2 via Enable
Banking) are opt-in behind explicit config and host allowlists.

Measurements behind the rules below live in the issues and PR bodies that produced them.
This file carries the rule; the story is one click away and costs nothing per session.

## Stack

SvelteKit 2 + Svelte 5 runes · TypeScript · Prisma 7.9 · Vitest + Playwright · Tailwind 4 ·
Paraglide i18n (base `en`, ships `fr`) · adapter-node · Node 24.18 · Docker (distroless,
`/data` volume). SQLite by default; PostgreSQL and MySQL/MariaDB via `DATABASE_PROVIDER`.

## Commands

```bash
npm ci                       # install (never `npm install` in CI)
npm run setup                # first run: .env, DB, seed
npm run dev                  # dev server
npm run build                # production build. Catches what check and vitest cannot.
npm run check                # svelte-check over the whole tree
npm run lint                 # prettier --check . && eslint .
npm run test:unit -- --run   # vitest, unit + component
npm run test:db              # db-smoke against a real engine (sqlite locally; CI does pg + mysql)
npm run test:e2e             # playwright, full suite
npm run db:generate          # all three Prisma clients. Nothing type-checks until they exist.
npm run db:schemas           # regenerate pg/mysql schemas from schema.prisma; CI fails if stale
```

Before pushing: `npm run db:generate && npm run check && npm run test:unit -- --run && npm run build`.

Two traps, both measured:

- **Project-wide globs do not work here.** Registered worktrees make eslint emit ~1720
  parse errors and prettier walk generated files. Use per-file paths, or
  `git ls-files -z | xargs -0 npx prettier --check`.
- **Never gate a commit on a piped command.** `npm run check | tail` exits with `tail`'s
  status. Redirect to a file and read `$?`.

## Directory responsibilities

- `src/lib/domain/` pure logic, no `$lib/server`, `$app/*` or Prisma imports. Testable
  without mounting a route.
- `src/lib/server/` everything touching the database, auth, parsing or an external host.
- `src/lib/components/ui/` registered shared components. Check here before writing one.
- `src/routes/` thin: parse, authorize, delegate. Logic that can be a pure function is one.
- `e2e/` Playwright. Shares one database, `workers: 1`, declaration order matters.
- `prisma/migrations/<provider>/` one history per engine; the same change is different SQL.

## Security boundaries

- Never accept a `userId` from the client. Derive it from `locals.user.id`, and scope every
  query by it.
- Never log or expose: banking data, passwords, tokens, session internals, password hashes,
  raw imported-transaction metadata.
- Secrets live in `.env` (gitignored) and nowhere else. Never commit one.
- No external host is called without an explicit configurable allowlist.
- CSP is nonce-based with no `'unsafe-inline'` in `script-src` or `style-src`. A dynamic
  `style=""` is silently blocked; use classes or Svelte's `style:`.
- Validate input positively, against a closed allow list, at the server boundary. A screen
  is an affordance; the server-side check is the control.
- We are self-assessed against **ASVS 5.0.0 Level 2**. The row-by-row position is in
  [SECURITY.md](./SECURITY.md) and is not restated anywhere else.

**Only three things earn an immediate fix outside a task's scope**: a false displayed
figure, a security risk, or data loss. Everything else is an issue, and you say so.

## Restricted paths

- `scr/` is SCREENSHOTS, not scratch. `keys/` holds private keys. `.env` holds secrets.
  None of the three is ever staged, cleaned or emptied.
- **Delete the files you created, never the directory they sit in.** `rm -rf <dir>`,
  `git clean -fd`, `git checkout -- .` and `DELETE FROM <table>` all act on contents you
  never enumerated. Throwaway artifacts go in the session scratchpad.

## Code style

Tooling enforces formatting; do not restate it. What tooling cannot check:

- **Code, comments, docstrings, test names and commit messages in English.** UI strings in
  French through Paraglide, both catalogues moved together.
- **No em dashes in anything we write.** Documentation, commits, PR bodies, issues,
  comments, headings. A string the DESIGN specifies is quoted verbatim and is the one
  exception; the rule governs sentences we author.
- **Never write about future work in the present tense of a promise.** "This will do X"
  fails exactly when the work succeeds, and nobody re-reads a page when a feature ships.
  Name the issue instead.
- Prefer the existing component and the existing helper. Check before adding either.
- Any number an operator might need to move is read from the environment: a default, a hard
  ceiling, refusal rather than clamping, and a boot warning when it differs.

## Writing an assertion

**A green test says nothing until you know what it would have taken to make it red.** The
check for that is the break step below.

### Before writing

- **Which two states does this observation separate, and can it actually separate them?**
- **What does this mechanism report on a tree with no defect at all?** A guard that is wrong
  on a clean tree gets deleted, and takes the working half with it.
- **Pick the fixture that DISTINGUISHES, then check it also reads clearly.** The order is
  the rule; the reverse is the habit. A boundary comparison is tested on the boundary: name
  the single value where the two operators disagree and assert that value. An assertion read
  synchronously after an interaction measures the framework's batching, so wait on a real
  observable state first. A negative assertion over a container whose text is a
  concatenation cannot match; assert positively on the one element carrying the property.
- **A screen that works and a screen that is dead both render**, so geometry separates
  neither. A screen's acceptance is a JOURNEY: arrive, do the thing it exists for, observe
  the outcome elsewhere in the app. Figures come after. A journey completed by a
  programmatic click is not one: add an assertion a human's eye would fail, cheapest being
  that the primary control is unobstructed and fully inside the viewport at each width.
- **A PR shipping a half states what does NOT WORK, not only what is absent.**

### While writing

- **A test is never shaped around the defect it should catch.** Remove the cause, not the view.
- **The test and the thing under test must not share a source.** Not a copied predicate
  (call the production function), not a copied constant (a value you also mock asserts the
  mock), not a retyped oracle (express the canonical rule by calling it).
- **Prove the detector can detect**, with a positive case and with an absolute figure beside
  every absence assertion. "No offenders" is satisfied by a pattern that matches nothing.
- **A test on a refusal asserts the REASON**, never that a refusal happened.

### After writing

- **Break it on purpose and watch it go red.** The only moment a test tells you something.
- **Read the greens per test, using the four meanings.** A green break means: something else
  covers it (a finding about that something else), the line cannot execute (dead code, delete
  it), the break was too small, or it changed no observable behaviour. Tell the last two
  apart by running both versions over a corpus, not by reasoning.
- **Reproduce the figure.** On a measured defect the red must bring back the original value.
- **Undo a break with an inverse patch, never `git checkout --`.** Assert the old text is
  present before writing, so a patch matching nothing fails loudly.

### Order

A test written after the code has seen the implementation and takes its shape, defects
included. Breaking it is what compensates. **On a defect the order is fixed**: measure,
write the test that reproduces the measurement, fix, break, check the measurement returns.

## Distrusting the harness

**The harness lies, and in the comfortable direction.** One that never reaches the code
reports clean refusals; a scanner seeing zero packages passes; a fuzzer reaching no accept
path reports 5000 clean refusals, which reads like a healthy run.

- **Every harness carries its own calibration**: give it a known failing case and check it
  reports it, before believing any negative result. Calibrate the DETECTOR, not the page.
- **Calibrate on the label of the thing you want to count**, not one that travels with it.
- **A check reporting clean must say how many files it read.** Zero files reads as success.
- **Verify the operation RAN.** A refused rebase leaves the tree identical to a clean one.
- **When a strict guard and a quiet guard conflict, the false negative wins.** A guard that
  misses is worse than one that shouts: a shout gets diagnosed, a silence is never noticed.
  Its condition: a strict guard stays AND its message names how to tell a true positive from
  an artefact. A detector that cannot explain its own firing is the one that gets deleted.
- **Every gate is a lower bound.** `check` misses what breaks at runtime, the runtime suite
  misses what breaks at bundle, and neither runs Playwright. Ask which gate reads the
  directory you changed.

## Git and PRs

- **Conventional Commits.** A type is visible in the changelog if it can reach a running
  install, so a dependency bump carrying a CVE fix is `fix(deps):` and never `chore(deps):`.
  Only `ci`, `test` and `style` are hidden. `release-please-config.json` is authoritative.
- One PR per unit of work, atomic commits inside. A security fix always gets its own PR.
- Branch protection is on and is never bypassed. `main` is never committed to directly.
- **Never arm `gh pr merge --auto` before the PR has been read.** Treat an armed PR as
  merged: further work goes on a new branch.
- `Closes #A and #B` closes only #A; repeat the keyword. And never write a closing keyword
  beside an issue number unless you mean it now, including in a sentence about future work.
