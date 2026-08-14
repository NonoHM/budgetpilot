# Imports: counts, profiles and deletion

Checked against a running instance, not recalled. For the steps, see
[importing a statement](../using/imports.md).

## Accepted files

**CSV** and **XLSX**.

**The format is detected, not chosen.** There is no profile selector: the
header row decides, on every import, and these are the shapes it recognises.

| Format           | What it reads                                   |
| ---------------- | ----------------------------------------------- |
| Banque Populaire | Their statement export                          |
| Revolut          | Their statement export, French or English       |
| Home             | BudgetPilot's own CSV export                    |
| Generic          | Any file carrying a date, a label and an amount |

Generic is the fallback, so a file that matches none of the three named
formats is read as Generic rather than refused for not being one of them.

The column layouts are in
[getting started](../getting-started.md#first-steps-in-the-app), which also
covers the two header shapes **Home** accepts, old and current.

## What Generic recognises

Generic needs three columns: a **date**, a **label** and an **amount**. It
finds them by name, so the file does not have to use BudgetPilot's own
spelling. A **category** column is used when present and is optional.

| Role   | Column names recognised                                            |
| ------ | ------------------------------------------------------------------ |
| Date   | `date`, `dateOp`, `Started Date`, `Booking Date`, `Date operation` |
| Label  | `label`, `libelle`, `Description`, `Partner Name`                  |
| Amount | `amount`, `montant`, `Amount (EUR)`                                |

Case and surrounding spaces do not matter.

**Any column it does not recognise is ignored**, and the rest of the file
imports. Ignoring is not the same as understanding: the column's values are
not read, not stored, and not shown. Giving those columns a meaning is what
the column mapping screen will do.

### Currency

BudgetPilot holds **euros**. Every amount is stored and displayed in euros, and
there is no conversion anywhere.

If your file has a **`currency`** or **`devise`** column, it is read, and any row
declaring something other than `EUR` is refused, naming the currency it found. A
row left blank in that column is treated as no declaration and imports normally.

**If your file has no such column, the amounts are assumed to be euros.** That
assumption is not checked, because there is nothing in the file to check it
against. So a statement in another currency that does not name it will import,
and its amounts will be shown with a euro sign. This is the one case the
application cannot detect, and it is worth knowing if your bank is outside the
euro area.

The **Banque Populaire** and **Home** formats carry no currency column at all, by
construction, so files read through them are always assumed to be in euros.

### When Generic refuses

**A column it needs is missing.** If no column matches the date, label or
amount role, there is nothing to build a transaction from.

**Two columns claim the same role.** A file carrying both `Date` and `dateOp`
is refused, naming both, rather than one being chosen for you.

This is the honest side of a trade, and it costs something real: **a file with
two date-ish columns refuses where a guess would have imported it.** The guess
is what we are refusing to make. Which of two date columns your transaction
should be dated by is a question about your bank's file, not one this
application can answer by looking at the names, and getting it wrong dates
your money to the wrong day silently. When the column mapping screen lands,
this is exactly the moment it will ask you to pick.

A statement whose date column reads `08/01/2026` is a related problem this
does not solve. BudgetPilot reads dates as day/month, so a file written
month/day would import on the wrong date rather than refuse. Column names
cannot express which order a file uses, so files in that order are not
recognised for now.

## What Revolut accepts

The ten column export, with the columns named in **either French or English**, in
any order. A statement downloaded from an English locale account reads
`Started Date`, `Description`, `Amount`, `Currency`, `State`; a French one reads
`Date de début`, `Description`, `Montant`, `Devise`, `État`. Both import.

A row is imported only when its **State** reads `TERMINÉ` or `COMPLETED`. A
pending or reverted row is refused, and the refusal names the state it found.

### Revolut rows this still refuses

**Anything not in euros.** BudgetPilot is a euro application, so a row whose
Currency is GBP, USD or anything else is refused one row at a time. **A Revolut
account in the UK or Ireland will get past the header and then have every row
refused on the currency.** That is a decision about the whole application rather
than about this profile, and it has not been taken.

Generic now refuses the same way for the same reason, so a file that names its
currency gets the same answer whichever format it arrives in.

**Revolut's nine column export.** A semicolon separated variant with separate
debit and credit columns exists in some regions. It is a different format rather
than a reordering, and reading it needs a rule about which column is negative.

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
