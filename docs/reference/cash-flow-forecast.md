# Cash-flow forecast: gates, anchor and horizons

Checked against a running instance, not recalled. For what the card means,
see [the cash-flow forecast](../using/cash-flow-forecast.md).

## What feeds the projection

| Gate        | Value                               |
| ----------- | ----------------------------------- |
| Occurrences | **at least 3**                      |
| Confidence  | **high or medium**                  |
| Recency     | The flow must not have gone dormant |

The first two are stated by the app itself, above the Detected flows table
on `/reports` and in the empty card. A flow that fails any of them is still
listed there, and still excluded from the projection.

## The starting balance

The sum of the user's **checking** accounts on the net worth page. Savings,
investment, real estate, other and debt are excluded.

Measured on the documented fixture: net worth €10,250.00, forecast anchor
€4,450.00, the checking account alone.

With no checking account, the ledger starts at a relative zero and shows net
projected movement rather than a balance. No figure is invented.

## The two empty states

| State                          | Condition                                      |
| ------------------------------ | ---------------------------------------------- |
| **Not enough recurring flows** | Fewer than 3 confirmed flows                   |
| **Dormant recurring flows**    | Flows exist; none has recurred recently enough |

Both were reproduced on a throwaway instance rather than described:

- Three monthly flows seeded 6, 7 and 8 months ago, confirmed by occurrence
  count and all long past a cycle, render **Dormant**.
- Removing flows until only one remained still rendered **Dormant**, so
  dormancy is decided before the count is. **Not enough** appeared only once
  no detected flow was left at all.

Both cards offer **View detected recurring flows**, pointing at
`/reports#annexe-recurrences`. In the _Not enough_ state that anchor does not
exist on the reports page, so the link scrolls nowhere. Measured; recorded
as a known issue rather than documented as a feature.

## The three horizons

| Where                                | Window                  |
| ------------------------------------ | ----------------------- |
| The dashboard's forecast card        | To the end of the month |
| `/reports`' projected balance        | Three months            |
| The dashboard's Upcoming bills total | A rolling 30 days       |

Three different questions. Two of them coincide on the documented fixture
because of when the bills fall, which is a property of that data and not a
rule.

## Determinism

No machine learning and no network call. The projection is derived from the
user's own transactions, so the same data produces the same curve.

## Related

- [Upcoming bills](./upcoming-bills.md), the same detected flows presented
  as a month's list.
- [Reports](./reports.md), whose Detected flows table names every flow with
  its cadence and confidence.
- [Net worth](./net-worth.md), where the checking accounts that anchor the
  projection are maintained.
