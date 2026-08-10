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

**The fourteen categories BudgetPilot creates for you are stored under
canonical French names and translated for display.** So in English,
`Groceries` on screen is `Alimentation` in the database.

Uniqueness is checked against the **stored** name. The consequence is worth
knowing before it surprises you: creating a category called `Groceries` in
an English instance **succeeds**, because nothing named `Groceries` is
stored, and the list then shows two rows that read almost identically. The
dialog's promise that the name must be unique is true of what is stored, not
of what you see.

Categories you create yourself are stored exactly as you typed them and are
never translated, so they cannot disagree with themselves.

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
