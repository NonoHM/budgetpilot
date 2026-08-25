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
anyway: "9 of 66 rows carried a credit", "the debit column is pre-signed".

**And use the substitute, because a rule that forbids without offering a replacement gets broken
the first day somebody is in a hurry:**

```
node scripts/synthetic/make-synthetic.mjs scr/synthetic/out
node scripts/synthetic/make-opaque.mjs    scr/synthetic/opaque 4
```

Deterministic, with no `Math.random` and no `Date.now`, so a test can pin a byte. Holder Paul Mercier,
who does not exist. Only the header SHAPES are taken from reality, and those identify nobody.

## Security boundaries

- Never accept a `userId` from the client. Derive it from `locals.user.id`, and scope every
  query by it.
- **The same rule one object over: any OBJECT REFERENCE a client posts is a claim, not a fact.**
  `accountId`, `batchId`, `mappingId`, `categoryId`, `tagId`, `netWorthAccountId`. The lookup that
  resolves one names `userId` in the SAME where clause, never as a check afterwards, and a
  reference that does not resolve is refused as not-found rather than described. Stated separately
  because the `userId` rule above reads as satisfied the moment no `userId` field is posted, and a
  posted `accountId` passes that reading while deciding which rows a request touches.
  **And it is asserted in `db-smoke`, never only in a unit spec.** A unit spec's fake decides what
  `findFirst` returns, so removing the ownership clause from the query leaves it green. That exact
  green happened in piece 3 of the deduplication chantier, which is why the IDOR battery is against
  a real engine.
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

## How much rigour a change earns

The bar above decides WHAT gets fixed. Nothing decided HOW MUCH ceremony a fix earns, so every
change took the full protocol and a one-line correction cost forty minutes. The name for the
missing rule is **risk-based testing**: "the test approach, in which test activities are selected,
prioritized, and managed based on risk analysis and risk control"
([ISTQB CTFL syllabus v4.0.1](https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf),
section 5.2, page 51). Its point for us is in section 5.2.3, which lists what a risk analysis
decides: the scope carried out, the levels and types performed, **the techniques employed and the
coverage achieved**, and the effort estimated per task. The technique changes with the risk, not
only the amount of it.

Three tiers.

- **Tier 3, full.** Anything stored, anything money passes through, anything irreversible.
  Break-check each change separately, three engines, screenshots at both widths, greens read per
  test.
- **Tier 2, standard.** Behaviour a user meets that can be reverted. Break-check the change, one
  engine, a screenshot if a screen moved.
- **Tier 1, light.** Prose, comments, issue bodies, records. Read it back. No break-check.

**Two clauses, and they are what make the tiers work rather than decorate them.**

- **The tier is declared BEFORE the work, never after.** A tier chosen at the end is chosen by what
  the work turned out to touch, so every task inflates to tier 3 by discovering something, which is
  the state this section exists to leave. Declared first, a tier can be wrong in the direction that
  saves time, and that is the only version of it worth having.
- **A finding made during a tier 1 change goes to the tracker, not into the session.** That is the
  clause that stops a comment correction becoming two hours. The bar above is the only exception and
  it is unchanged: a false displayed figure, a security risk or data loss is fixed now, whatever
  tier the task was declared at.

