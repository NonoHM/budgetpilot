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
`.env` with no default. On both engines the app connects as a role scoped to its own
database, never an administrative one — PostgreSQL's is created by an inline initdb
config, since the image's `POSTGRES_USER` is the bootstrap superuser and PostgreSQL
will not let that role give up the attribute. `hooks.server.ts` warns at every boot if
it finds itself connected as a PostgreSQL superuser anyway (an operator's own server,
say). See `docs/database-providers.md`.

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

- The runtime image is distroless: no shell, no npm, no coreutils. Starting a
  shell in it (`docker compose exec budgetpilot sh`) does not work and is not
  meant to. Its entrypoint is `node`, so run things as
  `docker compose run --rm budgetpilot scripts/<name>.mjs [args]` or
  `docker compose exec budgetpilot /nodejs/bin/node -e '<snippet>'`. Anything
  a smoke assertion needs to read out of the image is extracted to the host
  first — see `extract_from_image` in `scripts/docker-smoke.sh`; do not add a
  check that shells into the image, because it cannot work.
- The app container runs `read_only`, with `/tmp` as its only tmpfs, all
  capabilities dropped and `no-new-privileges`. **`/data` must be a mounted
  volume** — under a read-only root it is otherwise unwritable, and boot.mjs
  refuses to start rather than failing later inside Prisma. Anything you add
  that writes to disk at runtime has to write under `/data`, or it will work
  in `npm run dev` and fail in the image. `scripts/check-compose-combinations.sh`
  asserts every documented stack keeps these flags; `scripts/docker-smoke.sh`
  proves the kernel enforces them, by attempting the writes.
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
- **Tags** are free labels that cut across categories. A transaction has one
  category and any number of tags; the two never share a palette, because a
  tag chip and a category pastille render on the same row. Three rules decide
  most questions about them:
  - **A tag has no identity beyond its name.** A tag with no transactions is
    deleted immediately, silently and without confirmation. That is what makes
    retyping the same name a clean insert instead of a collision with a
    remnant. Untagging the last transaction must never announce a deletion.
  - **`TransactionTag` has no `userId` column.** Its two foreign keys are
    independent, so nothing in the schema stops a row linking one user's
    transaction to another user's tag. Application code is the entire
    protection: every write resolves the tag under the caller's `userId`
    first. Prove any claim about this against a real engine, never from a
    schema reading.
  - **Colour tokens are hue names** (`clay`, `ochre`, `olive`, `lagoon`,
    `azure`, `steel`, `indigo`, `plum`, `berry`), stored as strings and
    validated against a closed set. `lagoon` and `azure` are locked: never
    lighten them, never apply opacity. Three hue bands are deliberately absent
    so a tag can never read as a status.
- **Split transactions (répartition)**: one transaction, several categories.
  A handful of rules decide almost every question about them:
  - **Parts are the truth for money; the parent is the truth for identity.**
    `allocationsOf` in `domain/allocation.ts` is the ONLY supported way to read
    money out of a transaction. It returns one allocation per part, plus the
    remainder under the parent's own category, so an unsplit row yields exactly
    one allocation and no consumer needs a special case. A site written against
    `Transaction.amountCents` is a double-count the moment parts exist.
  - **The parts sum to the parent, exactly.** The invariant is application-level
    because no database expresses it portably across the three providers, so
    **every write path must go through `replaceSplits`**. Restore and CSV import
    do not, structurally, which is why `backup/import.ts` re-checks the sum
    itself and `import/profiles/maison-v2.ts` refuses a bad group before a row is
    inserted. Ask "which paths bypass the service" before adding an invariant.
  - **The parent keeps its own category** and never shows it in the list: the
    Catégorie column prints the dominant part. That category is the restoration
    value the transaction returns to when the split is removed, which is why
    removal is lossless and why the selector is locked while a split exists.
  - **No part may carry the "Uncategorized" sentinel**, the parent may. A split
    transaction leaves the "to classify" pile, so a sentinel part would be money
    that is uncategorized and invisible on the one screen built to find it.
  - **Nature resolves per part**, through each part's own category. The parent's
    manual nature override still governs every part.
  - **Bounds**: 2 to 20 parts, note at most 80 characters. The two constants
    live in `domain/allocation.ts` because the backup validator needs them too.
- **The CSV export format is a CONTRACT, not an output.** A file one version
  wrote must stay importable by every later one. It carries one line per
  ALLOCATION plus `montant_total`, `part` (`i/n`) and `categorie_parent`. When a
  column is added, **version the import profile rather than editing it**: the
  `maison` profile is two parsers sharing one name, and `maison.ts` (seven
  columns) is never touched. Guarded by `import/round-trip.spec.ts` and
  `e2e/transaction-splits-round-trip.spec.ts`.
- **Backup/restore**: export is a full JSON dump scoped to the requesting
  user; restore is a full, transactional replacement (never a merge) — IDs
  are regenerated on import.
- **Net worth**: the evolution curve plots one point per distinct snapshot
  timestamp (never grouped/bucketed by month). The alternate donut view
  breaks down assets by account type and shows **non-negative type totals
  only** — debt, and any other type netting to zero or below, is excluded
  from the donut and surfaced separately as a single negative-balance total
  instead.

## Data identity and i18n

