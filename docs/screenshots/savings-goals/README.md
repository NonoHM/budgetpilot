# Savings goal screenshots

Captured with:

```bash
BASE_URL=http://localhost:4175 node scripts/doc-screenshots.mjs savings-goals
```

## The arrangement they need

**One goal of each tracking mode**, because the two show different things
and a single goal can only ever show one of them:

| Goal           | Target    | Tracking                        | Deadline     |
| -------------- | --------- | ------------------------------- | ------------ |
| Japan trip     | 10,000.00 | Manual, 5,800.00 already put by | none         |
| Emergency fund | 6,000.00  | Linked to the Savings account   | 30 June 2027 |

`Japan trip` is seeded by `scripts/demo-screenshots.mjs`. `Emergency fund`
is created by hand, through the dialog, since it needs an account to link to
and a deadline.

The pair is what lets the images show the contrast the reference describes:
the manual goal's detail says it has no history, and the linked one draws
the account's. Only the goal with a deadline shows a pace.

## Language

English, with the browser locale pinned as well as the app's. That matters
more here than elsewhere: the deadline field is a native date input, so a
capture taken from a French browser renders its placeholder as `jj/mm/aaaa`
in the middle of an English dialog. See
[the screenshots README](../README.md).
