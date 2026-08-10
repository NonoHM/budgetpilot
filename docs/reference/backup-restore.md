# Backup and restore: contents, limits and checks

Checked against a running instance, not recalled. For the steps, see
[exporting and restoring your data](../using/backup-restore.md).

## The file

|                |                                       |
| -------------- | ------------------------------------- |
| Format         | JSON, `formatVersion: 1`              |
| Name           | `budgetpilot-backup-YYYY-MM-DD.json`  |
| Scope          | one account, the one that exported it |
| Upload ceiling | **20 MB**                             |

## What it contains

Nineteen top-level keys, read off a real export:

`formatVersion`, `exportedAt`, `userEmail`, `accounts`, `categories`,
`importBatches`, `transactions`, `monthlyBudgets`, `categoryRules`,
`categorizationRules`, `categoryNatureMappings`, `netWorthAccounts`,
`netWorthSnapshots`, `savingsGoals`, `bankConnections`,
`recurringStreamActions`, `tags`, `transactionTags`, `transactionSplits`.

## What it does not contain

| Absent                  | Consequence                                      |
| ----------------------- | ------------------------------------------------ |
| Your password           | a restore cannot move your credentials           |
| The two-factor secret   | two-factor stays as it is on the target account  |
| Recovery codes          | as above                                         |
| Sessions                | restoring signs nobody in or out                 |
| Raw imported statements | the app never stores them; only the run's record |
| Other accounts          | the export is per account, not per instance      |

Verified on a real export: `passwordHash`, `totp` and `session` appear
nowhere in the file.

`userEmail` is **informational**. Restoring a file whose `userEmail` names
somebody else succeeds — measured — because the target is always the account
performing the restore. It is a label recording where the file came from,
never a check on where it may go.

## What restoring does

A **full replacement**, inside one database transaction:

1. Every row belonging to the account is deleted, in dependency order.
2. Everything in the file is recreated, with fresh identifiers.

There is no merge mode and no undo. If any step fails, the transaction rolls
back and the account is left as it was.

Deleting in a fixed order rather than relying on cascades is deliberate:
`TransactionSplit` hangs off both `Transaction` and `Category`, and it
restricts on the category, so an order chosen by the engine fails on
PostgreSQL for any account that has ever split a transaction.

## What the validator checks

| Checked                                  | Not checked                                  |
| ---------------------------------------- | -------------------------------------------- |
| `formatVersion` is exactly 1             | that the file came from your instance        |
| Every required section is present        | that `userEmail` matches you                 |
| Field types and string lengths           | that identifiers are unique within a section |
| References resolve between sections      |                                              |
| **Each split's parts sum to its parent** |                                              |
| Part counts stay within bounds           |                                              |

The sum check is the one worth naming, because it is a money invariant
rather than a structural one. `replaceSplits` enforces it on the write path
the editor uses; a restore bulk-inserts and never reaches that service, so
the same rule is enforced again before anything is written. Without it a
hand-edited file could carry a part whose sign opposed its parent, and the
resulting rows would be indistinguishable from legitimate ones forever
after.

String bounds are 191 characters, MySQL's `varchar` default, on every
engine — so a value one engine could not store is refused everywhere rather
than reaching an insert on one.

**Duplicate identifiers within a section are not detected.** A section
carrying two entries with the same `id` creates both, and the last one wins
in the reference map, orphaning whatever the first produced. It needs a
hand-edited file, it affects only the account doing the restore, and the
validator and the writer resolve duplicates identically, so no invariant
breaks. Recorded because it is a known limit, not because it is reachable
by accident.

## Refusal messages

| Cause                     | Message                             |
| ------------------------- | ----------------------------------- |
| No file chosen            | _No file selected._                 |
| Over 20 MB                | _...file is too large..._           |
| Unreadable upload         | _...could not be read..._           |
| Not JSON                  | _Unsupported backup format._        |
| `formatVersion` is not 1  | _Unsupported backup format._        |
| Fails schema or integrity | _Invalid or corrupted backup file._ |

Each was produced on a running instance rather than read off the catalogue.

## Related

- [Running it day to day](../operations.md#backups), for backing up the
  whole instance: the database file or dump, and the secrets that are not in
  it.
- [Split transactions](./split-transactions.md), for the sum invariant the
  validator re-checks.
