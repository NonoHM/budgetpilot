# Reports: what each figure counts

Checked against a running instance, not recalled. For what to do with the
page, see [reports](../using/reports.md).

## Period

The same six choices as the dashboard, plus **From** and **To** fields and a
**Show** button. The page's own subtitle states the one thing that is easy
to assume otherwise: the report covers the chosen period **without a source
filter**, so it is not narrowed by anything you set elsewhere.

## The six figures

| Figure        | What it is                                      | Comparison |
| ------------- | ----------------------------------------------- | ---------- |
| Income        | Money in over the period                        | yes        |
| Expenses      | Money out over the period                       | yes        |
| Balance       | Income minus expenses                           | yes        |
| Transactions  | How many transactions the period holds          | no         |
| Expense / day | Expenses spread over the days the period covers | no         |
| Savings rate  | The share of income not spent                   | no         |

The three comparisons are against the **previous comparable period**, which
is named in the card rather than left to be guessed.

The arithmetic on the seeded instance: €2,850.00 income and €401.22 expenses
give a €2,448.78 balance and an 86% savings rate; €401.22 over the 31 days
of the month is €12.94 a day.

## Spending by category

A donut with the period's total in the middle. The header states the total
and how many categories it covers. Each share is rounded to a whole
percentage, so the listed shares need not add to exactly 100.

## Spending by nature

The same spending split by nature rather than by category: actual spending,
investments, transfers, refunds, fees, and anything unclassified. A period
showing 100% actual spending contains no transfers between your own
accounts.

Nature comes from the category. The **Categories** page holds the mapping.

## Top categories

One row per category with spending in the period: the category, how many
transactions, and its share. Same figures as the donut.

## Largest expenses

The **five** largest single expenses of the period.

The **Label** column is the merchant with the category appended. For the
fourteen categories BudgetPilot creates for you, that appended name is the
**stored** one, which is French, so a row can read `Corner Market -
Alimentation` beside a Category column reading `Groceries`. Both name the
same category. Categories you create yourself have one name and cannot
disagree with themselves.

## Cash-flow forecast

A **three-month** projection, which is a different horizon from the
dashboard's card. The dashboard runs to the end of the current month; this
one runs three months out. The two answer different questions and are not
expected to agree.

## Detected flows

What the projection is built from, with the rule stated above the table:

- **at least three occurrences**, and
- **high or medium confidence**, where confidence measures how regular the
  rhythm and the amount are.

| Column         | What it holds                              |
| -------------- | ------------------------------------------ |
| Label          | Merchant with the stored category appended |
| Category       | The category, translated                   |
| Cadence        | Weekly, monthly, and so on                 |
| Confidence     | High, medium or low                        |
| Average amount | Signed: income positive, expenses negative |

A flow absent from this table is absent from the projection. The usual
reason is that it has not happened three times yet.

## Related

- [The dashboard](./dashboard.md), whose forecast card uses a shorter
  horizon and whose Upcoming bills card uses a third one.
- [Budgets](./budgets.md), which are not shown on this page.
