# BudgetPilot

[![CI](https://github.com/NonoHM/budgetpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/NonoHM/budgetpilot/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

**Local-first, privacy-first personal budgeting.** BudgetPilot is a
self-hosted alternative to apps like Monarch or YNAB for people who want
real budgeting features — without handing their bank credentials or
transaction history to a third-party cloud service. Your data lives in a
single SQLite file you control.

- No mandatory external calls, no analytics, no scraping.
- Optional PSD2 bank sync (Enable Banking) and optional local AI insights
  (Ollama) are both opt-in and off by default.

## Features

- **Manual + CSV transaction import**, with configurable bank profiles and
  duplicate detection.
- **Optional PSD2 bank connections** (Enable Banking) for automatic
  transaction sync — disabled by default, https-only, explicit host
  allowlist, never any credential scraping.
- **Budgets**: monthly per-category budgets with alerts.
- **Net worth tracking**: multiple accounts, balance history over time.
- **Savings goals**: target amount/date, pace tracking, linkable to a net
  worth account.
- **Cash-flow forecast**: deterministic projection of upcoming balance
  based on detected recurring income/expenses — no ML, fully local.
- **Categorization rules**: text/regex matching rules, auto-applied on
  import, never overriding a manual correction.
- **Optional local AI budget advice** (Ollama): only aggregated, anonymized
  summaries are ever sent to the model — never raw transactions — and only
  if you explicitly enable it.
- **Backup/restore**: full JSON export/import of your own data, scoped to
  your account.
- Localized UI (French/English).

## Tech stack

SvelteKit + TypeScript · Prisma + SQLite · Tailwind CSS · Vitest +
Playwright · Docker (Node 24, `adapter-node`).

## Quick start (without Docker)

```bash
nvm install && nvm use
npm install
cp .env.example .env
```

Then generate the required secrets and paste them into `.env` (leaving them
blank will crash `/register` and `/login` at startup):

```bash
# Fill BOOTSTRAP_TOKEN, RATE_LIMIT_HASH_SECRET and TOTP_ENCRYPTION_KEY in .env
openssl rand -base64 32   # -> BOOTSTRAP_TOKEN
openssl rand -hex 32      # -> RATE_LIMIT_HASH_SECRET
openssl rand -hex 32      # -> TOTP_ENCRYPTION_KEY
```

```bash
npx prisma generate && npx prisma migrate dev
npm run dev
```

Open `http://localhost:5173`. Registering the first account requires the
`BOOTSTRAP_TOKEN` value you just generated, and that account automatically
becomes an admin.

## Docker

### Without GPU / AI (default)

```bash
cp .env.example .env
# Fill BOOTSTRAP_TOKEN, RATE_LIMIT_HASH_SECRET and TOTP_ENCRYPTION_KEY in .env
# (see "Quick start" above for the openssl commands) — required even here.
docker compose up -d --build
```

This starts BudgetPilot alone, backed by a persistent SQLite volume. No
Ollama container, no GPU requirement.

### With local AI (Ollama)

Requires an NVIDIA GPU with
[nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
installed on the host (`nvidia-ctk runtime configure --runtime=docker`, then
restart the Docker daemon). Without a GPU, remove the `deploy.resources`
block from `docker-compose.ai.yml` — Ollama will run on CPU (slower, still
functional).

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
docker compose exec ollama ollama pull qwen2.5:0.5b
```

Set `LLM_ENABLED=true` in `.env` (and, per-user, enable AI insights in
Settings) to turn on AI budget advice.

Stop either variant with `docker compose down` (never `-v`, unless you
intend to delete the persistent data volume).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, test commands, and
commit conventions. Release notes are tracked in
[CHANGELOG.md](./CHANGELOG.md).

## Security

See [SECURITY.md](./SECURITY.md) for the supported-versions policy and how
to privately report a vulnerability.

## License

[Apache License 2.0](./LICENSE).
