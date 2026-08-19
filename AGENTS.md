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
npm run lint                 # prettier --check . && eslint .  (CI only, see below)
npm run lint:tracked         # the same two legs over tracked files. Use this one locally.
npm run test:unit -- --run   # vitest, unit + component
npm run test:db              # db-smoke against a real engine (sqlite locally; CI does pg + mysql)
npm run test:e2e             # playwright, full suite
npm run db:generate          # all three Prisma clients. Nothing type-checks until they exist.
npm run db:schemas           # regenerate pg/mysql schemas from schema.prisma; CI fails if stale
```

Before pushing: `npm run db:generate && npm run check && npm run lint:tracked && npm run test:unit -- --run && npm run build`.

Two traps, both measured:

- **Project-wide globs do not work here, so `npm run lint` is a CI-only command.** Registered
  worktrees under `.claude/worktrees/` make eslint emit ~1720 parse errors and prettier walk
  generated files. They are other branches' checkouts and are not deleted to make a command
  convenient. Run `npm run lint:tracked` instead: the same two legs over `git ls-files`, which is
  the file set a fresh clone has, so it is what CI sees. It refuses to report a clean run over an
  empty file list.
- **Never gate a commit on a piped command.** `npm run check | tail` exits with `tail`'s
  status. Redirect to a file and read `$?`.

## The words

`CONTEXT.md` is the glossary. It carries only terms that were AMBIGUOUS IN THE CODE at some point,
and each entry says what confusing them cost, because that is the part a reader acts on. One of them
ate a transaction. Read it before naming a field that means nearly the same thing as one that
already exists.

**A change that renames, splits or retires a domain term updates `CONTEXT.md` in the same PR**,
with what confusing the two cost rather than a definition. Same reason the referential index above
is updated by the wave that adds a brick: a page nobody is required to touch records nothing, and
the cost is only knowable by whoever just paid it.

## Directory responsibilities

- `src/lib/domain/` pure logic, no `$lib/server`, `$app/*` or Prisma imports. Testable
  without mounting a route.
- `src/lib/server/` everything touching the database, auth, parsing or an external host.
- `src/lib/components/ui/` registered shared components. Check here before writing one.
  `docs/reference/design-referential.md` maps each referential brick to its file, records what
  each wave has added to the referential, and names the gaps a plate flagged and did not fill.
- `src/routes/` thin: parse, authorize, delegate. Logic that can be a pure function is one.
- `e2e/` Playwright. Shares one database, `workers: 1`, declaration order matters.
- `prisma/migrations/<provider>/` one history per engine; the same change is different SQL.
- `scripts/synthetic/` the generators for bank-statement fixtures. Their OUTPUT belongs under
  `scr/`, which is gitignored; the generators are tracked so the rule below has a substitute
  that survives a clone.

## Never publish anything derived from a real statement

Issues, PRs, tests, commit messages and screenshots. A public repository keeps the EDIT HISTORY
of an issue body, so redacting afterwards removes the text and not the record.

Re-identification does not need an amount or a counterparty name: **a date paired with an
amount, a row count unusual enough to fingerprint a file, a period, a balance or an account
label is enough.** Write the STRUCTURE instead, which is what carries the engineering meaning
anyway — "9 of 66 rows carried a credit", "the debit column is pre-signed".

**And use the substitute, because a rule that forbids without offering a replacement gets broken
the first day somebody is in a hurry:**

```
node scripts/synthetic/make-synthetic.mjs scr/synthetic/out
node scripts/synthetic/make-opaque.mjs    scr/synthetic/opaque 4
```

Deterministic — no `Math.random`, no `Date.now` — so a test can pin a byte. Holder Paul Mercier,
who does not exist. Only the header SHAPES are taken from reality, and those identify nobody.

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

## Writing a sentence for the interface

**Every finding gets closed by adding a sentence, and nobody reads the result as one page.**
That is a structural pressure rather than carelessness: each sentence was right when it was
written, and the screen it was written onto has changed since. So a sentence earns its place
against four questions, and the fourth exists because the first three cannot see it.

1. **Does the control it sits beside already say this?** « Choisissez de nouveau le relevé »
   above a picker labelled « Choisir un fichier » is one sentence for one action.
2. **Does it explain something the reader can already see?** A dialog stating that two runs
   share a period, a count and totals, above two cards showing that period, that count and
   those totals, narrates its own table.
3. **Was it added to close a measured finding, and does the finding still exist?** This is the
   question that PROTECTS text. The memorisation date, the splits-and-tags cost and the three
   collision framings were all earned and none of them may be trimmed for length.
4. **Does another sentence on this same screen already say it?** Questions 1 and 2 check a
   sentence against a control and against visible data. Neither looks at the prose one block
   up, which is where the repetition actually accumulates: a screen grows by one paragraph per
   finding, and the paragraphs are never compared with each other.

**A cut is not a deletion.** Two of the five sentences removed in the wave that produced this
section left the survivor dangling: « Si **elle** a été corrigée » lost its antecedent, and
« **Pourtant** aucune ligne » answered a claim that was no longer there. Read the survivor
aloud on its own before believing the cut is done.

Keep the sentence short enough to be read at 390 px. A string that wraps to four lines on a
phone is one the reader skips, and skipped text is worse than absent text because it still
takes the space.

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
- **Restore in a `finally`, not on the line after the run.** A break patch is a mutation
  with no automatic undo, so an interrupted or throwing break-check leaves the break in the
  working tree, where it reads as code somebody meant to write. Every gate stays green,
  because the test that would catch it is the one the break disabled. If a session ends
  mid-break, the next one looks for it first: an inverted condition, a commented assertion,
  a constant where a call was.

### Order

A test written after the code has seen the implementation and takes its shape, defects
included. Breaking it is what compensates. **On a defect the order is fixed**: measure,
write the test that reproduces the measurement, fix, break, check the measurement returns.

### Every piece correct, the assembly not

**No test written at the level of the thing being built can see this class**, which is why it
gets its own check. Three instances, measured, each costing a session to find:

- **#334**: the four role rows were triggers and the picker was their target. Component specs
  asserted the four buttons EXIST; the picker had its own specs. Neither opened one, so at
  1280 the rows opened nothing and every test was green.
- **The occluded footer**: the action footer was measured and the page it lived on was not.
  The bottom tab bar was painted straight over the primary for two days while the journey
  passed, because Playwright clicks what a human cannot see.
- **The unreachable récapitulatif**: a component state with three component specs and a
  `readOnly` prop **no route ever set**. The plate's own answer to a wrong memorised mapping
  was built, tested, and could not be opened from the running application.

**The check, and it is cheap and mechanical: for any component state, prop or branch, name
the route that produces it in the running application.** If no route does, it is not built, it
is drafted, and specs covering it prove only that the draft is internally consistent.

Nothing else catches it. A nine-PR plan could not, because no PR owned the seam.

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
