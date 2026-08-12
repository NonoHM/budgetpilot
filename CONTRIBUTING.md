# Contributing to BudgetPilot

BudgetPilot is a solo-maintained, local-first personal budgeting app.
Contributions (bug reports, small fixes, focused features) are welcome.
Please keep changes focused and discuss larger ones in an issue first.

## Setup

Prerequisites: Node 24.18.0 and a C++ toolchain (bcrypt and better-sqlite3
compile native code during `npm install`). On Debian/Ubuntu that's
`python3 build-essential pkg-config`, on macOS `xcode-select --install`.

```bash
nvm install && nvm use   # Node 24.18.0
npm install
cp .env.example .env
```

Generate the required secrets and paste them into `.env`. Leaving them
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

`npm run setup` generates the three secrets for you instead of the manual
`openssl` step above. Running the app with Docker rather than the dev
server, or stuck on any of this? See
[docs/getting-started.md](./docs/getting-started.md).

## Before opening a PR

Run the full validation suite locally. It must be 100% green:

```bash
npx prisma generate
npm run lint            # prettier --check + eslint
npm run check           # svelte-kit sync + paraglide compile + svelte-check
npm run test:unit -- --run
npm run build
npm run test:e2e        # self-contained, uses its own throwaway DB
```

The same commands run in CI (`.github/workflows/ci.yml`) on every push and
PR, and a red CI run blocks merge.

If you changed `prisma/schema.prisma`, generate a migration and refresh the
other providers' schemas:

```bash
npx prisma migrate dev --name <name>
npx prisma generate
npm run db:schemas
```

`prisma/schema.prisma` is the authored source and stays on SQLite, the default
provider. The PostgreSQL and MySQL schemas next to it are generated from it and
committed, so `npm run db:schemas` is not optional: CI runs
`npm run db:schemas:check` and fails if they are stale. Never edit a generated
schema by hand, your change is overwritten on the next run.

Each provider keeps its own migration history under
`prisma/migrations/<provider>/`. `npx prisma migrate dev` writes to the one
matching `DATABASE_PROVIDER`, which is SQLite unless you set it.

Never run `prisma migrate reset` against a database you care about.

## Code conventions

- **Language**: code, identifiers, and comments are always written in
  English, regardless of the app's own UI language(s). Only user-facing
  strings go through the i18n system (Paraglide, `messages/fr.json` /
  `messages/en.json`).
- **Comments**: only when the _why_ isn't obvious from the code itself (a
  non-obvious constraint, a workaround, a subtle invariant), not a
  restatement of what the code does.
- **No em dashes (`—`)** in anything written for a reader: documentation,
  comments, commit messages, PR and issue titles and bodies. Use a colon,
  a comma, parentheses, or a full stop, whichever the sentence wants, and
  not a hyphen standing in for the same construction. Quoted material (a
  rendered UI string, a log line) is reproduced exactly.
- Prefer editing/reusing existing shared components and server-side
  modules over duplicating logic. Check for an existing helper before
  writing a new one.
- Keep `src/lib/domain/` free of infrastructure imports (no Prisma, no
  `$app/*`, no `src/lib/server/`). It must stay pure, framework-agnostic
  logic that's testable without mounting a route.
- No visual regression tooling is used in this project: Playwright
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

### Which types reach the changelog

BudgetPilot is self-hosted, so the changelog is what an operator reads to
decide whether to upgrade and what to expect afterwards. The default set of
visible types assumes a library, where a refactor cannot change what a user
sees. That assumption does not hold here, so `release-please-config.json`
sets `changelog-sections` explicitly:

| Type                  | Shown as                 | Why                                                               |
| --------------------- | ------------------------ | ----------------------------------------------------------------- |
| `feat`                | Features                 | New capability.                                                   |
| `fix`                 | Bug Fixes                | Corrected behaviour, including security fixes.                    |
| `perf`                | Performance Improvements | Visible in how the app responds.                                  |
| `refactor`            | Behaviour and internals  | An internal change can still move what a user sees on screen.     |
| `deps`                | Dependencies             | A dependency ships inside the image.                              |
| `build`               | Build and packaging      | Image, Dockerfile and Compose changes are the operator's upgrade. |
| `docs`                | Documentation            | The docs are part of what is delivered.                           |
| `chore`               | Maintenance              | Everything else that ships.                                       |
| `revert`              | Reverts                  | Something was taken back out.                                     |
| `ci`, `test`, `style` | hidden                   | Cannot reach a running install.                                   |

Two consequences worth knowing:

- **Visibility and versioning are separate.** Only `feat`, `fix` and a
  `BREAKING CHANGE:` footer move the version number. Listing a type above
  makes it appear in the changelog and does nothing to the version.
- **`chore` is visible on purpose,** which is noisier than the default. It
  is deliberate: Dependabot opens every bump as `chore(deps)`, and under
  the default configuration a dependency upgrade carrying a security fix
  shipped in a release whose notes did not mention it. Retitling such a PR
  to `fix(deps)` is still the right thing, because Bug Fixes is where a
  reader looks for it, but the changelog no longer depends on someone
  remembering.

**Write the description for the person reading the changelog.** Say the
user-visible consequence, not the internal mechanism. "make the stored name
the only name" tells a maintainer what changed in the code; "seeded
categories now show their stored French name until you rename them" tells an
operator what their users will see on Monday.

## Reporting security issues

Do not open a public issue for a vulnerability. See
[SECURITY.md](./SECURITY.md) for the private reporting process.
