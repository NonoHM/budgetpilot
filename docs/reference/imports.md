# Imports: counts, profiles and deletion

Checked against a running instance, not recalled. For the steps, see
[importing a statement](../using/imports.md).

## Accepted files

**CSV** and **XLSX**.

| Profile          | What it reads                                |
| ---------------- | -------------------------------------------- |
| Auto             | Detects one of the below from the header row |
| Banque Populaire | Their statement export                       |
| Revolut          | Their statement export                       |
| Home             | BudgetPilot's own CSV export                 |
| Generic          | A four-column file you shape yourself        |

The column layouts are in
[getting started](../getting-started.md#first-steps-in-the-app), which also
covers the two header shapes **Home** accepts, old and current.

## The four counts

| Count              | Meaning                                     |
| ------------------ | ------------------------------------------- |
| Rows read          | Lines found in the file                     |
| Imported           | New transactions created                    |
| Duplicates skipped | Already present, so not created again       |
| Invalid rows       | Refused. The rest of the file still imports |

`rows read = imported + duplicates skipped + invalid rows`.

**Total spending** and **total income** on the summary cover the **imported**
rows only, so a run that skipped everything reports zero for both.

## Duplicate detection

Per **transaction**, not per file. Importing the same statement twice creates
nothing the second time, and importing an overlapping statement creates only
the rows that are new. Verified: the same five-row file imported twice
reported 5 read / 5 imported / 0 duplicates, then 5 read / 0 imported /
5 duplicates.

## Destination account

Optional, and applied only on the **very first** import of a given bank
profile. Once a technical account exists for that profile, a later choice is
ignored. The form states this above the field.

## The history

Newest first. Columns: date, file, profile, period covered, and the four
counts, plus **View** and **Delete**.

**Raw file contents are not stored.** The record of the run is kept; the
statement is not.

**View** opens `/transactions?importBatch=<id>`, the list filtered to that
run.

## Deleting an import

Deletes the transactions that run created, and only those. The confirmation
states the count first and says the action is irreversible.

Transactions from other runs and transactions entered by hand are not
touched. Edits made to an imported transaction go with it, since the
transaction itself is removed.

## Related

- [The transactions screen](../using/transactions.md), where an imported
  transaction is edited, categorised or split.
- [Categorization rules](./rules.md), which run on import so a file arrives
  already sorted.
