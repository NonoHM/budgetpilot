# Dashboard: what each figure counts

Every figure here was checked against a running instance, not recalled. For
what to do with the screen, see [the dashboard](../using/dashboard.md).

## The period

| Choice       | Range                               | In the address bar         |
| ------------ | ----------------------------------- | -------------------------- |
| This month   | 1st of the current month to today   | `?period=this-month`       |
| Last month   | The whole previous calendar month   | `?period=last-month`       |
| Last 30 days | Rolling, ending today               | `?period=last-30-days`     |
| Last 90 days | Rolling, ending today               | `?period=last-90-days`     |
| All time     | Every transaction                   | `?period=all-time`         |
| Custom…      | Two dates you choose, both included | `?period=custom&from=&to=` |

The period governs the three figures, Insights, Recent transactions, Real
analysis and Budget tracking. It does **not** govern Upcoming bills or the
Cash-flow forecast, which are described at the bottom of this page.

## The three figures

| Figure         | What it is                                    |
| -------------- | --------------------------------------------- |
| Income         | Every incoming amount in the period, added up |
| Expenses       | Every outgoing amount in the period, added up |
| Period balance | Income minus expenses                         |

Both totals are positive numbers, and the balance is their difference, so a
month where you took in more than you spent shows a positive balance in
green.

**Splits count as their parts.** A transaction split three ways contributes
its three amounts, which add up to the transaction, so no total changes by
splitting. See the
[split reference](./split-transactions.md#what-a-split-changes-elsewhere).

## Insights

| Item             | When it appears                                 |
| ---------------- | ----------------------------------------------- |
| Budget alert     | A category with a budget is over it, or near it |
| Unusual spending | A category is well above its own usual level    |

**The badge counts budget alerts only.** A panel holding two budget alerts
and one unusual-spending line reads `2 to review`, because the third item is
not an alert. When there is no alert at all, no badge is shown.

A budget alert states the spend, the limit, and how many days are left in
the month. One that is near its limit rather than past it also gives the
daily pace that would keep it under. **View category** opens the
transactions list filtered to that category.

## Recent transactions

| Where    | Rows |
| -------- | ---- |
| Computer | 10   |
| Phone    | 5    |

Newest first. **View all** goes to the full transactions list.

## Real analysis

Six lines, one per nature: **Actual spending**, **Investments**,
**Transfers**, **Refunds**, **Fees**, **Unclassified**. The badge counts how
many are not zero.

A transaction's nature comes from its category. The **Categories** page has
a Nature column and is where the mapping is changed, so a savings transfer
only counts as a transfer once its category says so.

## Budget tracking

Shows **at most six** categories that have a budget, ordered by the
category's **stored** name.

That ordering is worth knowing if you read the app in English, because the
14 categories BudgetPilot creates for you are stored under their French
names and translated on screen. So the six you see are the first six
alphabetically in French, which in English looks like no order at all:
Subscriptions, Groceries, Housing, Leisure, Dining out, Health. **Manage**
opens the Budgets page, which shows all of them.

A category counts as **over** once spending passes its limit.

## Savings goals

Shows **at most two** goals, and grows a **See all** link once there are
more. Goals live on the **Net worth** page, which is where they are created
and where all of them are listed.

## Upcoming bills

The next payments due, from recurring flows detected in your own history.
The total underneath covers a **rolling 30 days from today**, and the label
says so. **See all upcoming bills** opens the full list.

## Cash-flow forecast

Projects a balance to the **end of the current month**, which is a different
window from the 30-day total above it. The two agree only by coincidence.

The projection starts from the total of your **checking** net worth
accounts. Savings, investment and debt accounts are deliberately left out:
the forecast is about day-to-day cash. With no checking account recorded,
the curve starts from zero and shows the net movement rather than a real
balance.

The chart carries a table of the same figures for a screen reader, one row
per day, each marked **Realized** or **Projected**, naming the flow that
moves the line.

## Related

- [Splitting a transaction](../using/split-transactions.md), and why a split
  changes no total.
- [The transactions screen](../using/transactions.md), which every **View
  category** and **View all** link opens.
