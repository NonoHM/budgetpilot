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

Case, surrounding spaces, and accents do not matter: `Libellé`, `libelle`, and
`LIBELLE` all fill the label role.

If **two** columns claim the same role, the file is refused and the message
names both. BudgetPilot does not pick one, because picking silently decides
which column holds your money.

### Accepted date formats

| Written as   | Example      | Read as    |
| ------------ | ------------ | ---------- |
| `YYYY-MM-DD` | `2026-01-15` | 15 January |
| `DD/MM/YYYY` | `15/01/2026` | 15 January |
| `DD.MM.YYYY` | `15.01.2026` | 15 January |
| `DD-MM-YYYY` | `15-01-2026` | 15 January |

**The day always comes first**, never the month. A file written `MM/DD/YYYY`
imports on the wrong date rather than being refused, because nothing in the
file says which convention it uses. This is the one case designating columns
cannot repair: convert those dates before importing.

A time after the date is ignored, so `2026-01-15 10:30:00` reads as 15 January.

Anything else is refused per row, and the message shows the value it read
beside the forms it accepts.

**Any column it does not recognise is ignored**, and the rest of the file
imports. Ignoring is not the same as understanding: the column's values are
not read, not stored, and not shown. Giving those columns a meaning is what
the [column designation screen](../using/imports.md#2-it-is-not-recognised-so-you-are-asked-which-column-is-which)
does: it asks you which column holds the date, the label and the amount, and
remembers the answer for the next file with the same columns.

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
amount role, there is nothing to build a transaction from. The refusal is
`missing-required-column`, named once per role it could not find, and it is
**the one refusal that comes with an offer rather than a full stop**: the
summary proposes designating the columns yourself, and the
[designation screen](../using/imports.md#2-it-is-not-recognised-so-you-are-asked-which-column-is-which)
shows each of your file's columns with its first three real values so you can
say which is which. Answer it once and the answer is remembered for every later
file with the same columns.

The refusal still stands on its own for a reader arriving from the invalid rows
table, which is why it is listed here rather than replaced by the offer.

**Two columns claim the same role.** A file carrying both `Date` and `dateOp`
is refused, naming both, rather than one being chosen for you.

This is the honest side of a trade, and it costs something real: **a file with
two date-ish columns refuses where a guess would have imported it.** The guess
is what we are refusing to make. Which of two date columns your transaction
should be dated by is a question about your bank's file, not one this
application can answer by looking at the names, and getting it wrong dates
your money to the wrong day silently. This is exactly the moment the
[column designation screen](../using/imports.md#2-it-is-not-recognised-so-you-are-asked-which-column-is-which)
asks you to pick, showing each candidate column with its first three real
values so the choice is made against the data rather than against the names.

**The file declares more columns than we will render.** A file may carry up to **512**
columns. That is far more than any bank or accounting package emits: a bank statement
carries around fifteen, an accounting export around forty.

The limit is not there because a wide file is slow to read. It is not: the widest file
the size limit allows takes about 37 milliseconds to parse. It is there because of the
screen that lets you say which column is which, which draws one card per column and
shows three real values in each. Without a limit, a single small file could ask that
screen for tens of thousands of cards.

An operator running their own instance can change it with the `CSV_MAX_COLUMNS`
environment variable, up to a hard maximum of 4096. A value above that is refused at
startup rather than quietly reduced, so the limit you set is the limit that runs.

**The amounts have no sign and a separate column says debit or credit.** Some
banks write every amount as a positive number and put the direction in its own
column, so a statement reads `24,90` with a `D` beside it. BudgetPilot takes the
direction from the sign of the amount, so a file like that would import as pure
income: your spending would read zero. It is refused instead, naming the column
that holds the direction.

The check is deliberately narrow, and here is exactly when it applies: every
amount in the file is positive or zero, another column's values are all drawn
from a short list of direction markers (`D`, `C`, `DB`, `CR`, `DR`, `debit`,
`credit`, `W`), and that column carries at least two different markers. A file
that signs its own amounts is never affected, even when it also carries such a
column: the sign wins. A column that reads `D` on every row is a constant rather
than a direction, so it changes nothing either.

What this cannot see, stated plainly: a file whose amounts are all positive with
no direction column at all is indistinguishable from a genuine income-only
statement, and it imports as one. So does a file whose direction column uses
words this list does not carry. There is nothing in the file to tell those apart,
and widening the list to guess would start refusing statements that import
correctly today.

The [column designation screen](../using/imports.md#2-it-is-not-recognised-so-you-are-asked-which-column-is-which)
closes the naming half of this, by asking rather than guessing. **It does not
close the sign half.** The role set is closed at four (date, label, amount,
category) and none of them carries a direction, so a statement whose amounts are
magnitudes beside a separate debit/credit column is refused before the screen
opens rather than designated through it. That is #320's decision and it stands.

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

| Count              | Meaning                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Rows read          | Data rows found in the file. Excludes the header line and any bank footer the app skipped |
| Imported           | New transactions created                                                                  |
| Duplicates skipped | Already present, so not created again                                                     |
| Invalid rows       | Rows refused, at most one refusal per row                                                 |

**The identity is conditional, and the condition is the interesting half:**

`rows read = imported + duplicates skipped + invalid rows`, **when the rows were
read at all**.

A refusal about the FILE or its HEADER is not a row and is not counted as one.
A missing required column, a header appearing twice, a file over the row or
column cap: in each case the rows are counted, because the file has them, and
none of them is classified, because the parser never examined one. The summary
states those refusals in words above the figures, so a reader is never handed
four boxes that look like an equation and are not.

This is why the summary does not tile the rows read beside the other three. The
identity above is real and worth relying on inside the parser, and it is not a
property of the screen.

**Total spending** and **total income** on the summary cover the **imported**
rows only, so a run that skipped everything reports zero for both.

## Duplicate detection

Per **transaction**, not per file. The comparison is over the transaction's
**date, label, amount and direction**, over **which account it was filed
into**, over the **currency** the amount is in, and over an ordinal that
separates genuine repeats of the same payment on the same day. Importing the
same statement twice creates nothing the second time, and importing an
overlapping statement creates only the rows that are new. Verified: the same
five-row file imported twice reported 5 read / 5 imported / 0 duplicates, then
5 read / 0 imported / 5 duplicates.

**Two transactions filed into different accounts are never compared**, and
that is deliberate: the same payment can genuinely appear in two accounts, and
treating those as one would drop a real transaction with nothing to report it.
That is why the account a statement belongs to is a question you answer rather
than something the application decides for you: it is the perimeter the
comparison runs inside.

It has one consequence worth knowing, because the CSV export is read back as a
**Home** file, and a Home file is filed into your CSV account: re-importing an
export of transactions that arrived through **Banque Populaire** or **Revolut**
creates a second copy of each. The export names the account its rows came from,
in a `compte` column, but the import does not yet read that column back, so the
copies land in a different account and the comparison correctly says they are
different transactions. The check described below fires on exactly that run and
asks you to confirm before anything is written. Use **Settings, Backup** rather
than the CSV export when what you want is a copy you can restore.

**The label is a column you designate, so changing which column feeds it
changes every comparison.** Re-reading a statement through a different label
column, or a different date column, produces rows this check treats as new,
and it would import the whole statement a second time. That is checked
separately, before anything is written: a run whose period, transaction count
and both totals match an earlier import, while not one of its lines is
recognised, is refused until confirmed. The check does not fire when any line
IS recognised, because the per-transaction comparison already handles that
run.

Not covered: a re-reading that also changes **which rows are valid**, since
the transaction count then differs and the two runs no longer match. The
**Imports** page carries a retroactive version of the same comparison for
imports made before this check existed.

**The file's name does not matter.** Downloading your statement a second time,
so it lands as `releve (1).csv`, and importing that changes nothing: it is the
same statement and it is recognised as such. Two transactions that are
genuinely distinct still both import, even when they share a date, a label and
an amount, as long as something else about them differs.

## The account a statement belongs to

Every import goes into an **account**, and every account is one you can see and
rename under **Settings, Accounts**. Duplicate detection runs inside one account
at a time, so two statements from two accounts at the same bank are no longer
read as repeats of each other.

There is no destination field on the upload form. A file BudgetPilot recognises
is filed by its format. A file it does not recognise is filed into the account
you pick on the designation screen, in a row above the four column rows.

### How the account is worked out

Three sources of an answer, in this order. The first that answers, wins.

| Rank | What it reads                               | What the screen does                  |
| ---- | ------------------------------------------- | ------------------------------------- |
| 1    | An account identifier in the file itself    | States the account, with the fragment |
| 2    | The `compte` column of a BudgetPilot export | Not read back yet                     |
| 3    | What was remembered for this file's shape   | Proposes one, or asks between several |

**The file always beats the memory.** A memory records what happened last time,
including the time the wrong account was picked. An identifier printed in the
file is a fact about the file. So rank 1 answers before the memory is consulted.

**Rank 1 needs proof, not a resemblance.** The identifier has to be an IBAN
whose checksum verifies, or a run of eight digits or more, in a column where
every row carries the same value. Only the last four characters are kept, and
only those are ever shown or stored.

**A file naming several accounts is refused before the memory is read at all.**
A statement that mixes two accounts cannot belong to one, and a memory saying it
does must not be allowed to override the file.

**Rank 3 fills in nothing when two accounts match.** Both are offered and
neither is chosen. A guess that is right most of the time still misfiles
statements, and leaves no trace that a guess was made.

### What is remembered

The account a file shape went into, keyed on the file's **column names** in
sorted order. A bank that **reorders** its columns changes nothing, because the
names are sorted before they are hashed.

A bank that **adds or removes** a column does change it: the set of names is
different, so the digest is different and the shape reads as one never seen
before. You are asked once more, and the new shape is remembered beside the
old one.

Two situations are told apart on screen: a shape never seen before says so, and
a shape whose accounts have all since been deleted or archived says the
remembered account no longer exists.

### Creating an account during an import

The picker offers **New account** in every state, including when you have
none. It opens a one-field sheet, pre-filled from what the file said: the
bank's name when the format is recognised, plus the identifier fragment when
the file carries one.

The name is yours and appears only in BudgetPilot. Two accounts may not share a
name, and **two accounts may not share an identifier fragment**. Without that
second rule rank 1 would find two accounts holding one fragment and would have
to guess, which is the one thing it exists not to do.

Nothing else about the account is settable from that sheet. The format, the
identifier fragment, the net worth link and the archived flag are set by the
application or from **Settings, Accounts**. A request that posts them anyway
sets nothing, because the endpoint reads the one field the form owns and never
looks at the rest of the body.

### Refusals

| Situation                                            | What you get                                 |
| ---------------------------------------------------- | -------------------------------------------- |
| The primary pressed with no account chosen           | The row is revealed, scrolled to and focused |
| A recognised file, and two accounts share its format | Refused. See the note below                  |
| The chosen account has since been archived           | Refused, choose another                      |
| The file names several accounts                      | Choose the one this statement belongs to     |

**The refusal for two accounts of one format has no control beside it yet.**
Its sentence asks you to designate the columns, and the designation screen is
not offered on that path, because a recognised file never reaches it. Until that
is fixed, the way through is to archive the account the statement is not from,
import it, and reactivate the other.

An account reference posted by a browser is treated as a claim rather than a
fact: it is resolved against your own accounts, and one that does not resolve
is refused as not found, whether it belongs to nobody or to somebody else.

### Archiving

Archiving an account stops it being offered as an import destination and keeps
every transaction it already holds. It can be reactivated from the same place.
An archived account still counts against the two name rules above, so its name
and its fragment are not free for reuse until it is deleted.

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
