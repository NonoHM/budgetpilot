---
paths:
  - 'src/**/*.svelte'
  - 'src/routes/layout.css'
---

<!-- VERIFIED END TO END 2026-08-22: reading `src/lib/components/Avatar.svelte` injected this rule into the
session. That is the only check that proves the `paths` block parses — no YAML parser is
available on this machine (no PyYAML, no node `yaml`), so it has never been parsed offline.
Re-run the same check after editing the block: read a matching file and confirm this text
appears. Do NOT verify a glob with `git ls-files` — its pathspec lets `*` cross `/` and the
rule matcher does not, so it reports matches the rule will never make. -->

# What renders

Invoke `frontend-design:frontend-design` and `ui-ux-pro-max` before changing what a component or
a route puts on screen. Neither can carry a `paths` trigger of its own — one is a plugin skill and
the other is user-scope, so its frontmatter would fire in every repository on this machine. This
rule is the trigger.

Not for a change that alters no markup and no style: a prop rename, a moved import, a comment.
