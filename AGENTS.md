# BudgetPilot Agent Guide

Local-first personal budgeting web app. Privacy is a design constraint: no bank cloud sync,
no scraping, no mandatory external calls. Optional features (Ollama, PSD2 via Enable
Banking) are opt-in behind explicit config and host allowlists.

Every rule here was paid for. The measurement that produced it lives in the issue or the PR body
that produced it, and the rule is what you need in the session. Where a rule cites a number, the
number is a pointer to that record and not a figure to quote.

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

- **`npm run lint` is CI-only: project-wide globs do not work here.** Registered worktrees under
  `.claude/worktrees/` make eslint fail on every file and prettier walk generated files, and they
  are other branches' checkouts rather than something to delete for convenience. `lint:tracked`
  runs the same two legs over `git ls-files`, which is what a fresh clone and CI have, and it
  refuses to report clean over an empty file list.
- **Never quote a barrier's exit code that came from a pipeline**: the status is the last
  command's, so `prettier --check ... | tail` reports 0 on real findings. Redirect and read `$?`,
  or read the `[warn]` count and the `problem` line.
- **A break patch asserts its target is UNIQUE inside the function being broken, and asserts the
  substitution happened.** A `perl -0pi` matching nothing reports success; a pattern present twice
  edits the wrong function. Diff against a pre-break copy after restoring: a break that reports
  green has proved nothing until you have seen the file change.
- **Staging first is part of the tracked sweep.** A new untracked file is invisible to
  `lint:tracked`, which then reports clean over a tree it has not read.

## The words

`CONTEXT.md` is the glossary. It carries only terms that were AMBIGUOUS IN THE CODE at some point,
and each entry says what confusing them cost, because that is the part a reader acts on. One of
them ate a transaction. Read it before naming a field that means nearly the same thing as one that
already exists.

**A change that renames, splits or retires a domain term updates `CONTEXT.md` in the same PR**,
with what confusing the two cost rather than a definition. Same reason
`docs/reference/design-referential.md` is updated by the wave that adds a brick: a page nobody is
required to touch records nothing, and the cost is only knowable by whoever just paid it.

## Directory responsibilities

- `src/lib/domain/` pure logic, no `$lib/server`, `$app/*` or Prisma imports. Testable
  without mounting a route.
- `src/lib/server/` everything touching the database, auth, parsing or an external host.
- `src/lib/components/ui/` registered shared components. Check here before writing one.
  `docs/reference/design-referential.md` maps each referential brick to its file, records what
  each wave added, and names the gaps a plate flagged and did not fill.
- `src/routes/` thin: parse, authorize, delegate. Logic that can be a pure function is one.
- `e2e/` Playwright. Shares one database, `workers: 1`, declaration order matters.
- `prisma/migrations/<provider>/` one history per engine; the same change is different SQL.
- `scripts/synthetic/` the generators for bank-statement fixtures. Their OUTPUT belongs under
  `scr/`, which is gitignored; the generators are tracked so the rule below has a substitute that
  survives a clone.

## Never publish anything derived from a real statement

Issues, PRs, tests, commit messages and screenshots. A public repository keeps the EDIT HISTORY
of an issue body, so redacting afterwards removes the text and not the record.

Re-identification does not need an amount or a counterparty name: **a date paired with an
amount, a row count unusual enough to fingerprint a file, a period, a balance or an account
label is enough.** Write the STRUCTURE instead, which is what carries the engineering meaning
anyway: "9 of 66 rows carried a credit", "the debit column is pre-signed".

**Use the substitute, because a rule that forbids without offering a replacement gets broken the
first day somebody is in a hurry:**

```
node scripts/synthetic/make-synthetic.mjs scr/synthetic/out
node scripts/synthetic/make-opaque.mjs    scr/synthetic/opaque 4
```

Deterministic, with no `Math.random` and no `Date.now`, so a test can pin a byte. Holder Paul
Mercier, who does not exist. Only the header SHAPES are taken from reality, and those identify
nobody.

## Security boundaries

- Never accept a `userId` from the client. Derive it from `locals.user.id`, and scope every
  query by it.
- **The same rule one object over: any OBJECT REFERENCE a client posts is a claim, not a fact.**
  `accountId`, `batchId`, `mappingId`, `categoryId`, `tagId`, `netWorthAccountId`. The lookup that
  resolves one names `userId` in the SAME where clause, never as a check afterwards, and a
  reference that does not resolve is refused as not-found rather than described. Stated separately
  because the `userId` rule reads as satisfied the moment no `userId` field is posted.
  **Asserted in `db-smoke`, never only in a unit spec**, because a unit spec's fake decides what
  `findFirst` returns, so removing the ownership clause leaves it green.
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

