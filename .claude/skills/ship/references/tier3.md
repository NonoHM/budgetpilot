# Tier 3: stored data, money, anything irreversible

In addition to every step in SKILL.md.

## Three engines

- SQLite locally, plus PostgreSQL (`postgres:17-alpine`) and MariaDB (`mariadb:11`, CI's MySQL leg) in
  containers you create for this PR, with a prefix of your own and free ports. Never touch a container
  named `budgetpilot*`: that is the owner's real instance. Remove yours when the PR is done.
- `npm run test:db` once per engine, each with an explicit `DATABASE_URL`, after
  `npx prisma migrate deploy` on the empty database. Report the figure per engine.
- A migration is one history per engine under `prisma/migrations/<provider>/`, and `migrate deploy`
  wraps nothing in a transaction on any engine: a migration whose safety needs all-or-none is one
  statement. On MariaDB `migrate dev` fails (`P3014`, `P1010`): generate the MySQL leg as root, then
  verify through the ordinary user with `migrate deploy` and `migrate diff`.
- Compare stored values as bytes or HEX, never through a client's display: a `\b` written by a
  migration stores a backspace on MariaDB and still prints like the pattern.

## Ownership

Every object reference the client posts resolves with `userId` in the SAME `where` clause (AGENTS.md
« Security boundaries »), asserted in a db-smoke, never only in a unit spec whose fake decides what
`findFirst` returns.

## Screens

Screenshots at both widths through the `walk` skill, whether or not the screen looks changed.

## The contradiction pass

Before any code, once on the design note (at most 10 lines, written after the ruling is red as
failing tests at agreed seams): a pass with the note in place of the diff, told to attack the note's
premises about UPSTREAM code, which the note relies on but did not write. Then after the tests are
green and every break is done, before the PR opens:

1. Write the diff to a file: `git diff origin/main...HEAD > <scratchpad>/pass.diff`.
2. Dispatch the `contradiction-pass` agent (a fresh agent, never a fork: a fork inherits the author's
   blind spots) with only three things: that diff file, the change's claim quoted from its commits
   or docstrings, and the measured facts inside a fence the agent is told holds claims to verify:

   ```
   <claims-to-verify>
   ...the measured facts...
   </claims-to-verify>
   ```

   Never your own list of callers, writers or doors, your reasoning, or another pass's findings.

3. **Pass B, the trial the owner ruled on 2026-10-27.** Round 1 after the code also dispatches the
   same agent with the same brief and `model: sonnet`, in parallel, never shown pass A. Merge in the
   controller: a finding from both is high signal; a finding from one is still taken to step 5.
   Record on #1070, per PR, which pass found each REFUTED node. After five tier 3 PRs, if
   B never found what A missed, drop this step.
4. Each real finding is fixed under the same order (red, fix, break) and committed on its own. The
   exception is a finding inside the mechanism this PR just built, where a separate commit would
   reintroduce the gap in history: fold it in and say why in the commit message.
5. **A finding you dispute or cannot reproduce is not yours to dismiss.** Dispatch one fresh
   `contradiction-pass` (Opus) with the finding and the code, never your rebuttal: it stands unless
   that verifier cites a mitigation it located and read. Below the bar, file it instead.
6. **Stop when all four hold:**
   - the tree is closed: every node has a verdict, every UNVERIFIABLE node has been run or filed,
     every NEEDS A RULING node has gone to the owner;
   - any code changed after the last pass has had a fresh narrow pass on that diff, given the
     previous findings because its job is the fix;
   - passes alternating between opposite cases stopped iterating and became a ruling;
   - round 3 still REFUTING at the bar stops coding: the claim is too wide, so narrow it or escalate.
7. Each pass's report goes to `docs/superpowers/passes/<pr or branch>-<n>.md` as it arrives, and
   the PR body states its findings: chat context does not survive a crash.
8. Under a controller, the controller runs the pass: push the branch, do not open the PR, and report.