Four rules, each from a defect this repo shipped. The measurement travels with the
rule: without it they read as generic advice and get argued with.

- **Join on an identifier, never on displayed text.** Five columns name a category
  by its text rather than its id — `MonthlyBudget.categoryName`,
  `CategoryNatureMapping.categoryName`, `CategoryRule.targetCategory`,
  `CategorizationRule.targetCategory`, `Transaction.manualCategory`.
  `?/renameCategory` updated two of the five, and renaming a category took
  `/budgets` from **5000 cents spent to 0** on unchanged spending. The shape that
  avoids this is a surrogate primary key with the natural key alongside as a unique
  constraint — `Category` has both (`id`, `@@unique([userId, nameKey])`) and those
  five columns simply do not use the first. The trap, named so it is recognisable:
  assuming a business identifier will never change. The inventory now lives in
  `server/categories/references.ts` and a spec checks it against the schema, so a
  sixth column fails a test by name.
- **Case folding is not lowercasing, and folded text is never displayed.** Store the
  original and a folded copy used only for comparison. `computeNameKey` is that
  pattern and is the **only** folding in this repo — nothing else invents its own.
  What it does not do is Unicode case folding, and the difference is measured:
  `Straße`/`Strasse` stay distinct here and are folded together by MariaDB's
  `utf8mb4_unicode_ci`, which is why the key is hashed rather than compared in SQL;
  `İstanbul`/`Istanbul` and `ΟΔΟΣ`/`Οδός` fold together here because NFD strips the
  dot and JS lowercases the final sigma. Turkish is the one to watch if a locale is
  added: `toLowerCase()` is not locale-aware, and changing the rule means
  recomputing every stored key.
- **A localised string does not live in a database column.** `Category.name` holds a
  canonical French name on the 14 seeded rows and free text on every other, with
  `defaultKey` the only marker of which. One column with two meanings produced
  **five wrong display sites and eight wrong sort sites**, and a uniqueness check
  that accepted "Groceries" on a French instance beside a row that reads Groceries
  in English. UI strings belong in the message catalogues, keyed by id.
- **Sweep before fixing a comparison.** #149 was reported as one site and there were
  **four**. The third turned up by asking the comparison BACKWARDS
  (`restoreMissingDefaultCategories` compares an arriving default against the user's
  own row, and uses none of the reported vocabulary); the fourth by RUNNING the fix
  through the real request path rather than reading it. A finding phrased as one
  line number invites one edit.

**Pseudo-localisation is the verification tool this repo does not have.** Compiling
the catalogues with every string replaced by elongated bracketed text makes two
classes visible in one pass: a string that renders unbracketed is **hardcoded**, and
a layout that clips or wraps has no room for a longer translation. It would have
caught the nine hardcoded French typography sites that live in `.svelte` markup
outside the catalogues, and it covers the **178 keys that are longer in English than
in French** without measuring 1302 by hand. **It is not set up** — nothing in the
test suite does this today, so no claim about layout under a longer locale is
currently backed by anything. Tracked in #158.

## UI/UX conventions

- Sober black/white/zinc theme. **Color is encoding only, never
  decoration** — one category maps to one constant color, and there's no
  decorative teal/green just for visual variety.
- Buttons: primary is black/zinc, green means a positive action, red means
  destructive, secondary uses a zinc border. One primary action per screen.
- Tables show only what you scan at a glance (date, amount, category);
  everything else lives in a detail view. The transaction row's tag chips are
  an approved exception, capped at two plus a `+N`: a filter result you cannot
  visually verify is worse than no filter, and the cap is what preserves the
  convention it deviates from.
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

**A dependency bump that carries a CVE fix is committed as `fix(deps):`, never
`chore(deps):`.** `chore` is neither versioning nor changelog-visible under the
default `release-type: node` sections, so a security bump committed that way
lands in a release that says nothing about it. Measured, not assumed: #115
shipped the fast-uri fix (CVE-2026-18446, HIGH) as `chore: bump fast-uri from
3.1.4 to 3.1.5`, and it is in 0.8.0 while appearing nowhere in 0.8.0's
changelog. An operator deciding whether to upgrade reads the changelog; a CVE
they are expected to act on has to be in it. Ordinary bumps stay `chore(deps)`
— the distinction is whether an advisory is being closed, not how the PR was
opened, so a Dependabot PR retitled by hand is the normal case here.

**A green Dependabot is not evidence about what ships. The image scan is the
authority; Dependabot is a convenience that proposes bumps early.** Dependabot
classifies a package by where it is _declared_. The image contains the result of
dependency _resolution_, and those are different sets. `@sveltejs/kit` is a
devDependency, so its alerts auto-dismiss as `development` scope — while
`bits-ui → runed → @sveltejs/kit → vite → postcss → nanoid` is installed by
`npm ci --omit=dev`, which is exactly what the Dockerfile's prod-deps stage
runs. `--omit=dev` drops the declaration, not the closure. Three CVEs reached a
shipped image with **zero open Dependabot alerts**; only Trivy scanning the
image saw them. Do not fix this by reconfiguring Dependabot — it does what it
does. The fix is to stop reading it as a guarantee, and to ask the image. The
`image-cve` job in `ci.yml` asks it on every pull request, with the publish
gate's own policy so a green PR predicts a green release. Background: #164.