**Tier 1 is exempt from MEASUREMENT, not from SCRUTINY, and reading is its technique** in the way
the break step is tier 2's. It is not a lighter version of the same check, it is a different one,
which is the whole reason the tiers are named after techniques rather than after amounts. Three of
the most expensive findings of August 2026 came from reading tier 1 material and from nothing else:
an ASVS citation pointing at a requirement the map declares unmet, a comment falsified six hours
after it was written, and a report whose figures had been quoted rather than re-run. No test could
have reached any of the three. So the sentence that has to survive editing is this one: tier 1 says
read it, not skip it.

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
- **No em dashes in prose a reader meets**: UI strings, documentation, commit messages, PR
  and issue bodies. They make text read as generated, and that is a fact about prose, not
  about code. **Code comments are out of scope**, deliberately: the rule used to cover them,
  and the tree carries 2 403 em dashes across 348 source files against 18 across 8 prose
  files. A factor of 45 in one direction is not a rule being broken, it is a rule that was
  never about that surface. Narrowing it here makes it true rather than weaker.
  A string the DESIGN specifies is quoted verbatim and stays as drawn.
  **Two of the four surfaces are gated and two are not, and which is which is stated on
  purpose.** UI strings and documentation are files, so `emDashesInProse.spec.ts` reads them
  and fails; the six deliberate catalogue strings are allowlisted there by key. Commit
  messages and PR bodies are not files and no check in this repository sees them, so they are
  a convention and nothing more. Saying so is the point: a rule that claims an enforcement it
  does not have is the defect this repository spent a release removing from its own screens,
  and an unenforced half that pretends otherwise is how the whole rule drifts back to a
  preference.
- **Never write about future work in the present tense of a promise.** "This will do X"
  fails exactly when the work succeeds, and nobody re-reads a page when a feature ships.
  Name the issue instead.
- **Anything whose output is STORED and later RECOMPUTED must be a pure function of what is
  stored.** Not a preference for pure functions generally: a narrow constraint on a small set,
  and it is what makes three things possible at once, so losing it costs all three. A value that
  reads the clock, a random source, an ambient locale or the network cannot be rebuilt from the
  row that holds it, so the recompute stops working, a property test has nothing it can assert,
  and the next version of the format costs a migration instead of a pass. Three instances today:
  `domain/money.ts`, `import/dedupeRecompute.ts` and the boot recompute that consumes it. Money is
  the clearest, because the fix was a design correction rather than a repair: its one `$lib` import
  failed at container startup after `check`, the unit suite, lint and Playwright all passed, and
  the import path was only the symptom. The cause was a module reaching for an AMBIENT LOCALE, and
  it now imports nothing at all.
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

**For every failure and empty state, ask what the server KNOWS that the reader cannot see.** Four
instances, and the tally is the entry rather than the rule: in each one the code a single frame away
had already worked out why, and a screen told the reader to wait for something that would never
change on its own.

- **The bootstrap token.** « Inscription indisponible » where registration WAS available and only
  the token was wrong. Fixed; its spec compares the two messages in ONE assertion, because asserting
  each separately leaves both correct in isolation and lets them recollapse.
- **The bank list.** One sentence for nine producers, ending « Réessayez plus tard ». For most of
  them later never helps. `docs/bank-sync.md` quoted the sentence and, in the same paragraph, said
  retrying changes nothing: the documentation described the defect and nothing could act on it.
- **The Enable Banking private key.** Reaches the reader through the bank list's `catch`, so a key
  file that does not exist was reported as the bank list being unavailable. Not the same subsystem,
  not a temporary condition, and the screen said both.
- **The AI card.** One sentence for five producers, « Assistant IA indisponible », which reads as
  transient for the four that are not and happened to fit the one that is.

**The sharpest instance needed no new information at all, which is why it is the one to remember.**
`done_reason` arrives on the Ollama response the app already receives and says whether the answer
was cut short. `local-llm.ts` read `message.content` and nothing else, so a truncated answer and an
unparseable one were the same broken string and the same sentence, while needing opposite advice:
truncation is ours and means raise a budget, garbage is the model's and means try another. The
distinction cost one line. **The question is not whether the app could tell. It is whether anyone
read the field that already said so.**

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

