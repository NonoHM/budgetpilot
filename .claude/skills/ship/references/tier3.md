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

After the tests are green and every break is done, before the PR opens:

1. Write the diff to a file: `git diff origin/main...HEAD > <scratchpad>/pass.diff`.
2. Dispatch the `contradiction-pass` agent (a fresh agent, never a fork: a fork inherits the author's
   blind spots) with only three things: that diff file, the measured facts that justify the change,
   and the change's claim quoted from its commits or docstrings.
3. Each real finding is fixed under the same order (red, fix, break) and committed on its own. The
   exception is a finding inside the mechanism this PR just built, where a separate commit would
   reintroduce the gap in history: fold it in and say why in the commit message.
4. When the first pass found anything, run a second, narrower pass on the fixes.
5. Under a controller, the controller runs the pass: push the branch, do not open the PR, and report.
