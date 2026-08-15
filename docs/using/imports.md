# Importing a statement, and the import history

Every import is recorded, with what it did, and can be undone in one action.

## Import a file

**Imports > New import** takes a **CSV** or **XLSX** statement.

There are three ways a file gets read, and you only ever meet the first one
unless it fails.

### 1. It is recognised, and there is nothing to choose

BudgetPilot reads the file's header row and works out the format itself. It
recognises **Banque Populaire**, **Revolut**, **Home** (its own export) and a
**Generic** shape covering any file whose date, label and amount columns are
named something it already knows.

The column layouts each one expects are in
[getting started](../getting-started.md#first-steps-in-the-app), and what
Generic and Revolut accept, and still refuse, is in
[the imports reference](../reference/imports.md).

### 2. It is not recognised, so you are asked which column is which

Banks name their columns however they like, and no list covers all of them. When
none of the four shapes fits, the import is not refused: the summary says the
columns were not recognised and offers **Designate the columns**.

That screen shows four rows, one per role, and nothing else:

| Row          | What it wants                             |
| ------------ | ----------------------------------------- |
| **Date**     | the column holding the transaction's date |
| **Label**    | what the transaction says it was          |
| **Amount**   | the sum, with its sign                    |
| **Category** | optional, if your bank provides one       |

Tap a row and you get your own file, one card per column, each showing the
column's name and its **first three real values**. You are choosing from the
data in front of you rather than from a list of names.

**Columns you do not designate are ignored**, and that is the normal outcome. A
fifteen-column statement usually needs three of them; the screen says how many
it will ignore before you import.

Three columns are enough. **Category is optional**, and leaving it empty means
the transactions arrive uncategorised, where [categorization
rules](./rules.md) can still pick them up.

### 3. It is remembered, so you are only asked once

Once you have designated a file's columns, BudgetPilot remembers the answer
against that file's **column names**, not its name or its date. The next
statement from the same bank imports straight through without asking.

Because it is keyed on the column names, a bank that adds a column, or reorders
them, changes nothing. If a bank **renames** one, that row alone comes back to
be redesignated and the others keep their answers.

Memorisation is on by default, stated on the screen, with a link to decline it
for a file you do not expect to see again.

**Destination account** is optional, and the form says the one thing about
it that is easy to get wrong: it applies only to the **very first** import
of a given bank profile. Once a technical account exists for that profile,
the choice is ignored.

## What is refused

| The file                       | What you get                             |
| ------------------------------ | ---------------------------------------- |
| Not `.csv` or `.xlsx`          | _The file must use the .csv or .xlsx..._ |
| Larger than 256,000 bytes      | _Statement too large..._                 |
| An `.xlsx` unpacking past 8 MB | _This spreadsheet unpacks to..._         |
| Empty                          | _The statement file is empty._           |
| Fewer than three columns       | _This file has 2 columns..._             |

**A missing column is not in that table, on purpose.** If the file carries a
date, a label and an amount under names BudgetPilot does not know, you get
_Required column missing_ against each one it could not find, **and the offer to
designate them yourself**. That is a question, not a refusal, and it is
answered on the screen described above.

A file with fewer than three columns is the one case designating cannot repair:
there is nothing to point the three roles at.

The last one needs a word, because it is the only limit that is not about
the size of the file you picked. An `.xlsx` is a zip archive, so a small
file can hold a very large amount of data once opened, and the app measures
that before opening it rather than after. A statement exported from a
spreadsheet application reaches about 3 MB unpacked at the largest size the
upload limit allows, so the 8 MB ceiling is roughly twice what a real
statement needs. If a genuine export is ever refused by it, that is worth
[reporting](https://github.com/NonoHM/budgetpilot/issues), because the
number was chosen from a measurement and can be corrected by another. An
operator can also raise it, up to a point:
see [`IMPORT_XLSX_MAX_UNCOMPRESSED_MB`](../configuration.md#upload-size).

Splitting a long history into several files, a year at a time, works and
costs nothing: duplicate detection is per transaction, so overlapping
files cannot double anything.

## Read the summary

The import reports what it did before you go anywhere.

![An import summary: file name, generic profile, 5 rows read, 5 imported, 0 duplicates skipped, 0 invalid rows, total spending €95.00, total income €2,850.00, and the period covered](../screenshots/imports/summary-desktop.png)

| Figure                 | What it means                                       |
| ---------------------- | --------------------------------------------------- |
| **Rows read**          | Lines found in the file                             |
| **Imported**           | New transactions created                            |
| **Duplicates skipped** | Recognised as already present, so not created again |
| **Invalid rows**       | Refused; the rest of the file still imported        |

The four add up: rows read is imported plus duplicates plus invalid.

**Total spending** and **total income** cover what was actually imported, so
after an import that skipped everything they are both zero. That is the
quickest way to tell "nothing happened" from "nothing needed to happen".

## Importing the same file twice is safe

Duplicate detection is per transaction, not per file, so overlapping
statements do not double your history.

![Import history: two runs of the same file, the first importing 5 transactions, the second reading the same 5 and skipping all of them as duplicates](../screenshots/imports/history-desktop.png)

The two rows above are the same file imported twice. The second read the
same five lines, created nothing, and recorded five duplicates.

## The history

**Imports** lists every run, newest first, with its date, file name,
detected profile, the period the file covered, and the four counts.

Raw file contents are **not stored**. What is kept is the record of the run,
not your statement.

**View** opens the transactions list filtered to that import, which is how
you check what a run actually brought in.

## Undo an import

**Delete** on a row is an undo for the whole run.

![A confirmation reading "Cancel this import? This will delete the 5 transactions imported from this statement. This action is irreversible", offering Keep import and Delete import](../screenshots/imports/cancel-import-desktop.png)

It states how many transactions it is about to remove, and removes exactly
those: transactions you imported in other runs, or entered by hand, are
untouched. Anything you changed on an imported transaction goes with it, so
this is an undo of the import rather than a tidy-up.

## On a phone

![The import history on a phone](../screenshots/imports/history-mobile.png)

---

For the columns and what each count includes, see the
[imports reference](../reference/imports.md).