**A FOURTH INSTANCE, AND IT IS THE ONE THAT READS AS THE STRONGEST EVIDENCE IN THE REPOSITORY: a
test that performs a production step ITSELF measures that the step is POSSIBLE, not that the
application performs it.** Measured 2026-08-24. `import/roundTripBuckets.db-smoke.ts` runs a real
import, a real export and a real re-import against a real engine, and asserts
`imported=0 duplicate=1, buckets=1, rows=1`, which is exactly the figure that closes #464. It is
green. Between the export and the re-import it resolves the destination account **in the test**,
through a reader the import path does not call, and its own docstring says so in one line that a
reader arriving at the assertions does not reach. Probed through the production functions the route
actually calls: the resolver returns rank 3 with no candidates on that same file, and the route
files it by source into a different account. **The defect is shipping and its guard is green**, and
the handoff for the branch named this issue as one the branch closes.

The seam question above catches this if you ask it of the TEST rather than of the component: **name
the route that performs each step this test performs.** A step the test does for itself is a step
nothing is measuring. The tell is a helper defined in the spec file whose body would be production
code anywhere else, and the fix is not to delete the test, which measures something real, but to
say in its NAME what it measures: a format's sufficiency is not a behaviour.

### A task is not a prompt

Same family, one level up: the seam entries above are about work nobody owned, and this is about
work nobody could DO from the section describing it.

**A task whose section names a symbol that exists in neither the tree nor the section is not a
task, it is a prompt.** The person or agent executing it will fill the hole by inventing something,
and an invented symbol compiles, tests green against itself, and reads exactly like the thing that
was asked for.

Found by grepping the tree for every identifier a plan names, rather than by reading each task
sympathetically. Two instances in one pass, 2026-08-22, on a 14-task plan:

- A task's failing test asserted on `buildImportBucketInput(...)`, a function existing in no task
  of that plan and nowhere in `src/`.
- The same task sized a deletion at three lines. Measured: **10 tests** referenced the field it
  deleted, two of them about a different invariant that survives the change, and two of them
  per-user isolation tests that had to be reinstated elsewhere rather than dropped.

**And the other half is what a task needs in order to survive the hole**: a step that ends in a
FIGURE a partial execution would fail, rather than in an instruction to be careful. One task in
that plan had line-number references that will drift, and it carried
`grep -c 'account\.source'` expecting **0** as its guard.

**That guard was itself blind, and measuring it is the sharper half of this entry.** Its premise
was « two render sites exist, so a count of 1 means one copy was edited ». Measured on the parent
commit: the count was already **1**, not 2, because Prettier had line-broken the second site as
`account\n\t\t\t\t\t.source` and the pattern never matched it on one line. So editing one site
and editing both both produce 0, and the guard had **zero discriminating power** while reading
exactly like a check. It was written by the same session that then praised it.

**So a figure is not a guard until its STARTING value has been measured.** An assertion that a
count ends at 0 says nothing unless you know what it was before, and « two sites exist » was an
assumption about the source, not a reading of it. The correction is one command, run before the
guard is written rather than after: print the count on the unmodified file and check it is the
number the guard's reasoning assumes.

So the check is three questions per task, before it is handed to anyone: **does every symbol this
section names exist in the tree or in this section**, **does this section end in a figure that a
partial execution would fail**, and **was that figure's starting value measured rather than
assumed**.

## Distrusting the harness

**The harness lies, and in the comfortable direction.** One that never reaches the code
reports clean refusals; a scanner seeing zero packages passes; a fuzzer reaching no accept
path reports 5000 clean refusals, which reads like a healthy run.

- **Every harness carries its own calibration**: give it a known failing case and check it
  reports it, before believing any negative result. Calibrate the DETECTOR, not the page.
- **Calibrate on the label of the thing you want to count**, not one that travels with it.
- **A check reporting clean must say how many files it read.** Zero files reads as success.
- **Search with Serena, not grep, when the question is « every site that does X ».** A text search
  answers where you LOOKED, not where it IS, and it fails in the comfortable direction, as a short
  confident answer. Three in this repo: a `fetch(` sweep that would have reported zero, a grep
  scoped to `profiles/` that found three of five call sites, and an `account.findMany` search that
  concluded no screen renders a bucket. Use grep for a literal whose spelling you know; use Serena
  for a question about the code.
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
