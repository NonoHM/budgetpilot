# Budgets: thresholds and totals

Checked against a running instance, not recalled. For the steps, see
[budgets](../using/budgets.md).

## What a budget is

One **monthly limit** on one **category**. It recurs: the amount applies to
every month until you change or delete it. The page always shows the current
month, named under the title.

## The three states

| Badge          | Condition                   |
| -------------- | --------------------------- |
| **OK**         | Below 80% of the limit      |
| **Near limit** | 80% of the limit or more    |
| **Over**       | Above the limit, which wins |

The 80% boundary was measured rather than read: €50.10 against a €63.00
limit is 79.5% and shows **OK**; the same €50.10 against €62.00 is 80.8% and
shows **Near limit**.

## The summary strip

| Figure           | What it counts                              |
| ---------------- | ------------------------------------------- |
| Spent this month | Spending in **budgeted categories only**    |
| Total budget     | The sum of every limit                      |
| _n_ % used       | Spent this month over total budget, rounded |
| Remaining        | Total budget minus spent this month         |

**Spent this month is not your total spending.** In the instance these
figures come from, the three budgeted categories account for €314.82 while
the month's expenses are €401.22: the €86.40 difference is spending in
categories with no budget. The strip answers "how am I doing against the
limits I set", nothing wider.

## Amounts

Both decimal separators are accepted on entry. `60.00` and `60,00` both
store sixty euros, in either language.

The field shows the stored amount with a **comma** as the decimal separator
whatever language the app is in, so an English reader editing a budget sees
`60,00` where the rest of the page says `€60.00`. It parses correctly either
way; only the display of that one field disagrees.

## What counts towards a budget

Spending in the category, over the current month.

**Split transactions count per part.** A transaction split between two
categories charges each budget its own share, never the whole amount to
either. See the
[split reference](./split-transactions.md#what-a-split-changes-elsewhere).

## Deleting

Deleting a budget removes the limit only. No transaction is modified, and no
spending history changes. Both breakpoints ask for confirmation first, and
the confirmation names the category.

## Related

- [The dashboard](./dashboard.md), whose Budget tracking card shows up to
  six budgets and whose Insights raise an alert from these same thresholds.
- [Splitting a transaction](../using/split-transactions.md).
