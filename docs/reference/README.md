# Reference

Rules, limits and exact values. Look things up here; the pages in
[using BudgetPilot](../using/README.md) tell you how to do things.

- **[Dashboard](./dashboard.md)**: what each figure counts, the period
  choices, and the caps on every card.
- **[Budgets](./budgets.md)**: the 80% threshold, what the summary strip
  adds up, and what deleting one does.
- **[Reports](./reports.md)**: the six figures, the three-month horizon,
  and the rule a flow must meet to reach the projection.
- **[Split transactions](./split-transactions.md)**: how many parts, the
  amount ceiling, the rounding cent, what a filtered row displays, the CSV
  columns, and every refusal message.

Settings and environment variables are not here: those are in
[configuration](../configuration.md), because they belong to the install
rather than to the app.

## How these pages are written

Every number, label and limit is read out of the code before it is written
down, never recalled. Documentation is exactly where recall feels sufficient,
because the person writing it has just built the feature and is sure they know
it.

So: if a sentence here states a number, a label, a cap or a behaviour, check it
against the code before changing it, and check it again before trusting it.
