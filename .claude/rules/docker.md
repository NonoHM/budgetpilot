---
paths:
  - 'Dockerfile'
---

<!-- VERIFIED END TO END 2026-08-22: reading `Dockerfile` injected this rule into the
session. That is the only check that proves the `paths` block parses — no YAML parser is
available on this machine (no PyYAML, no node `yaml`), so it has never been parsed offline.
Re-run the same check after editing the block: read a matching file and confirm this text
appears. Do NOT verify a glob with `git ls-files` — its pathspec lets `*` cross `/` and the
rule matcher does not, so it reports matches the rule will never make. -->

# The image

Invoke `multi-stage-dockerfile` before changing the stage structure of the Dockerfile.

It will also match a base-image tag bump, where it adds nothing — one file, rare changes, and the
cost of the false fire is one skill body.
