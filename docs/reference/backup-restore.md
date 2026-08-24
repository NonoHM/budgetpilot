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

Twenty-one top-level keys:

`formatVersion`, `exportedAt`, `userEmail`, `accounts`, `categories`,
`importBatches`, `columnMappings`, `importSourceSignatures`, `transactions`,
`monthlyBudgets`, `categoryRules`, `categorizationRules`,
`categoryNatureMappings`, `netWorthAccounts`, `netWorthSnapshots`,
`savingsGoals`, `bankConnections`, `recurringStreamActions`, `tags`,
`transactionTags`, `transactionSplits`.

This list is checked against the export's own schema by a test, so it cannot
drift from what the file actually contains. It said nineteen for a while, and
was wrong by one.

## What it does not contain

| Absent                   | Consequence                                       |
| ------------------------ | ------------------------------------------------- |
| Your password            | a restore cannot move your credentials            |
| The two-factor secret    | two-factor stays as it is on the target account   |
| Recovery codes           | as above                                          |
| Sessions                 | restoring signs nobody in or out                  |
| Raw imported statements  | the app never stores them; only the run's record  |
| Other accounts           | the export is per account, not per instance       |
| Account number fragments | the last characters of an IBAN never leave the DB |

Verified on a real export: `passwordHash`, `totp` and `session` appear
nowhere in the file.

## Account number fragments, and the import memory

When a statement names the account it belongs to, the app keeps at most **four
characters from the end** of that IBAN or account number, so it can show you
`···4417` and recognise the same account next time. Four characters are not a
payment instrument, but among one holder's own accounts they are exactly the
attribute that tells them apart, so they are treated as a data class of their
own.

**They are not in the backup, and that follows from what the backup is.** The
file is plain JSON with no encryption of any kind: no cipher, no passphrase,
no key derivation. You download it, mail it to yourself, drop it in a cloud
folder. Anything written into it has left every control this application has,
which is why this one value stays in the database.

`importSourceSignatures` is the memory that says "a file with this column
layout belongs in that account". Only the entries learnt from a file that
carried **no** fragment are exported, and they come back attached to the
restored account. The entries that were told apart **by** a fragment are not in
the file and are gone after a restore.

So, after restoring:

| The account                    | What it does on its next statement  |
| ------------------------------ | ----------------------------------- |
| never had a fragment           | recognised as before, nothing to do |
| was recognised by its fragment | asks you once, then remembers again |

That second row is the price of the choice, and it is charged once per account
rather than once per import. Dropping the whole table would have been simpler
and would have charged it to every account instead, including those that never
had a fragment to lose.

`userEmail` is **informational**. Restoring a file whose `userEmail` names
somebody else succeeds, measured rather than assumed, because the target is
always the account
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
| **Currency codes and exponents**         | that a currency code is one that exists      |
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
engine, so a value one engine could not store is refused everywhere rather
than reaching an insert on one.

Currency codes are checked for **shape**, not for existence. A code must be
three uppercase letters, which is what ISO 4217 uses. `EUR` passes. `ZZZ`
passes too, because deciding whether a code is real would mean shipping and
maintaining a list of every currency in the world, and the app deliberately
does not.

The shape check is not cosmetic. The browser's own number formatter refuses
anything that is not three letters, and it refuses by raising an error rather
than by printing something odd. A code like `AB` or `<script>` stored on a row
would therefore break every screen that shows that row, and it would keep
breaking them, with no working screen left to fix it from. Refusing the file is
the only moment where that is cheap.

The exponent is the number of decimal places an amount has, and it is checked
against the range ISO 4217 actually uses, which is 0 to 4. It is bounded
because it is a multiplier: an exponent nobody checked would let a hand-edited
file restore amounts a hundred million times their real size.

**Duplicate identifiers within a section are not detected.** A section
carrying two entries with the same `id` creates both, and the last one wins
in the reference map, orphaning whatever the first produced. It needs a
hand-edited file, it affects only the account doing the restore, and the
validator and the writer resolve duplicates identically, so no invariant
breaks. Recorded because it is a known limit, not because it is reachable
by accident.

## Refusal messages

All eight, in the order the checks run. The order matters: each one bounds the
work the next is allowed to do, so a file is refused by the first thing wrong
with it and not necessarily by the worst.

| Cause                                      | Message                             |
| ------------------------------------------ | ----------------------------------- |
| No file chosen                             | _No file selected._                 |
| Over 20 MB                                 | _...file is too large..._           |
| Unreadable upload                          | _...could not be read..._           |
| More separate entries than the node limit  | _...too many separate entries..._   |
| Not JSON                                   | _The file is not valid JSON._       |
| Not an object, or `formatVersion` is not 1 | _Unsupported backup format._        |
| Fails schema or integrity                  | _Invalid or corrupted backup file._ |
| Two categories with the same name          | _...contains a duplicate category._ |

**Damaged and unsupported are deliberately different messages**, and the
distinction is worth knowing when you read one. _The file is not valid JSON_
means the file is truncated or corrupted, so re-export it. _Unsupported backup
format_ means the file is intact but came from a version this one does not
accept, so the thing to go looking for is which version wrote it.

The entry-count check runs **before** the file is parsed, which is why it can
refuse a file that would otherwise be rejected a moment later for not being a
backup at all: parsing is what the check exists to bound.

## Related

- [Running it day to day](../operations.md#backups), for backing up the
  whole instance: the database file or dump, and the secrets that are not in
  it.
- [Split transactions](./split-transactions.md), for the sum invariant the
  validator re-checks.