**Only four things earn an immediate fix outside a task's scope**: a false displayed figure, a
security risk, data loss, or data written wrong that looks right. Everything else is an issue,
and you say so.

The fourth is the test for the other three: the bar catches what a user cannot catch from the
screen. A false figure is visible, a lost row is absent, a breach is discovered; a wrong value that
renders correctly is invisible until something downstream depends on it. **This paragraph is the
single definition of the bar, and anywhere else that needs it references here rather than
respelling it.**

## How much rigour a change earns

The bar at the end of « Security boundaries » decides WHAT gets fixed; this decides how much
ceremony the fix earns. The rule is **risk-based testing** (ISTQB CTFL v4.0.1 section 5.2.3, cited
under « References »), and its point for us is that a risk analysis decides **the techniques
employed**, not only the effort: the technique changes with the risk, not only the amount of it.

- **Tier 3, full.** Anything stored, anything money passes through, anything irreversible.
  Break-check each change separately, three engines, screenshots at both widths, greens read per
  test.
- **Tier 2, standard.** Behaviour a user meets that can be reverted. Break-check the change, one
  engine, a screenshot if a screen moved.
- **Tier 1, light.** Prose, comments, issue bodies, records. Read it back. No break-check.

**Two clauses make the tiers work rather than decorate them.**

- **The tier is declared BEFORE the work, never after.** A tier chosen at the end is chosen by what
  the work turned out to touch, so every task inflates to tier 3 by discovering something.
  Declared first, a tier can be wrong in the direction that saves time, and that is the only
  version of it worth having.
- **A finding made during a tier 1 change goes to the tracker, not into the session.** That is the
  clause that stops a comment correction becoming two hours. The bar at the end of « Security
  boundaries » is the only exception, whatever tier the task was declared at; its four triggers are
  written there and deliberately not respelled here.

**Tier 1 is exempt from MEASUREMENT, not from SCRUTINY, and reading is its technique** in the way
the break step is tier 2's. A different check, not a lighter one, which is why the tiers are named
after techniques rather than amounts. Some of this repository's most expensive findings came from
reading tier 1 material and from nothing else. Tier 1 says read it, not skip it.

**Decide anything reversible inside one PR, and record the decision where the next reader meets
it.** Stop only on stored data beyond what is ruled, something irreversible or outward facing, or
a contradiction with a decision already written down. A number a test can assert is not a ruling.

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
- **No em dashes in prose a reader meets**: UI strings, documentation, commit messages, PR and
  issue bodies. They make text read as generated, which is a fact about prose and not about code.
  **Code comments are deliberately out of scope**; a string the DESIGN specifies is quoted verbatim
  and stays as drawn.
  **Two of the four surfaces are gated and saying which is the point.** UI strings and documentation
  are files, so `emDashesInProse.spec.ts` reads them and fails, with deliberate catalogue strings
  allowlisted by key. Commit messages and PR bodies are not files and no check here sees them, so
  they are a convention. A rule claiming an enforcement it does not have is how a rule drifts back
  to a preference.
- **Never write about future work in the present tense of a promise.** "This will do X" fails
  exactly when the work succeeds, and nobody re-reads a page when a feature ships. Name the issue.
- **Anything whose output is STORED and later RECOMPUTED must be a pure function of what is
  stored.** Not a preference for pure functions generally: a narrow constraint on a small set, and
  it buys three things at once. A value reading the clock, a random source, an ambient locale or
  the network cannot be rebuilt from the row that holds it, so the recompute stops working, a
  property test has nothing to assert, and the next format version costs a migration instead of a
  pass. `domain/money.ts`, `import/dedupeRecompute.ts`, and the boot recompute that consumes it.
- **A PROPERTY THAT CHANGES HOW VALUES ARE READ IS DECIDED BY LOOKING AT EVERY VALUE IT RANGES
  OVER. Where the file proves an answer, use it. Where the file proves two contradictory answers,
  refuse it. Where the file exhibits the ambiguity but proves nothing, ask. Only where the file
  exhibits no ambiguity at all may a default apply.** The single definition for the import parser's
  eight per-file decisions, written here so a ninth inherits it: encoding repair, delimiter, sign
  indicator, split amount pair, account discriminant, currency, decimal separator, date order.
  **The last clause does the work**, and turns on whether the ambiguity is PRESENT IN the file or
  merely ABSENT FROM it: `06/01/2026` exhibits its own, a missing currency column exhibits nothing.
  "Refused, never guessed" reads well and refuses the ordinary case.
  **The four outcomes are a TYPE, not a convention, and that is the enforcement.**
  `import/dateOrder.ts` returns `resolved`, `mixed`, `ambiguous` or `nothing-to-decide`, with no
  constructor for "I guessed"; `import/discriminant.ts` is the same idea at three states. NOT one
  shared generic yet: collapsing them would merge refusing with asking. The failure this replaces
  is measured in #433.
