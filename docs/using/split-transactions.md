# Splitting a transaction across categories

One payment, several categories. An 80,00 € trip to the DIY shop that was
50,00 € of paint and 30,00 € of garden soil is one line on your bank
statement and two things in your budget. Splitting it lets both be true.

Nothing else in the app changes shape. The transaction stays one
transaction: one date, one label, one amount, one row in the list. Only
the answer to "which category did this money go to" changes, and it goes
from one answer to several.

Labels below are the English ones. If you read the app in French you will
see the French wording in the same places.

## Split a transaction

1. Open **Transactions** and click the transaction. The detail panel
   opens on the right, or as a sheet from the bottom on a phone.
2. Under the category selector, click **Split across several categories**.
3. Two empty parts appear. Fill in a category and an amount for each.
4. Add more parts with **Add a part** if you need them.
5. **Save**.

The row in the list now shows the category that took the most money,
with a small badge beside it. On a computer you can hover or focus that
badge to see every part.

### The remainder has to reach zero

Above the Save button there is a line that always tells you where you
are:

| It says              | It means                                                                        |
| -------------------- | ------------------------------------------------------------------------------- |
| **Left to allocate** | The parts do not add up to the transaction yet. Save is unavailable.            |
| **Fully allocated**  | The parts add up exactly. Save is available.                                    |
| **Over-allocated**   | The parts add up to more than the transaction. It tells you how much to remove. |

This is the whole rule of splitting: the parts add up to the
transaction, exactly, to the cent. It is not a preference, it is what
makes your totals keep adding up everywhere else in the app.

### Split evenly

**Split evenly** divides the amount across the parts you have. If it does
not divide cleanly, the first parts get the extra cent, and the app marks
which part that is so you can see it rather than wonder about it. Three
parts out of 10,00 € gives 3,34 € then 3,33 € then 3,33 €.

You can still edit any amount afterwards.

### Notes on a part

Each part has an optional **Note**, up to 80 characters. Use it for
things like "Marie's half" or the reference on a receipt.

Notes are private to that part. They are never searched, never filtered
on, never sent anywhere, and they are not included in the CSV export.

## Change or remove a split

Open the transaction again and the parts are there, ready to edit. Change
an amount, change a category, add a part, remove a part with the × beside
it. Save applies all of it at once.

To go back to a single category, click **Remove the split**. Nothing
happens straight away: the panel says the split will be removed when you
save, and there is an **Undo the removal** next to it in case you clicked
by accident. Save actually removes it.

Removing a split loses nothing. The transaction goes back to the category
it had before you split it, which the app kept the whole time. That is
why the category selector is locked while a transaction is split, and it
says so in place: **Each part carries its own category. Remove the split
to choose a single one.**

## Limits

| Rule                                                 | Value                |
| ---------------------------------------------------- | -------------------- |
| Fewest parts                                         | 2                    |
| Most parts                                           | 20                   |
| Note length                                          | 80 characters        |
| Parts add up to the transaction                      | exactly, to the cent |
| A part can be the same category as another part      | yes                  |
| A part can be uncategorized                          | no                   |
| A part can point the opposite way to the transaction | no                   |

A one-part split is a category with extra steps, which is why the floor
is two. If you find yourself wanting one, you want to change the
category instead.

## What changes elsewhere once a transaction is split

This is the part worth reading once, because it is what makes splitting
useful rather than decorative.

- **Budgets, reports and the dashboard count the parts**, not the
  transaction. Split 80,00 € into 50,00 € Home and 30,00 € Garden and
  your Home budget sees 50,00 €, not 80,00 € and not nothing.
- **Your totals do not change.** The parts add up to the transaction, so
  every overall figure is exactly what it was before you split anything.
  Splitting moves money between categories, it never creates or destroys
  any.
- **The list shows the biggest part's category** in the Category column,
  with a badge saying how many other categories are involved. `+2` means
  two other categories besides the one shown. `×3` means three parts that
  are all in the same category.
