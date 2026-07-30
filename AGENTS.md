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
  never reset or delete their own account through it. There is no admin
  action to disable another user's TOTP/MFA — intentional, since that would
  let an admin unilaterally weaken another account's second factor; don't
  propose adding one.
- No external host (local AI, bank-sync providers) is ever called without
  validating it against an explicit, configurable allowlist — never a
  hardcoded or inferred trusted URL.
- Content-Security-Policy is enforced via SvelteKit's `kit.csp`
  (`svelte.config.js`) — nonce-based `script-src`, no `'unsafe-inline'`
  anywhere. Don't introduce a literal, dynamically-valued `style=""`
  attribute; it's silently blocked, not warned about — use static classes,
  SVG presentation attributes, or Svelte's `style:` directive instead.

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

### Database providers

BudgetPilot runs on SQLite (the zero-config default), PostgreSQL or MySQL/MariaDB,
chosen by two environment variables: `DATABASE_PROVIDER` and `DATABASE_URL`.

`prisma/schema.prisma` is the only hand-authored schema. The PostgreSQL and MySQL
schemas are derived from it by `schemaGenerator.ts` and committed; each provider
keeps its own migration history under `prisma/migrations/<provider>/`, because the
same logical change is different SQL on each engine.

**All three generated clients ship in the same published image**, regardless of
which provider an operator actually runs. This is a deliberate trade: deployment
stays one image and two environment variables, at the cost of carrying two clients
that will never execute. The Rust-free `prisma-client` generator keeps that cost
small (the query engine is shared, so three clients are a few MB of generated
TypeScript, not three full engines). Revisit only if image size becomes a real
operational problem — not on principle.

Two optional Compose overlays (`docker-compose.postgres.yml`,
`docker-compose.mysql.yml`) run a server next to the app for operators who want
one, on the same pattern as the AI and proxy overlays: adding the overlay sets both
variables, so the stack can never run a database container while the app quietly
writes to the SQLite file on the volume. They are mutually exclusive, they never
publish the database port, and their password comes from `DATABASE_PASSWORD` in
`.env` with no default. See `docs/database-providers.md`.

The clients are generated at **build** time, never at boot. That is what allows
`node_modules` to stay read-only to the app user in the runtime image; an earlier
design regenerated on startup and needed write access to code it would then
execute.

## Commands

```bash
# Local dev
nvm use && npm run dev
npm run dev:ai          # dev server + ensures Ollama is running

# Validation before any commit
# db:generate, not `npx prisma generate`: the latter builds only the SQLite client, and
# nothing type-checks until all three exist.
npm run db:generate && npm run check && npm run test:unit -- --run

# Single test file / watch mode
npx vitest run path/to/file.spec.ts
npm run check:watch

# Schema migration (only if schema.prisma changes)
# db:schemas regenerates the PostgreSQL/MySQL schemas from it; CI fails if they are stale.
# db:generate regenerates all three clients — the app imports every provider's client
# statically, so nothing builds or type-checks until all three exist.
npx prisma migrate dev --name <name> && npm run db:schemas && npm run db:generate

# End-to-end tests (self-contained, own throwaway DB)
npm run test:e2e

# Docker, prod-like / demo (includes the optional Ollama service)
docker compose up -d --build
docker compose logs -f budgetpilot
docker compose down   # NEVER -v — that deletes the Docker DB volume

# Builds the image and boots it on SQLite, PostgreSQL and MariaDB. Same script CI runs,
# so a failure there reproduces here exactly. Needs ~4 GB free; cleans up after itself.
./scripts/docker-smoke.sh

# Merges and validates every Compose combination the docs document. Run it after touching
# any docker-compose*.yml, and add the combination to the script if you document a new one.
./scripts/check-compose-combinations.sh
```

- Never run `prisma migrate reset` against a database you care about.
- `src/lib/server/database/generated/` is build output (one Prisma client per
  provider) and is gitignored. If a build complains it is missing, run
  `npm run db:generate` rather than hand-editing anything in it.
- Import Prisma types from `$lib/server/database/types`, never from
  `@prisma/client`. That module names the one generated client the types come
  from; importing the package directly reintroduces a second, unrelated
  `PrismaClient` type and produces union errors across the codebase.
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
- **Net worth**: the evolution curve plots one point per distinct snapshot
  timestamp (never grouped/bucketed by month). The alternate donut view
  breaks down assets by account type and shows **non-negative type totals
  only** — debt, and any other type netting to zero or below, is excluded
  from the donut and surfaced separately as a single negative-balance total
  instead.

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

## Backlog / roadmap

Tracked in [GitHub Issues](https://github.com/NonoHM/budgetpilot/issues),
not here — this file documents what's built, not what's planned.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the pre-PR validation
checklist, and commit message conventions.

User-facing documentation lives in [docs/](./docs/): install and first
login, configuration, day-to-day operations, the two optional features (AI
advice, bank sync), and troubleshooting. A change to install steps, an env
variable, or a user-visible failure mode should update the matching page
there in the same PR.

## Git workflow (mandatory, effective immediately)

**No direct commits or pushes to `main`, ever.** Always: create a branch,
push it, open a PR, wait for CI to pass, then merge. The repo is public and
GitHub's branch protection ruleset enforces this (PR required, all 3
required checks green — `lint`, `typecheck`, `test-and-build` — no bypass).

## Dependency updates (Dependabot auto-merge)

`.github/workflows/dependabot-auto-merge.yml` auto-enables `gh pr merge
--auto --squash` (never a direct merge — the required checks above still
gate it) on a Dependabot PR only when the update is `semver-patch` or
`semver-minor` (never major) AND the package isn't in `.github/dependabot.yml`'s
`npm-lint-tooling` group (`eslint*`, `prettier*`, `@typescript-eslint/*`,
`typescript-eslint` — a formatter/linter bump can change what
"lint-clean"/"correctly formatted" means repo-wide, so it always needs a
manual look, patch or not). Applies the same way to ungrouped CVE-triggered
security PRs. Everything else (majors, lint/tooling bumps, anything CI
doesn't pass) needs a human to merge.