- Prefer the existing component and the existing helper. Check before adding either.
- Any number an operator might need to move is read from the environment: a default, a hard
  ceiling, refusal rather than clamping, and a boot warning when it differs.

## Writing a sentence for the interface

**Every finding gets closed by adding a sentence, and nobody reads the result as one page.** Each
sentence was right when written and the screen has changed since, so a sentence earns its place
against four questions, and the fourth exists because the first three cannot see it.

1. **Does the control it sits beside already say this?** « Choisissez de nouveau le relevé » above
   a picker labelled « Choisir un fichier » is one sentence for one action.
2. **Does it explain something the reader can already see?** A dialog stating that two runs share
   a period, a count and totals, above two cards showing exactly those, narrates its own table.
3. **Was it added to close a measured finding, and does the finding still exist?** This is the
   question that PROTECTS text, and text that passes it may not be trimmed for length.
4. **Does another sentence on this same screen already say it?** Questions 1 and 2 check against a
   control and against visible data. Neither looks at the prose one block up, which is where the
   repetition actually accumulates.

**A cut is not a deletion.** A removed sentence takes its antecedent with it. Read the survivor
aloud on its own before believing the cut is done. Keep it short enough to read at 390 px: a
string wrapping to four lines on a phone is skipped, and skipped text is worse than absent text
because it still takes the space.

**For every failure and empty state, ask what the server KNOWS that the reader cannot see.** In
every instance so far the code a single frame away had already worked out why, and the screen told
the reader to wait for something that would never change on its own. One sentence covering several
producers is the shape: it reads as transient for the ones that are not.
**The sharpest instance needed no new information at all**, which is why it is the one to remember:
`done_reason` arrives on the Ollama response the app already receives and says whether the answer
was cut short, so truncation and garbage were the same sentence while needing opposite advice.
**The question is not whether the app could tell. It is whether anyone read the field that already
said so.**

## Writing an assertion

**A green test says nothing until you know what it would have taken to make it red.** The check
for that is the break step under « After writing ».

### Before writing

- **Which two states does this observation separate, and can it actually separate them?**
- **What does this mechanism report on a tree with no defect at all?** A guard that is wrong on a
  clean tree gets deleted, and takes the working half with it.
- **Pick the fixture that DISTINGUISHES, then check it also reads clearly.** The order is the rule;
  the reverse is the habit. A boundary comparison is tested on the boundary: name the single value
  where the two operators disagree. An assertion read synchronously after an interaction measures
  the framework's batching. A negative assertion over a container whose text is a concatenation
  cannot match; assert positively on the one element carrying the property.
- **A screen that works and a screen that is dead both render**, so geometry separates neither. A
  screen's acceptance is a JOURNEY: arrive, do the thing it exists for, observe the outcome
  elsewhere in the app; figures come after. A journey completed by a programmatic click is not one:
  assert what a human's eye would fail, cheapest being that the primary control is unobstructed and
  fully inside the viewport at each width.
- **A PR shipping a half states what does NOT WORK, not only what is absent.**

### While writing

- **A test is never shaped around the defect it should catch.** Remove the cause, not the view.
- **The test and the thing under test must not share a source.** Not a copied predicate (call the
  production function), not a copied constant (a value you also mock asserts the mock), not a
  retyped oracle (express the canonical rule by calling it).
- **A DUPLICATED PREDICATE HIDES WHICH COPY IS DOING THE WORK.** Two spellings of one rule pass
  together and fail apart, so a test over either cannot say which the application consulted, and
  editing one leaves the other shipping. Call the single definition, or assert the two agree over
  every input that distinguishes them.
- **Prove the detector can detect**, with a positive case and with an absolute figure beside every
  absence assertion. "No offenders" is satisfied by a pattern that matches nothing.
- **CHECKING FOR ABSENCE IS NOT CHECKING FOR PRESENCE, AND PRESENCE IS THE SILENT ONE.** A missing
  thing announces itself the moment anything looks for it; a thing present but wrong, present
  twice, or present in the wrong place satisfies every existence check written about it. Assert
  what the value IS, not that it is not absent.
