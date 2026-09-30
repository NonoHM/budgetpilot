---
paths:
  - 'docs/*.md'
  - 'docs/using/**/*.md'
  - 'docs/reference/**/*.md'
  - 'docs/explanation/**/*.md'
---

<!-- VERIFIED END TO END 2026-08-22: reading `docs/explanation/README.md` injected this rule into the
session. That is the only check that proves the `paths` block parses — no YAML parser is
available on this machine (no PyYAML, no node `yaml`), so it has never been parsed offline.
Re-run the same check after editing the block: read a matching file and confirm this text
appears. Do NOT verify a glob with `git ls-files` — its pathspec lets `*` cross `/` and the
rule matcher does not, so it reports matches the rule will never make. -->

# Documentation

Invoke `documentation-writer` and `engineering:documentation` before writing or restructuring a page
under these four paths, and write to the Google developer documentation and Microsoft Writing style
guides, checked at the source rather than recalled. These are the Diátaxis tree: prose written for a
reader.

`docs/superpowers/`, `docs/local/` and `docs/audits/` are deliberately absent. The first two are
gitignored chantier notes and plans, read for context rather than written as documentation, and an
audit is the output of an audit rather than a documentation pass. `paths` matches a file read
whether or not git tracks it, so including `docs/**` would fire this rule on all three.

Every page passes six checks:

1. One page, one audience, one Diátaxis type (tutorial, how-to, reference or explanation).
2. Administration and self-hosting content lives on its own page or section, never as a subsection
   of a user page.
3. The audience is stated under the title.
4. The audience is chosen before writing; headings name the task, never the reader.
5. The page ends with a link to the other audience's page instead of absorbing it.
6. Self-hosting has its own entry in the menu.

A user page reads for someone who is not technical: plain words, one action per step, what happens
and what to do next. The operator page is complete: exact settings, commands, limits, what can go
wrong. A page quotes only interface strings and settings that exist.

A screenshot earns its place only where it adds understanding. It is captured by a step in
`scripts/doc-screenshots.mjs` with an `assert` on the screen, from synthetic data (holder Paul
Mercier, `scripts/synthetic/`), never by hand; its alt text says what it shows; and you look at the
image before committing it, since the private-reference gate and gitleaks cannot read pixels.
