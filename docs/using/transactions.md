# The transactions screen

Everything you do with individual transactions happens here: finding
them, categorizing them, tagging them, splitting them, exporting them.
This page explains the tools on that screen. Tags and splits have their
own pages, linked below.

Labels below are the English ones. If you read the app in French you will
see the French wording in the same places.

## The list

25 transactions per page, newest first. Click any row to open its detail
panel, on the right on a computer, as a sheet from the bottom on a phone.

The Category column shows the transaction's category. If the transaction
is split it shows the category that took the most money, plus a badge.
See [splitting a transaction](./split-transactions.md).

## Search

The search box matches the **label** only, not amounts, not categories,
not notes.

**Contains** is the default and is forgiving: it ignores case and
accents, so `cafe` finds `Café Crème`. It matches anywhere in the label,
so `market` finds `CARREFOUR MARKET`.

**Regex** is the other mode, behind the toggle next to the box. It runs a
regular expression against the label, case-insensitive. Unlike Contains,
it does **not** ignore accents, so `cafe` will not find `Café`. Use it
for things Contains cannot express:

| Pattern             | Finds                        |
| ------------------- | ---------------------------- |
| `^SNCF`             | Labels starting with SNCF    |
| `AUCHAN\|CARREFOUR` | Either one                   |
| `[0-9]{4}$`         | Labels ending in four digits |

An invalid pattern is refused with a message rather than silently
matching nothing. A search is at most 120 characters in either mode.

## Filters

The filter bar sits under the search box. Each filter you set shows its
value on its own button, with a × to remove just that one.

| Filter       | What it does                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| **Type**     | All, Expenses, Income. A fourth, **To classify**, appears only while something is waiting for a category |
| **Category** | One category. Also matches transactions whose _part_ is in it, if they are split                         |
| **Period**   | A month, a preset range, or exact dates                                                                  |
| **Tag**      | One tag, with a count per tag inside the current filter                                                  |
| **Split**    | All, Split, Not split. Only appears once you have at least one split transaction                         |

Filters combine. Category Groceries plus Period March plus Tag Portugal
gives you the intersection.

The totals line above the list always describes **what you are currently
looking at**, not your whole history. When a category filter is active
and a transaction is split, the total counts the part that matched, not
the whole transaction, and the row itself changes to show that same part
with the transaction's full amount beneath it. That is deliberate, and
[why it works that way](../explanation/filtered-row-amounts.md) is worth
one read if it looks wrong to you.

### To classify

The **To classify** type is the pile of transactions with no category
yet. It is where you go to clean up after an import.

Split transactions never appear there. A split transaction has already
been given its categories, so it is not waiting for one.

## Editing a transaction

Open a transaction and the detail panel gives you:

- **Category**: pick one, or type a name that does not exist yet to
  create it. A category you set by hand is never overwritten later by an
  import or by a rule.
- **Nature**: how this money behaves. Actual spending, income, transfer,
  investment, refund, fees, or unclassified. Most of the time this follows
  the category and you can leave it alone. Setting it here overrides that
  for this transaction, and it keeps overriding it for every part if you
  later split it.
- **Tags**: see [tags](./tags.md).
- **Split across several categories**: see
  [splitting a transaction](./split-transactions.md), and the
  [rules and limits](../reference/split-transactions.md). It is not
  offered on a transaction that has no category yet, because a split needs
  a category to fall back to.

## Tagging many at once

Filter the list down first, then use **Tag the N results** under the
filter bar. The full flow, the limits and what to do when it refuses are
on the [tags](./tags.md) page.

## Export

The **Export** button downloads what you are currently looking at, as
CSV. Every active filter and the current search apply, so filter first if
you want a subset.

The file has one line per category the money went to. For an ordinary
transaction that is one line. For a split transaction it is one line per
part, so the per-category totals in your spreadsheet match the ones in
the app.

The columns:

| Column             | Holds                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| `date`             | `YYYY-MM-DD`                                                                       |
| `libelle`          | The label                                                                          |
| `categorie`        | The category this line's money went to                                             |
| `montant`          | This line's amount, negative for expenses                                          |
| `type`             | `income` or `expense`                                                              |
| `nature`           | `spending`, `income`, `transfer`, `investment`, `refund`, `fee` or `uncategorized` |
| `source_bancaire`  | Where the transaction came from                                                    |
| `montant_total`    | The whole transaction's amount                                                     |
| `part`             | `1/1` for an ordinary transaction, `1/2` and `2/2` for a split one                 |
| `categorie_parent` | The category the transaction falls back to                                         |

Amounts that start with a minus are prefixed with a single quote, so a
spreadsheet does not read them as a formula. The import understands that
and strips it back off.

This file re-imports into BudgetPilot as it left, including splits. Pick
the **Home** profile, or leave the import on Auto. Files exported by
older versions, with only the first seven columns, still import too.

Re-importing an export into the same instance adds nothing: every line is
recognised as a transaction you already have. That is what you want when
the point is a backup. To move data between instances, export from one
and import into the other.

Part notes are the one thing not in the file.

## Pages that are not here

- Rules that categorize automatically on import: **Rules**.
- Where money went over a period, with charts: **Reports**.
- What is due soon: **Upcoming bills**.
- Importing a file: **Imports**. See
  [getting started](../getting-started.md#first-steps-in-the-app).