- **An instrument can MANUFACTURE the findings it reports, and a list of findings invites no
  scrutiny the way a zero does.** **When an audit reports findings, change the instrument once and
  check whether the POPULATION moved. If it did, the findings were about the instrument.** Two
  tells: findings clustering by file format rather than by subject, and a denominator you never
  printed because only the hits looked interesting.
- **A GUARD ONLY PROTECTS WHAT IT INSPECTS.** A cap and its consumer taking different arguments
  both work correctly and protect nothing between them: the cap refuses the rows, the next function
  is handed the same raw array. Grep for the VARIABLE, not for the guard, and name what each guard
  reads. The same shape one layer out is a gate scoped to one file type or one spelling.
- **A test on a refusal asserts the REASON**, never that a refusal happened.
- **A LOOP ASSERTING ONE VALUE OVER A SET PROVES NOTHING ABOUT WHICH MEMBER IT READ**, and it goes
  wrong silently the day the set stops being homogeneous. The tell is that runs written against the
  two candidate figures fail on different members in opposite directions, reading as
  non-determinism. Assert the kinds separately as soon as a set stops being uniform.
- **A SUBSTRING ASSERTION PASSES STRAIGHT OVER A DOUBLED TAIL**, so a sentence malformed rather
  than missing goes green: every `toContain` still finds its fragment in « ... 1 sur 3 sur 3 ».
  **Compare the SENTENCE**, with `toHaveTextContent` or an equality, whenever the thing under test
  is a message a person reads. A defect in the JOIN between correct parts is invisible to
  assertions written about the parts.
- **AN UNOBSERVED FIGURE IN A PASSING TEST IS NOT A MEASUREMENT.** An assertion placed after
  another is never evaluated while the first one fails, so a figure can sit in a green suite for
  months having never been computed. **If a test carries two figures, one is unverified whenever
  the other is red**: split them.
- **A PUBLISHED FIGURE IS A SNAPSHOT OF ONE TREE AND NOTHING RE-DERIVES IT.** The moment it is
  written into a doc, a comment or an issue body it stops tracking its subject, and it is most
  dangerous to the reader who trusts the page. A figure lives beside the gate that recomputes it,
  or carries the one-line command that re-runs it. A figure with a prose gloss drifts in the gloss
  first.

### After writing

- **Break it on purpose and watch it go red.** The only moment a test tells you something.
- **ONE BREAK IS NOT ENOUGH.** A single break proves the test can redden, never that it reddens for
  the reason it names, and a test catching the obvious spelling of a defect routinely misses the
  wrapped one, the one in the other file type, and the one a formatter reflowed. Break each clause
  the test claims to cover, separately, and name in the test's own comment which two states each
  break separates.
- **Read the greens per test, using the four meanings.** A green break means: something else covers
  it (a finding about that something else), the line cannot execute (dead code, delete it), the
  break was too small, or it changed no observable behaviour. Tell the last two apart by running
  both versions over a corpus, not by reasoning.
- **Reproduce the figure.** On a measured defect the red must bring back the original value.
- **A figure is not a guard until its STARTING value has been measured.** An assertion that a count
  ends at 0 says nothing unless you know what it was before. Print the count on the unmodified file
  and check it is the number the guard's reasoning assumes; a guard whose premise was an assumption
  about the source has zero discriminating power while reading exactly like a check.
- **Undo a break with an inverse patch, never `git checkout --`.** Assert the old text is present
  before writing, so a patch matching nothing fails loudly.
- **Restore in a `finally`, not on the line after the run.** A break patch is a mutation with no
  automatic undo, so an interrupted break-check leaves the break in the tree reading as code
  somebody meant to write, with every gate green because the test that would catch it is the one
  the break disabled. If a session ends mid-break, the next one looks for it first: an inverted
  condition, a commented assertion, a constant where a call was.

### Order

A test written after the code has seen the implementation and takes its shape, defects included.
Breaking it is what compensates. **On a defect the order is fixed**: measure, write the test that
reproduces the measurement, fix, break, check the measurement returns.

### Every piece correct, the assembly not

