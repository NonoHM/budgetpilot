---
paths:
  - 'src/**/*.spec.ts'
  - 'e2e/*.spec.ts'
  - 'src/**/*.db-smoke.ts'
---

<!-- VERIFIED END TO END 2026-08-22: reading `src/lib/vitest-examples/greet.spec.ts` injected this rule into the
session. That is the only check that proves the `paths` block parses — no YAML parser is
available on this machine (no PyYAML, no node `yaml`), so it has never been parsed offline.
Re-run the same check after editing the block: read a matching file and confirm this text
appears. Do NOT verify a glob with `git ls-files` — its pathspec lets `*` cross `/` and the
rule matcher does not, so it reports matches the rule will never make. -->

# Tests

Invoke `superpowers:test-driven-development` before writing a test for behaviour that does not
exist yet, and before fixing a bug that no existing test catches. It is a plugin skill, so this
rule is the only thing that can fire it on a path.

Reading or running a test that already exists does not need it.
