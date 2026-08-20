# Rules: matching and limits

Checked against a running instance, not recalled. For the steps, see
[categorization rules](../using/rules.md).

## What ships

**157 predefined rules**, of which **16 use a regular expression**. They are
marked **Predefined** in the list and can be edited, deactivated or deleted
like any other. **Restore suggested rules** puts the set back.

## Matching

| Property        | Behaviour                                |
| --------------- | ---------------------------------------- |
| Where it looks  | The transaction's label                  |
| How it compares | Contains, not equals                     |
| Case            | Ignored                                  |
| Accents         | Ignored                                  |
| Regex           | Optional, per rule, via the **r** toggle |

Accent folding means `creme` matches `CRÈME`, and case folding means
`carrefour` matches `CARREFOUR MARKET`. Both were read off the page's own
description of itself and are what the shipped rules rely on: every one of
them stores its text in lower case.

## The table

| Column       | What it holds                                     |
| ------------ | ------------------------------------------------- |
| Name         | Yours, for reading. Nothing is matched against it |
| Matched text | The text or the pattern, with a **Regex** badge   |
| Category     | The category a match is moved to                  |
| Nature       | The nature a match is given, or **None**          |
| Status       | An **Active** switch                              |
| Actions      | Edit and Delete                                   |

The search field above the table filters by name, text or category.

## Preview

**Preview** reports how many transactions the rules match and lists them
with four columns: the truncated label, the **Current** category, the
**Target** category, and which rule matched.

**It counts matches, not changes.** A row whose Current and Target are the
same is matched by a rule that would move it where it already is, and
applying the rules would leave it untouched. So the headline count is an
upper bound on what will actually change.

## The manual-category exclusion

**A rule never overrides a category set by hand.** Measured rather than
quoted: a preview reporting **23** affected transactions dropped to **22**
as soon as one of them was given a manual category on the transactions
screen, and that transaction left the list. Clearing the manual category put
it back to 23.

This is what makes running the rules over your whole history safe.

## Related

- [The transactions screen](../using/transactions.md), where a manual
  category is set and where the same accent-insensitive matching is used for
  search.
- [Splitting a transaction](../using/split-transactions.md): a split
  transaction is left alone by rules, both when they run and in the preview
  count.