- **Filtering by category finds it, and the row changes to match.** Filter
  on Garden and the transaction appears, even though its own category is
  Home. The row itself now shows Garden and 30,00 €, the part the filter
  found, with the full 80,00 € underneath it as "of 80,00 €" so you can
  still see what the whole payment was. The total at the top of the list
  counts the same 30,00 €, never the whole 80,00 €, and the two always
  agree: what the rows add up to is what the total says.
- **It leaves the "to classify" pile.** A split transaction is fully
  categorized by definition, so it stops appearing in the classify flow.
- **Categorization rules leave it alone.** A rule that would have moved
  it to another category skips it. You decided where this money went, and
  a rule does not get to overrule that.
- **Nature is resolved per part.** If one part is in a category you
  mapped to Transfer and another to Spending, the transaction counts as
  both, for the amounts concerned.

## Splits in the CSV export

The export writes **one line per category the money went to**. A
transaction split three ways is three lines in the file, so the per
category totals in your spreadsheet match the ones in the app.

Three extra columns keep those lines readable and re-importable:

| Column             | What it holds                                                      |
| ------------------ | ------------------------------------------------------------------ |
| `montant_total`    | The transaction's full amount, repeated on every line of the group |
| `part`             | `1/3`, `2/3`, `3/3`. Which part this is, and how many there are    |
| `categorie_parent` | The category the transaction returns to if the split is removed    |

Importing that file back gives you one transaction with its parts again,
not three separate transactions. See
[importing and exporting](../getting-started.md#first-steps-in-the-app)
for the import side.

Two things the round trip does not do:

- **Part notes are not in the file.** Everything else survives: the
  categories, the amounts, their order, and the category the transaction
  falls back to.
- **Re-importing an export into the same instance adds nothing.** Every
  line is recognised as something you already have and reported as a
  duplicate. This is on purpose. To move data to another instance, export
  from this one and import into that one.

### Exporting with a category filter active

Download the CSV while a category filter is set and the file matches what
the screen showed you: only the parts that went to that category, not
every part of every répartition the filter pulled in. The `part` column
still states the true number of parts the transaction actually has, so a
répartition you only partly exported reads as incomplete, for example
`2/3` with no `1/3` or `3/3` beside it in the file.

That is deliberate. A filtered export is a view of what you were looking
at, not a backup of your data, so importing it back is refused with a
clear reason rather than silently recreating a smaller, wrong
répartition. To get a file that always imports cleanly, export without a
category filter.

## When something is refused

### Save is greyed out

The panel always says why, right there, and it is one of these:

| The reason line says                              | Do this                                                  |
| ------------------------------------------------- | -------------------------------------------------------- |
| Save becomes available when the remainder is zero | Adjust an amount until **Fully allocated**               |
| The parts exceed {total}. Remove {amount}         | Lower a part by that amount, or remove a part            |
| Change the split to save                          | Nothing has changed since you opened it                  |
| Choose a category for every part                  | One part still has no category                           |
| Choose a category for part {n}                    | That part's category was deleted while you had this open |

### "A split has at least 2 parts"

You tried to remove the second-to-last part. Use **Remove the split**
instead, which is the explicit way back to a single category.

### "20 parts is the maximum"

Twenty is well past any real receipt. If you genuinely need more, the
transaction is probably several transactions.

### "The parts must add up to exactly the transaction amount"

You will normally see the remainder line long before this. It appears if
the transaction's amount changed underneath you, for example because
another window edited it while this panel was open. Reopen the
transaction and the parts are as you left them.

### "This category carries N split parts"

You tried to delete a category that parts still point at, on the
**Categories** page. Deleting it would leave that money nowhere, so the
app refuses and offers a link to the transactions concerned. Change those
parts to another category first, or remove those splits, then delete.

Renaming a category is different and always allowed. Parts follow the
rename, because a renamed category is still the same category.

### "The split could not be saved. Your parts are kept."

Something went wrong on the server. Nothing was written, and the parts
you typed are still on screen, so **Try again** is safe. If it keeps
happening, see [troubleshooting](../troubleshooting.md).

## Finding your split transactions

Once you have at least one split, a **Split** filter appears in the
filter bar on Transactions, with three choices: All, Split, Not split. It
is not there before that, on purpose: a filter for something you have
never used is noise.

Combine it with a category filter to answer questions like "which split
transactions touched Groceries".
