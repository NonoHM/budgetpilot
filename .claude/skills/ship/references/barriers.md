# The barriers, and the direction each one lies

Run all of them before pushing, in this order, and write each figure down as read. The line in
AGENTS.md « Commands » is the command set; this file is how to read them. Never read a barrier's exit
code through a pipe: redirect to a file, read `$?` from the runner, then read the file.

| Barrier  | Command                      | Read                                       | How it lies                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clients  | `npm run db:generate`        | exit 0                                     | Skipped, every type check after it fails for an unrelated reason.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Types    | `npm run check`              | errors over files                          | Misses everything that breaks at run time.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Lint     | `npm run lint:tracked`       | files read, `[warn]` count, `problem` line | Reads `git ls-files`: an unstaged NEW file is invisible, and it reports clean over what it never read. Stage first.                                                                                                                                                                                                                                                                                                                                                            |
| Unit     | `npm run test:unit -- --run` | files and tests, passed and failed         | The WHOLE suite, even for prose: gates such as the em dash and searchable-source specs scan every tracked file, so a targeted run is not a check.                                                                                                                                                                                                                                                                                                                              |
| Build    | `npm run build`              | exit 0                                     | Needs `DATABASE_URL` in the environment. Catches what `check` and vitest cannot.                                                                                                                                                                                                                                                                                                                                                                                               |
| Engines  | `npm run test:db`            | per engine, passed and failed              | Needs an explicit `DATABASE_URL`, and `npx prisma migrate deploy` first on an empty database. Green only against an EMPTY database. Tier 3 runs it on all three engines ([tier3.md](tier3.md)).                                                                                                                                                                                                                                                                                |
| Journeys | `npm run test:e2e`           | passed, failed, flaky                      | The FULL suite before a PR, never a subset: specs share one user and one database in declaration order, so a subset hides the order effects. It builds and serves on port 4174 (`e2e/config.ts`); parallel sessions serialise it with `flock "$(git rev-parse --git-common-dir)/bp-locks/e2e.lock" npm run test:e2e` (`mkdir -p` it first). The common git directory is shared by every session and worktree; a scratchpad is per session, so a lock there serialised nothing. |

**dev is not the build.** In dev SvelteKit adds `'unsafe-inline'` to `style-src` and strips the
nonces, so a dynamic `style=""` the production CSP blocks renders fine; adapter-node loads no `.env`
in production and form actions need `ORIGIN`. Use `npm run dev` for a quick look while building, and
the build (the e2e suite, or `npm run build && npm run preview`) for anything you report.

**CI's `docker-smoke` job is the image check.** It builds the image and boots it on the three
engines. Never report it as passed from a local run of anything else. If you ran
`scripts/docker-smoke.sh` yourself, say so, and that CI's run is still the record.

**A green PR summary can mean a job never ran.** Read the list of checks on the PR, count the jobs,
and compare with the workflows that should have triggered.

**The `dropdown-menu` hydration flake is load dependent.** A retry that also fails is not evidence of
a regression and one isolated run discriminates nothing: compare a COUNT of runs on both sides,
against the branch point.

**Heavy runs share memory** when two sessions work on one machine: run the build, the full unit suite
and `check` under `flock "$(git rev-parse --git-common-dir)/bp-locks/heavy.lock" <command>`. Iterate on
targeted suites; the three engines, the full e2e and the walk run ONCE after the last code change, in
the background and one after another, never at the same time (#967: two vitest processes at once
failed 54 of 61 db-smoke files).
