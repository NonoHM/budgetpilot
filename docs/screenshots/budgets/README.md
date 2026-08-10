# Budgets screenshots

Captured with:

```bash
BASE_URL=http://localhost:4175 node scripts/doc-screenshots.mjs budgets
```

## The arrangement they need

The point of the overview image is that all **three** states are visible at
once, so the instance must hold one budget of each before capturing:

| Category   | Limit  | Spent this month | State      |
| ---------- | ------ | ---------------- | ---------- |
| Groceries  | 300.00 | 149.22           | OK         |
| Dining out | 80.00  | 115.50           | Over       |
| Transport  | 62.00  | 50.10            | Near limit |

Transport's limit is 62.00 rather than a round number for a reason: 50.10 of
62.00 is 80.8%, which is the first side of the 80% boundary, and 50.10 of
63.00 is 79.5%, which is the other. Those two figures are what the reference
page's threshold claim rests on, so the fixture keeps one of them.

The spending figures come from the demo dataset that
`scripts/demo-screenshots.mjs` seeds.

## Language

English, with the browser locale pinned as well as the app's. See
[the screenshots README](../README.md) for why both matter.
