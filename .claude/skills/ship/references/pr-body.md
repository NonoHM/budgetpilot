# The PR, its body, and publishing it

## Title and commits

- Conventional Commits. The type follows `release-please-config.json`: anything that can reach a
  running install is visible, so a dependency bump carrying a CVE fix is `fix(deps):`.
- Every commit message ends with the `Co-Authored-By` line the harness gives. A commit message on a
  branch is already published: this repository squash-merges with the commit messages.

## Body, in this order

1. What it closes: `Closes #N`, the keyword repeated for each issue. A closing keyword (close, closes,
   closed, fix, fixes, fixed, resolve, resolves, resolved) directly before an issue number closes it
   on merge, even after "not". For an issue left open write « left open: #N » or « filed as #N ».
2. What it does NOT do. A PR shipping a half says what does not work, not only what is absent.
3. The measurement: the figure, its calibration case, and what each side read.
4. Tests and breaks: for each break, the clause, red or green, and the two states it separates.
5. The gate figures as read (see [barriers.md](barriers.md)).
6. The walk: what was seen at 390 and 1280. Screenshots are named by path under `scr/`, never
   attached or committed.
7. Standards: `ASVS v5.0.0-X.Y.Z` with the text quoted, resolved through the `cite` skill.
8. Findings filed, and deviations with their reason.
9. The last line is the attribution line the harness gives.

No em dash. No claude.ai link of any kind (a canvas is « a private Claude Design canvas »), no
absolute local path, no personal address, nothing derived from a real statement.

## Publishing

The repository's hook refuses a publishing command it cannot vouch for, and a refused call runs
nothing at all:

1. Write the body with the Write tool to a literal path under `docs/superpowers/tools/` (gitignored;
   create the folder on a fresh clone): `docs/superpowers/tools/body-<n>.md`.
2. The tracked hook (`.claude/hooks/private-references.mjs`) scans that body when you post it and
   refuses on a finding. A maintainer's local `docs/superpowers/tools/scan_text.mjs <file>` scans it
   earlier, calibrated in the same run; `node scripts/private-references.mjs <file>` scans nothing.
3. `gh pr create --base main --title "<title>" --body-file docs/superpowers/tools/body-<n>.md`: a
   literal path, one publishing command per Bash call. Never an inline body: a backtick inside double
   quotes executes.
4. Read it back: `gh pr view <n> --json body,commits`. Commit messages were scanned by the
   `.githooks/` hooks when committed (`git config core.hooksPath .githooks` enables them).
