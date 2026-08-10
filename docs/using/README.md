# Using BudgetPilot

How to do things in the app once it is running. If you are still installing
it, go to [getting started](../getting-started.md) first.

- **[The dashboard](./dashboard.md)**: the first screen, its period
  selector, and the two cards that look ahead instead of back.
- **[Budgets](./budgets.md)**: a monthly limit per category, the three
  states a budget can be in, and what the summary strip counts.
- **[Reports](./reports.md)**: where the money went over a period, the
  charts, and the flows behind the projection.
- **[Importing a statement](./imports.md)**: the summary an import
  reports, the history it records, and how to undo one.
- **[Upcoming bills](./upcoming-bills.md)**: what is due, worked out from
  your own history, and how to correct what the app got wrong.
- **[Categories](./categories.md)**: the fourteen you start with, what
  nature is for, and what deleting one does to its transactions.
- **[Categorization rules](./rules.md)**: the 156 that ship, writing your
  own, and the preview that shows what applying them would do.
- **[Savings goals](./savings-goals.md)**: the two tracking modes, and
  what a deadline turns a target into.
- **[Net worth](./net-worth.md)**: accounts and balances over time, the
  two views, and savings goals.
- **[The transactions screen](./transactions.md)**: search, filters,
  editing a transaction, and what the CSV export contains.
- **[Tags](./tags.md)**: labelling transactions across categories, tagging
  many at once, and the limits.
- **[Splitting a transaction](./split-transactions.md)**: one payment,
  several categories, and how to change or remove a split.

For the exact rules and limits rather than the steps, see
[reference](../reference/README.md). For why a split row shows two amounts
under a category filter, see [explanation](../explanation/README.md).

These pages describe the app, not the install. Anything about Docker,
environment variables, backups or upgrades is in the pages listed in
[the documentation index](../README.md).

## How these pages are written

Every number, label and limit here was read out of the code before it was
written down, never recalled. That sounds like a small thing and is not:
documentation is exactly where recall feels sufficient, because the person
writing it has just built the feature and is sure they know it.

The first draft of these three pages had three facts wrong that way. The
type filter was listed as four permanent tabs when the fourth only appears
while something is waiting for a category. The nature list was five values
when it is seven. And regex search was described as ignoring accents, which
the contains search does and the regex one does not.

None of those would have been caught by a proofread, because all three read
perfectly well. So: if a sentence here states a number, a label, a cap or a
behaviour, check it against the code before changing it, and check it again
before trusting it.
