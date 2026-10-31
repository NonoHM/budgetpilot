# Product

Product truth for design work. Derived on 2026-10-31 from `README.md`, `AGENTS.md` and the code,
without an owner interview (owner 2026-10-31: decide by best practice, do not ask). A line marked
« inferred » is a reading, not a ruling; correct it here.

## Platform

web

## Register

Operate. Members come to finish a task (import a statement, categorise, check a budget), not to be
persuaded. Precision and restraint over expression.

## Users

One household or one person running their own instance, on a laptop at a desk for imports and
reviews, and on a phone for a quick check (inferred from the 390 and 1280 widths every screen PR is
walked at). Not accountants. They know their bank's export, not its column names.

## Product Purpose

A local-first, privacy-first personal budgeting app: self-hosted, and bank data never leaves the
member's own machine. Imports, budgets, net worth, savings goals, a deterministic cash-flow forecast,
rules, splits and tags. English base, French shipped.

## Brand Personality

Calm, exact, honest. The app says what it knows and what it does not: a file whose dates read two
ways is asked about, never guessed. Limitations are stated up front (`README.md` « Known
limitations »).

## Anti-references

- Bank and fintech marketing: gradients, glow, confetti, gamified streaks (inferred from the flat
  card rule in `src/lib/styles.ts`).
- Dashboards of invented vanity numbers. Every figure on screen is one the member can trace to rows.
- A screen that tells the member to wait for something that will never change on its own
  (`AGENTS.md` « Writing a sentence for the interface »).

## Design Principles

1. **The fewest steps wins, and it outranks every other principle** (owner 2026-10-31: « user is
   the king »). Before a screen changes, count the clicks or taps of its journey today, and the PR
   states the count before and after. The tools for lowering it, in order: remove the step; fill
   it with a default the data proves; remember the member's last answer; offer undo instead of a
   confirmation for anything reversible. A count that rises needs a reason in the PR.
2. A false figure is the worst defect; a wrong value that renders correctly is the second.
3. Ask where the data is ambiguous, refuse where it contradicts itself, default only where it shows
   no ambiguity (`AGENTS.md`, the four `FileVerdict` outcomes).
4. One sentence per fact on a screen, short enough to read at 390 px.

## Accessibility & Inclusion

WCAG 2.2 AA (`AGENTS.md` « References »): contrast, visible focus, 44 px targets, live regions on
the import screens, reduced motion honoured globally (`src/routes/layout.css`).

## Brand Commitments

No logo or brand asset beyond the wordmark text. Screenshots use synthetic data only
(`scripts/synthetic/`); no real statement, person or account appears in any published image.

## Stack

SvelteKit 2, Svelte 5 runes, Tailwind 4 with no custom theme, Bits UI primitives, Paraglide i18n.
