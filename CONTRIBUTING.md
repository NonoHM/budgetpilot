# Contributing to BudgetPilot

BudgetPilot is a solo-maintained, local-first personal budgeting app.
Contributions (bug reports, small fixes, focused features) are welcome —
please keep changes focused and discuss larger ones in an issue first.

## Setup

```bash
nvm install && nvm use   # Node 24.18.0
npm install
cp .env.example .env
```

Generate the required secrets and paste them into `.env` — leaving them
blank crashes `/register` and `/login` at startup:

```bash
openssl rand -base64 32   # -> BOOTSTRAP_TOKEN
openssl rand -hex 32      # -> RATE_LIMIT_HASH_SECRET
openssl rand -hex 32      # -> TOTP_ENCRYPTION_KEY
```

```bash
npx prisma generate
npx prisma migrate dev
npm run dev
```

## Before opening a PR

Run the full validation suite locally — it must be 100% green:

```bash
npx prisma generate
npm run lint            # prettier --check + eslint
npm run check           # svelte-kit sync + paraglide compile + svelte-check
npm run test:unit -- --run
npm run build
npm run test:e2e        # self-contained, uses its own throwaway DB
```

The same commands run in CI (`.github/workflows/ci.yml`) on every push and
PR — a red CI run blocks merge.

If you changed `prisma/schema.prisma`, generate a migration:

```bash
npx prisma migrate dev --name <name>
npx prisma generate
```

Never run `prisma migrate reset` against a database you care about.

## Code conventions

- **Language**: code, identifiers, and comments are always written in
  English, regardless of the app's own UI language(s). Only user-facing
  strings go through the i18n system (Paraglide, `messages/fr.json` /
  `messages/en.json`).
- **Comments**: only when the _why_ isn't obvious from the code itself (a
  non-obvious constraint, a workaround, a subtle invariant) — not a
  restatement of what the code does.
- Prefer editing/reusing existing shared components and server-side
  modules over duplicating logic — check for an existing helper before
  writing a new one.
- Keep `src/lib/domain/` free of infrastructure imports (no Prisma, no
  `$app/*`, no `src/lib/server/`) — it must stay pure, framework-agnostic
  logic that's testable without mounting a route.
- No visual regression tooling is used in this project — Playwright
  end-to-end specs (`npm run test:e2e`) are the source of truth for UI
  behavior; a UI change should come with a targeted e2e or component test
  where it makes sense, not a full VRT snapshot suite.

## Commit messages: Conventional Commits (required)

Every commit message must follow the
[Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`,
`ci`, `build`. Examples:

```
feat(budgets): add monthly rollover option
fix(auth): align dummy-hash cost with PASSWORD_HASH_COST
docs: clarify bank-sync allowlist behavior
```

For a breaking change, add a footer starting with `BREAKING CHANGE:`
describing the impact.

This isn't just a style preference: release automation
([release-please](https://github.com/googleapis/release-please)) parses
commit history to compute the next version and generate `CHANGELOG.md`. A
non-conforming commit message will be invisible to that automation.

## Reporting security issues

Do not open a public issue for a vulnerability — see
[SECURITY.md](./SECURITY.md) for the private reporting process.
