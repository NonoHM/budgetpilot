# BudgetPilot documentation

## Install it

- **[Getting started](./getting-started.md)**: install and first login, with
  or without Docker. Start here.
- **[Configuration](./configuration.md)**: every setting, and how to reach
  the app from another machine.
- **[Reverse proxy](./reverse-proxy.md)**: optional Caddy overlay for a real
  domain with automatic HTTPS.
- **[PostgreSQL or MySQL](./database-providers.md)**: optional, for installs
  that already run a database server. SQLite is the default and needs no
  setup.
- **[Running it day to day](./operations.md)**: updating, backups, moving
  machines, uninstalling.
- **[Local AI advice](./ai-insights.md)**: the optional Ollama setup.
- **[Bank sync](./bank-sync.md)**: the optional automatic PSD2 connection.
- **[Troubleshooting](./troubleshooting.md)**: when something's broken.

## Use it

How to do things, in [using BudgetPilot](./using/README.md):

- [The dashboard](./using/dashboard.md): the first screen, and what each
  figure on it counts.
- [The transactions screen](./using/transactions.md): search, filters, editing
  a transaction, and what the CSV export contains.
- [Tags](./using/tags.md): labelling transactions across categories.
- [Splitting a transaction](./using/split-transactions.md): one payment,
  several categories.

## Look it up

Rules, limits and exact values, in [reference](./reference/README.md):

- [Dashboard](./reference/dashboard.md): every figure, the period choices,
  and the caps on each card.
- [Split transactions](./reference/split-transactions.md): part counts,
  amount ceiling, rounding, CSV columns, refusal messages.

## Understand it

Why the app behaves as it does, in [explanation](./explanation/README.md):

- [Why a split row shows two amounts under a filter](./explanation/filtered-row-amounts.md).

---

Contributing to the code instead? See
[CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).
