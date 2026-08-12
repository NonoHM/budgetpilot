# Categories: names, nature and deletion

Checked against a running instance, not recalled. For the steps, see
[categories](../using/categories.md).

## Where the page is

Not in the navigation bar. Two links reach it, both on the **Transactions**
screen, beside the category field of an open transaction.

## Names

| Rule       | Value               |
| ---------- | ------------------- |
| Length     | 1 to 80 characters  |
| Uniqueness | Required            |
| Renaming   | Allowed at any time |

Renaming is safe by construction: transactions, budgets and split parts
reference the category, not its spelling, so all of them follow.

### Uniqueness and the built-in names

**A category has one name: the one stored, which is the one shown.** Nothing
is translated, including the fourteen BudgetPilot creates for you. They are
created under French names and are ordinary rows from that moment on: you
rename and delete them like any other, and nothing downstream can tell one
from a category you typed yourself.

Uniqueness is therefore checked against the name you see, and the dialog's
promise that a name must be unique means what it says in every language.

**If you read the app in English, the fourteen start out reading in French.**
The Categories page offers, once, to rename them all into the language you
are reading; accepting is an ordinary rename, so budgets, rules, category
natures and any transaction you pinned by hand all follow. Dismissing the
offer keeps the names as they are and it does not come back. If you later
rename one back by hand, or switch language, the offer returns for what it
still applies to.

## Nature

Eight values are selectable per category: **None**, **Income**, **Actual
spending**, **Transfer**, **Investment**, **Refund**, **Fees**,
**Unclassified**.

**None** is the default for a category you create. It means the category has
no opinion, and the transaction's own sign decides whether it is money in or
money out.

The dashboard's **Real analysis** panel shows **six** lines, not eight:
Actual spending, Investments, Transfers, Refunds, Fees, Unclassified. Income
is not a spending nature, and None is the absence of one.

## Deleting

| Situation                | What happens                                    |
| ------------------------ | ----------------------------------------------- |
| No transactions          | Deleted                                         |
| Has transactions         | Deleted; the transactions move to Uncategorized |
| Used by parts of a split | **Refused**, with a link to the transactions    |

The confirmation states the transaction count before you commit. No
transaction is ever deleted with its category.

The split case is a refusal rather than a warning because a part's money
would otherwise have nowhere to go. See the
[split reference](./split-transactions.md#this-category-carries-n-split-parts).

## Restoring

**Restore default categories** recreates the original fourteen. Categories
you added are untouched.

## Related

- [The dashboard](./dashboard.md), whose Real analysis panel is built from
  nature.
- [Reports](./reports.md), whose spending-by-nature chart is the same data
  over a period.
- [Categorization rules](./rules.md), which set a category and optionally a
  nature automatically.
