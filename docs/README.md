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
- [Budgets](./using/budgets.md): a monthly limit per category, and the
  three states a budget can be in.
- [Reports](./using/reports.md): where the money went over a period, with
  charts and a three-month projection.
- [Importing a statement](./using/imports.md): the import summary, the
  history, and how to undo a run.
- [Upcoming bills](./using/upcoming-bills.md): what is due, and how to
  correct a flow the app got wrong.
- [Categories](./using/categories.md): the fourteen you start with, and
  what nature is for.
- [Categorization rules](./using/rules.md): the 156 that ship, and writing
  your own.
- [Net worth](./using/net-worth.md): accounts and balances over time, and
  savings goals.
- [The transactions screen](./using/transactions.md): search, filters, editing
  a transaction, and what the CSV export contains.
- [Tags](./using/tags.md): labelling transactions across categories.
- [Splitting a transaction](./using/split-transactions.md): one payment,
  several categories.

## Look it up

Rules, limits and exact values, in [reference](./reference/README.md):

- [Dashboard](./reference/dashboard.md): every figure, the period choices,
  and the caps on each card.
- [Budgets](./reference/budgets.md): the 80% threshold, and what the
  summary strip adds up.
- [Reports](./reference/reports.md): the six figures, and the rule a
  recurring flow must meet to reach the projection.
- [Imports](./reference/imports.md): the four counts, duplicate
  detection, and what deleting a run removes.
- [Upcoming bills](./reference/upcoming-bills.md): the badges, the header
  total, and the three windows.
- [Categories](./reference/categories.md): naming rules, the eight
  natures, and what deleting one does.
- [Rules](./reference/rules.md): how matching works, and why a rule never
  overrides a category you set by hand.
- [Net worth](./reference/net-worth.md): account types, and which of them
  the cash-flow forecast anchors on.
- [Split transactions](./reference/split-transactions.md): part counts,
  amount ceiling, rounding, CSV columns, refusal messages.

## Understand it

Why the app behaves as it does, in [explanation](./explanation/README.md):

- [Why a split row shows two amounts under a filter](./explanation/filtered-row-amounts.md).

---

Contributing to the code instead? See
[CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).
