# Using BudgetPilot

How the app works once it is running. If you are still installing it, go
to [getting started](../getting-started.md) first.

- **[The transactions screen](./transactions.md)**: search, filters,
  editing a transaction, and what the CSV export contains.
- **[Tags](./tags.md)**: labelling transactions across categories, tagging
  many at once, and the limits.
- **[Splitting a transaction](./split-transactions.md)**: one payment,
  several categories, and what changes in your budgets and reports.

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
