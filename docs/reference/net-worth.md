# Net worth: types, history and what reads it

Checked against a running instance, not recalled. For the steps, see
[net worth](../using/net-worth.md).

## Account types

**Checking account**, **Savings**, **Investment**, **Real estate**,
**Other**, **Debt**.

The type is not decoration. One thing in the app reads it, and it is the
cash-flow forecast: see below.

## Balances and history

Balances are **entered by hand**. They are never derived from your
transactions, and nothing writes them for you.

Each account carries a **Value as of** date. Left empty it means today.
Every balance saved against a new date is kept, and the curve is drawn
through those points, so history is a record of what you entered rather than
a reconstruction.

## The two views

| View          | Shows                                                   |
| ------------- | ------------------------------------------------------- |
| **Curve**     | The total over time, with its highest and lowest points |
| **Breakdown** | The total split by account type, as a share of assets   |

Breakdown view carries a **Negative balances** line. Accounts in the red are
**already deducted** from the net worth total, and the line exists so that
is not deducted twice by a reader doing their own arithmetic.

## What the cash-flow forecast takes from here

The forecast's starting balance is the sum of your **checking** accounts
only. Savings, investment, real estate, other and debt accounts are left
out, because the projection is about day-to-day cash rather than wealth.

On the instance these figures come from, net worth is €10,250.00 while the
forecast anchors on €4,450.00, the checking account alone. Both are correct
and they answer different questions.

With no checking account recorded, the forecast has no anchor and shows net
movement from zero instead of a balance.

## Savings goals

| Tracking             | Progress comes from                    |
| -------------------- | -------------------------------------- |
| Manual               | An amount you type and update yourself |
| Linked to an account | The balance of a net worth account     |

A deadline is optional. Up to **two** goals appear on the dashboard, which
grows a **See all** link when there are more.

## Related

- [The dashboard](./dashboard.md), whose forecast anchors on the checking
  accounts described above and whose savings-goals card shows two.
- [Reports](./reports.md), whose three-month projection uses the same
  anchor.
