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

The order: any process skill first, then those two, then the design, then the code.

- **A screen no plate section draws is designed on a Claude Design canvas before it is built**: a new
  composition, a new state, a changed visible line. Where a plate section rules the screen, cite it
  and build to it. The main session creates the canvas, never a subagent, at 390x844 and 1280x800
  from the registered bricks; an implementation session stops, pushes what is ready, and reports what
  the screen must show. Published text names it only as « a private Claude Design canvas ». Plates
  and canvases live outside the repository: without them, build from
  `docs/reference/design-referential.md` and ask in the PR for a design review of the new screen.
- **Every string is essential.** The fewest words that say what the server knows and the reader
  needs, checked against AGENTS.md « Writing a sentence for the interface ». Three lines at most at
  390 px. Reuse a key before adding one.
  No em dash, and nothing that reads as generated: implicit beats explained.
- **Built for a user who reads nothing**: what the screen is for and what to do first, understood in
  under 30 seconds. The `walk` skill asks it on the build.
- **An explanation longer than a line goes behind an info icon**, in `Tooltip` (brick 11,
  `src/lib/components/ui/Tooltip.svelte`), not in a paragraph nobody reads. Look in
  `src/lib/components/ui/` and `docs/reference/design-referential.md` for an info-icon trigger first;
  if none exists, build it once as a registered brick, and every later screen reuses it.
- After adding a message key, open the page: a running `vite dev` holds the catalogue it started with.
