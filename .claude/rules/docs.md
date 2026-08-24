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

Invoke `documentation-writer` before writing or restructuring a page under these four paths. They
are the Diátaxis tree — prose written for a reader.

`docs/superpowers/`, `docs/local/` and `docs/audits/` are deliberately absent. The first two are
gitignored chantier notes and plans, read for context rather than written as documentation, and an
audit is the output of an audit rather than a documentation pass. `paths` matches a file read
whether or not git tracks it, so including `docs/**` would fire this rule on all three.