**No test written at the level of the thing being built can see this class**, which is why it gets
its own check. Every instance cost a session: role rows whose specs asserted the buttons EXIST
while none opened the picker they triggered (#334), a component state with three specs behind a
`readOnly` prop **no route ever set**.

**The check is cheap and mechanical: for any component state, prop or branch, name the route that
produces it in the running application.** If no route does, it is not built, it is drafted, and
specs covering it prove only that the draft is internally consistent. Nothing else catches it,
because no PR owns a seam.

**Ask the same question of the TEST: name the route that performs each step this test performs.**
A test that performs a production step ITSELF measures that the step is POSSIBLE, not that the
application performs it, so the defect ships with its guard green:
`import/roundTripBuckets.db-smoke.ts` carries the figure that closes #464 and resolves the
destination account in the test, through a reader the import path does not call. The tell is a
helper defined in the spec file whose body would be production code anywhere else. The fix is not to delete such a
test, which measures something real, but to say in its NAME what it measures: a format's
sufficiency is not a behaviour.

### A task is not a prompt

Same family one level up: the seam entries under « Every piece correct, the assembly not » are
about work nobody owned, and this is about work nobody could DO from the section describing it.

**A task whose section names a symbol that exists in neither the tree nor the section is not a
task, it is a prompt.** Whoever executes it fills the hole by inventing something, and an invented
symbol compiles, tests green against itself, and reads exactly like the thing asked for. Found by
grepping the tree for every identifier a plan names, rather than by reading each task
sympathetically. Sizing fails the same way: a deletion called three lines touched ten tests.

Three questions per task, before it is handed to anyone: **does every symbol this section names
exist in the tree or in this section**, **does this section end in a figure that a partial
execution would fail**, and **was that figure's starting value measured rather than assumed**.

## Distrusting the harness

**The harness lies, and in the comfortable direction.** One that never reaches the code reports
clean refusals; a scanner seeing zero packages passes; a fuzzer reaching no accept path reports
5000 clean refusals, which reads like a healthy run.

- **Every harness carries its own calibration**: give it a known failing case and check it
  reports it, before believing any negative result. Calibrate the DETECTOR, not the page.
- **Calibrate on the label of the thing you want to count**, not one that travels with it.
- **Plant the positive where the detector actually LOOKS.** A detector's exclusion list is the
  place that silently is not, so read it before choosing where to plant, or the calibration
  measures the exclusion list and fails in whichever direction you already expected.
- **The measurement that PROVES a fix is a detector too, and it fails in the same comfortable
  direction.** A before-and-after comparison reporting a clean after is indistinguishable from one
  that read nothing, and it arrives at the moment you most want to believe it. Run the positive in
  the SAME pass as the comparison, never once beforehand, and print what each side read beside what
  it found.
- **A check reporting clean must say how many files it read.** Zero files reads as success.
- **Search with Serena, not grep, when the question is « every site that does X ».** A text search
  answers where you LOOKED, not where it IS, and it fails in the comfortable direction, as a short
  confident answer. Use grep for a literal whose spelling you know; use Serena for a question
  about the code.
- **A property of a column is a claim about every WRITER, and citing one is citing the one you
  happened to read.** The tell is a sentence of the form « every stored X is Y, because <one
  file> writes it ». Enumerate the writers before believing the property; here the answer is
  habitually three, because RESTORE, IMPORT and MIGRATION are not the path you were reading. The
  same applies to any claim about a SET: ask the set, not one member.
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
- `CHANGELOG.md` is release-please's file. Never edit it by hand.

## References

Standards this repository is held to, and where each one binds.

- **[OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/)**,
  Level 2. The row-by-row position is in [SECURITY.md](./SECURITY.md). Authoritative for the
  application's security requirements.
- **[OWASP AISVS](https://owasp.org/www-project-artificial-intelligence-security-verification-standard/)**
  for the optional Ollama path: prompt construction, model output handling, and the boundary
  between user data and prompt.
- **[OWASP WSTG](https://owasp.org/www-project-web-security-testing-guide/)** for the testing
  method behind the import parser's injection work, including the save-and-reopen cycle.
- **[WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/)** for the interface. Contrast, focus visibility,
  target size and the live regions the import screens depend on.
- **[ISTQB CTFL v4.0.1](https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf)**
  section 5.2.3, for the risk-based testing definition the rigour tiers are built on.
- **[ANSSI](https://cyber.gouv.fr/publications), PROPOSED, not yet mapped.** A French repository
  read by French reviewers, who know ANSSI before CIS. Three guides would plausibly bind and
  nothing here has been checked against them yet: _Recommandations de sécurité relatives à un
  système GNU/Linux_ for the distroless image and the `/data` volume; _Recommandations pour la
  mise en oeuvre d'un site web_ for the CSP, the session cookies and the TLS posture; and
  _Recommandations relatives à l'authentification multifacteur et aux mots de passe_ for the
  password and bootstrap-token rules. **Mapping is its own pass and is not started here**, because
  a mapping exercise inside a milestone defined by closure never closes. File it as an issue when
  somebody is ready to do the rows.
