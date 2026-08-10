# Upcoming bills: badges, totals and windows

Checked against a running instance, not recalled. For what to do with the
page, see [upcoming bills](../using/upcoming-bills.md).

## Where the rows come from

Repeating payments detected in your own transactions. Nothing is declared by
hand, and nothing here is editable except through the row menu.

## Confidence

| Badge         | Meaning                                       | In the total |
| ------------- | --------------------------------------------- | ------------ |
| **Confirmed** | Steady rhythm and steady amount               | yes          |
| **Uncertain** | Detected, but the rhythm or the amount varies | **no**       |

An uncertain row states `excluded from total` under its amount, so the
omission is visible on the row rather than only in the header.

## Status

| Badge        | Meaning                           |
| ------------ | --------------------------------- |
| **Upcoming** | Expected, not yet settled         |
| **Paid**     | An outgoing flow that has settled |
| **Received** | An incoming flow that has settled |

The page groups rows under **Upcoming** and **Settled this month**, each
with its own count.

## The header total

**What is still to pay in the displayed calendar month**, counting confirmed
flows only.

### Three windows, three pages

This is the figure most likely to be read as disagreeing with another, so
all three are stated together:

| Where                               | Window                       |
| ----------------------------------- | ---------------------------- |
| This page's header                  | The displayed calendar month |
| The dashboard's Upcoming bills card | A rolling 30 days from today |
| The cash-flow forecast              | To the end of the month      |

They answer different questions and are not expected to agree. On the
seeded instance two of them read −€993.99, which is a coincidence of when
the bills fall, not a rule.

## The row menu

| Action                   | Scope                                |
| ------------------------ | ------------------------------------ |
| Mark as paid             | This occurrence                      |
| Ignore this occurrence   | This occurrence; the flow remains    |
| View linked transactions | Opens what the detection is built on |
| Stop detecting this flow | The flow, permanently                |

## Month navigation

Arrows move one month at a time and the month is carried in the address bar
as `?month=YYYY-MM`, so a month can be linked to directly. The current month
carries a badge.

## Why a payment is not listed

A flow needs **at least three occurrences** to be confirmed, the same
threshold the reports page states above its Detected flows table. Below
that it is either absent or uncertain, and an uncertain flow is shown but
not counted.

## Related

- [Reports](./reports.md), whose Detected flows table lists the same flows
  with their cadence and confidence.
- [The dashboard](./dashboard.md), whose card is the rolling-30-day view of
  this page.
