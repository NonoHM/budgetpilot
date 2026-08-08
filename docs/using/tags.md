# Tags

Categories answer "what kind of spending is this". Tags answer everything
else: which trip, which project, which person owes you half. A
transaction has exactly one category and any number of tags, so the two
never fight over the same row.

Tags change nothing about your budgets or your totals. They are a way to
find things again.

Labels below are the English ones. If you read the app in French you will
see the French wording in the same places.

## Create a tag

There is no "new tag" button, and that is on purpose: a tag with nothing
in it is not useful. You create one by putting it on a transaction.

1. Open **Transactions** and click a transaction.
2. In the detail panel, find the **Tags** section.
3. Type the name. If it does not exist yet you get **Create "..."** in
   the list. Pick it.
4. **Save**.

The colour is chosen for you from the name, so creating a tag stays one
decision instead of two. You can change it later in Settings.

Typing a name that already exists, in any capitalisation or with
different accents, gives you the existing tag rather than a second one.
"Portugal" and "portugal" are the same tag.

## Put an existing tag on a transaction

Same place. Open the transaction, start typing in the Tags field, pick
from the list, save. The list filters as you type.

To take a tag off, click the × on its chip, then save.

## Tag many transactions at once

This is the fastest way to label a trip or a project after the fact.

1. On **Transactions**, filter down to what you want to tag. Search text,
   a date range, a category, anything. The bulk action works on the
   results of the current filter, so this step is the whole safety net.
2. The button under the filter bar becomes **Tag the N results**.
3. Click it, type or pick the tag, confirm.

A banner tells you what happened and offers **Undo** for the whole
operation.

The button stays disabled with an explanation until it can do something:

| It says                               | Meaning                                         |
| ------------------------------------- | ----------------------------------------------- |
| No result to tag                      | The filter matches nothing                      |
| Correct the filter to tag the results | The date range or the search pattern is invalid |
| Create a tag from a transaction       | You have no tags yet                            |

Applying the same tag twice does not duplicate it, so it is safe to
repeat a bulk action on overlapping filters.

### If the filter matches too many

One bulk action tags at most **250** transactions. Past that the app
refuses and tells you the count, rather than tagging some of them and
stopping.

It also offers a way out when one exists: if your filter is mixed
income and expenses, it will tell you that expenses alone would bring it
under the limit, and lets you apply that narrower version in one click.
Otherwise narrow it yourself, usually by date range, and repeat.

### If some transactions are full

A transaction carries at most **10** tags. If some of your results are
already at ten, the app says how many and refuses the whole operation
rather than tagging part of it. Remove a tag from those, or narrow the
filter.

## Filter by tag

The **Tag** filter sits in the filter bar on Transactions. Pick one to
see only its transactions.

The list shows how many transactions each tag has **within the filters
you already have set**, not overall. Filter to March and the counts tell
you how much of March each tag covers, which is usually the question you
were about to ask.

## Rename, recolour, delete

Go to **Settings**, Tags section. There is also a **Manage in Settings**
link at the bottom of the tag picker.

- **Rename** keeps every transaction attached. It is the same tag with a
  different name.
- **Recolour** offers nine palette colours, all readable on the app's
  background.
- **Delete** removes the tag from every transaction that has it. The
  confirmation tells you how many. This cannot be undone.

## Tags disappear when they are empty

Take the last transaction off a tag and the tag is deleted. No message,
no confirmation, nothing in a bin.

This is deliberate. A tag with no transactions carries no information,
and leaving one behind means typing the same name later collides with a
leftover instead of creating a clean tag. If you remove a tag from your
only Portugal transaction, "Portugal" is gone; typing it again on another
transaction creates it again, colour and all.

The one thing to know: this also means an accidental untag of the last
transaction loses the tag's colour choice if you had customised it.

## Limits

| Rule                                 | Value                 |
| ------------------------------------ | --------------------- |
| Tag name                             | 1 to 60 characters    |
| Tags per transaction                 | 10                    |
| Transactions per bulk action         | 250                   |
| Same name, different case or accents | the same tag          |
| Tag with no transactions             | deleted automatically |

Names are cleaned up as you type them: runs of spaces collapse to one,
and invisible characters are stripped. This stops two tags existing whose
difference nobody can see on screen.

## Tags and your data

Tags are yours and stay local, like everything else. They are included in
backups and restored with them.

They are **not** included in the CSV export, which is a transaction
export and has no column for them. They are also never sent to the
optional local AI model, whatever the model is allowed to see. See
[local AI advice](../ai-insights.md).
