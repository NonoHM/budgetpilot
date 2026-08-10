# Savings goals: tracking modes and pace

Checked against a running instance, not recalled. For the steps, see
[savings goals](../using/savings-goals.md).

## Where they are

On the **Net worth** page, under the accounts. Up to **two** appear on the
dashboard, which grows a **See all** link when there are more.

## The two tracking modes

| Mode                     | Progress comes from             | Progress history |
| ------------------------ | ------------------------------- | ---------------- |
| **Manual**               | An amount you type and maintain | none             |
| **Linked to an account** | A net worth account's balance   | the account's    |

A manual goal's detail states _"No history for a manually tracked goal"_
rather than drawing an empty chart, which is the honest version of the same
fact.

A linked goal names the account it follows, and its progress moves when the
account's balance is updated. Nothing about the goal needs editing again.

Only a **linkable** net worth account can be chosen; the picker offers those
and refuses anything else.

## Fields

| Field         | Required | Notes                                 |
| ------------- | -------- | ------------------------------------- |
| Goal name     | yes      |                                       |
| Target amount | yes      |                                       |
| Tracking      | yes      | Manual, or linked to an account       |
| Already saved | no       | Manual mode only, the starting figure |
| Deadline      | no       | Behind **+ Add a deadline**           |

## Pace

A goal **with a deadline** shows the monthly amount needed to reach the
target on time, alongside the deadline and the months remaining.

On the instance these figures come from: €200.00 remaining against a
30 June 2027 deadline, 11 months out, gives **€18.80 / month**.

A goal without a deadline shows no pace, because there is nothing to divide
by.

## Status

Goals carry a status badge; **In progress** is the one shown while the
target has not been reached.

## Deleting

Removes the goal only. No account, balance or transaction is affected, and a
linked goal's account is untouched.

## Related

- [Net worth](./net-worth.md), where goals live and where a linked goal's
  account is maintained.
- [The dashboard](./dashboard.md), whose savings-goals card shows two.
