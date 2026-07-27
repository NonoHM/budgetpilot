# BudgetPilot — Agent Guide

BudgetPilot is a **local-first** personal budgeting web app. Privacy is a
core design constraint, not an add-on: no bank cloud sync, no scraping, no
mandatory external calls. Optional features (local AI via Ollama, PSD2 bank
sync via Enable Banking) are opt-in and gated behind explicit configuration
and host allowlists.

## Stack

SvelteKit + TypeScript · Prisma + SQLite · Docker (prod-like, `/data`
volume) · Vitest + svelte-check · Node 24.18.0 · adapter-node · Paraglide
for i18n (`fr` base locale, `en`).

## Security posture

Treat these areas with maximum rigor — defense in depth, no shortcuts, no
residual risk left without an explicit, documented decision: **auth/session
handling, financial data (export/import), and any flow that talks to an
external service (Ollama, bank-sync providers)**. Elsewhere (standard CRUD,
UI), stick to the basics — scope every query to the authenticated user,
never expose sensitive fields client-side — and avoid over-engineering.
More security code is more surface for bugs, including within security
logic itself. See [SECURITY.md](./SECURITY.md) for the full policy and how
to report a vulnerability.

## Security rules (agent-facing, non-negotiable)

- **Never** log banking data, passwords, tokens, or session identifiers.
- **Never** expose client-side: password hashes, session/token internals,
  or raw imported-transaction metadata.
- **Never** accept a `userId` coming from the client — always derive it
  from the authenticated session (`locals.user.id`).
- **Always** filter sensitive Prisma queries by the authenticated user's id.
- Passwords are hashed with bcrypt at a configurable cost (minimum 12).
  Sessions are opaque tokens, hashed at rest.
- The session cookie is forced `Secure` whenever the instance declares
  itself public, independent of `NODE_ENV` — never remove that guard.
- Login has active rate limiting (per email and per IP); identifiers used
  for rate limiting are stored as HMACs, never in clear text.
- Self-registration is closed by default; enabling it is an explicit,
  informed opt-in, especially for a publicly reachable instance.
- The admin panel can reset passwords and delete accounts, but an admin can
  never reset or delete their own account through it.
- No external host (local AI, bank-sync providers) is ever called without
  validating it against an explicit, configurable allowlist — never a
  hardcoded or inferred trusted URL.

## Architecture conventions

- Don't duplicate business logic across files — check `src/lib/components`,
  `src/lib/domain`, and `src/lib/server` (see "Folder structure" below) for
  an existing helper before writing a new one.
- `src/lib/domain/` stays infrastructure-agnostic: no imports from
  `src/lib/server/`, `$app/*`, or Prisma — pure logic, testable without
  mounting a route.
- Security-, PII-, or financial-calculation logic belongs in a pure,
  exported, independently-tested function — not inlined in a
  `+page.server.ts` where it can only be verified indirectly.
- Before adding a utility, check whether it already exists.

## Commands

```bash
# Local dev
nvm use && npm run dev
npm run dev:ai          # dev server + ensures Ollama is running

# Validation before any commit
npx prisma generate && npm run check && npm run test:unit -- --run

# Single test file / watch mode
npx vitest run path/to/file.spec.ts
npm run check:watch

# Schema migration (only if schema.prisma changes)
npx prisma migrate dev --name <name> && npx prisma generate

# End-to-end tests (self-contained, own throwaway DB)
npm run test:e2e

# Docker, prod-like / demo (includes the optional Ollama service)
docker compose up -d --build
docker compose logs -f budgetpilot
docker compose down   # NEVER -v — that deletes the Docker DB volume
```

- Never run `prisma migrate reset` against a database you care about.
- `npm run check` also compiles Paraglide translations — don't skip it to
  save time; generated message types depend on it.
- The test suite is expected to stay 100% green. A failure means a real
  problem, not noise.

## Folder structure

```
src/
  lib/
    components/    shared Svelte components
    domain/        pure, framework-agnostic business logic
    server/        server-only logic (Prisma access, external calls, auth)
    paraglide/      generated i18n runtime + messages
    styles.ts       shared style tokens (see below)
  routes/           SvelteKit routes (one folder per page/feature)
prisma/             schema + migrations
e2e/                Playwright end-to-end specs
messages/           Paraglide translation source (fr.json / en.json)
```

## Business conventions

- **Effective category**: a transaction's category is
  `manualCategory ?? category.name ?? "Uncategorized"`.
- **"Uncategorized"** is the system fallback category: it cannot be deleted
  or renamed. It's the reassignment target when a category is deleted, and
  defines the "to classify" pile.
- **Analytical nature** (income/spending/transfer/investment/refund/fee/
  uncategorized) is distinct from the plain accounting type
  (income/expense) and can be overridden manually per transaction or per
  category.
- **Auto-categorization rules** match on a "contains" basis, accent- and
  case-insensitive by default, with opt-in regex support. Rules never
  overwrite a manual correction.
- **Default categories** are seeded once per user (on register/first
  login) and can be restored later without duplicating them.
- **Budgets** are monthly, scoped per user and per category.
- **Backup/restore**: export is a full JSON dump scoped to the requesting
  user; restore is a full, transactional replacement (never a merge) — IDs
  are regenerated on import.

## UI/UX conventions

- Sober black/white/zinc theme. **Color is encoding only, never
  decoration** — one category maps to one constant color, and there's no
  decorative teal/green just for visual variety.
- Buttons: primary is black/zinc, green means a positive action, red means
  destructive, secondary uses a zinc border. One primary action per screen.
- Tables show only what you scan at a glance (date, amount, category);
  everything else lives in a detail view.
- Dates show the year only when it differs from the current year.
- Progressive disclosure: secondary/dangerous actions stay collapsed by
  default. Empty states carry exactly one clear call to action.
- Every form control follows one shared 44px-tall, 12px-radius template
  (`src/lib/styles.ts`) — reuse it instead of hand-rolling field styles.

## Language policy

Code, identifiers, and comments are always written in English, regardless
of the app's own UI language(s). Only user-facing strings go through the
i18n system (Paraglide).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the pre-PR validation
checklist, and commit message conventions.
