# BudgetPilot

[![CI](https://github.com/NonoHM/budgetpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/NonoHM/budgetpilot/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

A local-first, privacy-first personal budgeting app. Think Monarch or YNAB, but self-hosted, and your bank data never leaves your own machine.

## Why this exists

Honest answer: my personal finances were kind of a mess, and I wanted an excuse to test agentic AI coding on something real, not just a toy script. Something with an actual UI, actual users (well, me), and enough moving parts to be a genuine test of whether "vibe coding" with an AI assistant could produce something solid, not just something that looks fine in a demo.

I'm not a professional developer. I built this over several months with Claude, trying to hold myself to real standards anyway: proper security reviews, a real test suite, a design system that's actually consistent instead of every page inventing its own button style. Whether I pulled that off is for you to judge by reading the code, not by trusting this README.

This isn't trying to replace Monarch, YNAB, or the other well-established players in this space. Open source alternatives exist too (Firefly III, Actual Budget, to name two), and they're more mature and, in some areas, better built than this. BudgetPilot is just my take on it, local-first and privacy-first by default, and I'm putting it out there in case it's useful to someone else too.

The weakest part right now is honestly CSV import: only a handful of bank profiles are supported, and the parser system needs more work to cover more banks and formats. Contributions there especially welcome.

**Known limitations:**

- CSV import covers a limited set of bank profiles; unlisted banks need a new parser.
- Account emails have to be ASCII, on every database engine. See [configuration](docs/configuration.md#database).

![Dashboard](docs/screenshots/dashboard-desktop.png)

<p align="center">
  <img src="docs/screenshots/net-worth-desktop.png" alt="Net worth tracking with history chart" width="49%" />
  <img src="docs/screenshots/budgets-desktop.png" alt="Monthly budgets, one over and one under" width="49%" />
</p>

All screenshots use fake demo data, not a real user's finances.

## What it does

- **Manual and CSV import**, with bank-specific profiles and duplicate detection.
- **Optional automatic bank sync** (PSD2, via Enable Banking). Off by default. HTTPS only, explicit host allowlist, no credential scraping, ever.
- **Budgets**: monthly, per category, with alerts when you're close to the limit.
- **[Net worth tracking](docs/using/net-worth.md)** across multiple accounts, with history over time.
- **[Savings goals](docs/using/savings-goals.md)**, with pace tracking and an optional link to a real account.
- **Cash flow forecasting**: a deterministic projection of your upcoming balance, based on recurring income and expenses it actually detects from your history. No machine learning involved, nothing sent anywhere.
- **[Categorization rules](docs/using/rules.md)** (text or regex), applied automatically on import, never overriding something you fixed by hand. 156 ship with the app.
- **[Split transactions](docs/using/split-transactions.md)**: one payment across several categories, so an 80 € supermarket trip can be 50 € Groceries and 30 € Shopping. Budgets and reports count the parts, your totals stay exactly the same, and the CSV export carries the split back out and in again.
- **Tags**: free labels that cut across categories, so "Portugal 2026" can hold a train, a restaurant and a hotel while each keeps its own category. Filter the list by one, tag a whole filtered set at once, and undo that in a click.
- **Optional local AI advice** via Ollama. By default, only anonymized aggregates reach the model. An opt-in setting can add the labels of your largest expenses, never your full transaction history.
- **Backup and restore**: a full export of your own data, nothing held hostage.
- French and English, out of the box.

## Quick start

You need Docker with the Compose plugin (`docker compose version` should print v2 or newer). Nothing else: no clone, no build, no Node.js.

```bash
mkdir budgetpilot && cd budgetpilot
curl -O https://raw.githubusercontent.com/NonoHM/budgetpilot/main/docker-compose.prebuilt.yml
```

Create your `.env` with three freshly generated secrets. Paste this whole block:

```bash
cat > .env <<EOF
BOOTSTRAP_TOKEN=$(openssl rand -base64 32)
RATE_LIMIT_HASH_SECRET=$(openssl rand -hex 32)
TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
APP_PORT=3000
ORIGIN=http://localhost:3000
EOF
```

Start it:

```bash
docker compose -f docker-compose.prebuilt.yml up -d
```

Open **http://localhost:3000** and create your account. Registration is closed by default, so the form asks for a token: it's the `BOOTSTRAP_TOKEN` you just generated (`grep BOOTSTRAP_TOKEN .env`). The first account created becomes the admin. The interface starts in French, switch to English from Settings.

On Windows, run all of this from Git Bash or WSL. Port 3000 already taken, or want to run it from a source checkout instead? The [full walkthrough](docs/getting-started.md) covers both, plus running it without Docker.

Reaching it from another device on your LAN takes two extra lines in `.env` (`ORIGIN` and `PUBLIC_INSTANCE=false`), and a real domain with automatic HTTPS takes an optional [Caddy overlay](docs/reverse-proxy.md).

## Documentation

- **[Getting started](docs/getting-started.md)**: the detailed version of the above, three install paths, and what to do once you're in.
- **[Using BudgetPilot](docs/using/README.md)**: the app itself. [The dashboard](docs/using/dashboard.md), [budgets](docs/using/budgets.md), [reports](docs/using/reports.md), [rules](docs/using/rules.md), [categories](docs/using/categories.md), [upcoming bills](docs/using/upcoming-bills.md), [imports](docs/using/imports.md), [net worth](docs/using/net-worth.md), [transactions](docs/using/transactions.md), [tags](docs/using/tags.md), and [splitting one payment across several categories](docs/using/split-transactions.md).
- **[Configuration](docs/configuration.md)**: every setting, and how to reach the app from your phone or another machine.
- **[Reverse proxy](docs/reverse-proxy.md)**: optional Caddy overlay for a real domain with automatic HTTPS.
- **[PostgreSQL or MySQL](docs/database-providers.md)**: optional overlays for installs that already run a database server. SQLite is the default and needs nothing.
- **[Running it day to day](docs/operations.md)**: updating, backups, moving machines.
- **[Local AI advice](docs/ai-insights.md)** and **[bank sync](docs/bank-sync.md)**: the two optional features.
- **[Troubleshooting](docs/troubleshooting.md)**: when something's broken.

## Tech stack

SvelteKit, TypeScript, Prisma, SQLite by default (PostgreSQL and MySQL/MariaDB optional), Tailwind CSS, Vitest, Playwright, Docker.

## Contributing

Bug reports, feature ideas, and pull requests are all welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, tests, and commit conventions. If you're using an AI coding assistant, there's an [AGENTS.md](./AGENTS.md) with project context it should read first.

Release notes live in [CHANGELOG.md](./CHANGELOG.md).

## Security

This is a finance app, so security gets taken seriously. See [SECURITY.md](./SECURITY.md) for what's supported and how to report a vulnerability privately (please don't open a public issue for that one).

## License

[Apache License 2.0](./LICENSE).
