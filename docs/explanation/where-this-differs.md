# Where BudgetPilot differs from comparable tools

Three places where this project made a different choice from the tools it is
usually compared against, and what each choice cost or bought. This is not a
claim that BudgetPilot is better. Two of the three are narrow, and the third is
a consequence of being younger and smaller rather than of being cleverer.

It is here because a contributor deciding what to build next needs to know which
properties are load-bearing. Undoing one of these to simplify a diff would be
undoing a deliberate decision.

Every comparison below is taken from the other product's own published
documentation. Nothing here is a claim about how another product behaves on
screen, because none of them was run.

## 1. Totals under a category filter

**The property.** Filter the transaction list by a category and add up the
Amount column. The result reproduces the summary total, exactly, including when
some of the rows are split transactions.

That is not a free property. A split transaction has one amount at the bank and
several amounts across categories, so a filtered list must decide which of those
the row shows, and the summary must agree with whatever it decided. The full
reasoning is in [why a split row shows two
amounts](./filtered-row-amounts.md).

**The comparison.** Actual Budget documents the opposite outcome as a known
caveat of their filtered view: split transactions do not behave well there, and
the non-applicable part of the filtered results can end up added into the total.
Firefly III avoids the question at a different layer, by making a split several
records rather than one record with parts, which means a transaction stops being
one thing.

Sources: [Actual Budget, Filtering
Transactions](https://actualbudget.org/docs/transactions/filters/); [Firefly
III, Transactions](https://docs.firefly-iii.org/explanation/financial-concepts/transactions/).

**What it cost.** One transaction with parts means every row under a filter has
to show two figures and label both. That is more on screen, permanently, in
exchange for a total a reader can check by hand.

## 2. Small screens are a first-class size

**The property.** The transaction list is measured at 390 px, not merely made to
fit, and the measurements are committed as tests rather than described in a
document.

`src/routes/transactions/table-columns.svelte.spec.ts` asserts that every row in
the table resolves to a single height, that the longest category name the app's
own catalogue can produce renders without truncating, and it carries a
40-character unbreakable name in the same fixture that must truncate, so a run
where the stylesheet failed to load proves nothing instead of passing. The
mobile row's category line reserves its height with `min-h-6` rather than a
fixed `h-6`, and the reasoning is written next to it in
`src/routes/transactions/+page.svelte`: a fixed height absorbs an oversized
badge instead of letting it push the row, which would leave the row-height guard
unable to see the regression it exists to catch.

**The comparison.** Firefly III's documentation lists every mobile client under
third-party tools rather than shipping one, and one of those third-party clients
describes itself as a mobile-optimised front end. Source: [Firefly III,
Third-party tools](https://docs.firefly-iii.org/references/firefly-iii/third-parties/apps/).

**Stated honestly.** This is a much younger and much smaller application than
Firefly III, with a fraction of the screens to keep consistent. The comparison
is about where the effort went, not about capability.

## 3. The cash-flow forecast is a balance projection

**The property.** The forecast produces a balance for each day, from an anchor
balance forward, by projecting detected recurring flows onto a calendar. It is a
prediction of what the account will hold, not a summary of what a period held.

The engine is in `src/lib/domain/forecast.ts`: `detectRecurringFlows` infers
flows from transaction history and is pure and deterministic,
`projectFlowOccurrences` steps them forward with calendar-month clamping, and
`buildRealizedLedgerDays` reconstructs the realized side so the projected side
continues from a real figure rather than from an assumption. Confirmed against
tentative follows the same three-occurrence threshold the industry uses.

**The comparison.** Monarch's cash flow view is a report of where money came
from and went, per month, and their Sankey diagram is described as showing that
flow rather than a future balance. Monarch is a paid subscription product in
every tier. Source: [Monarch, Visualize your cash
flow](https://www.monarch.com/blog/visualize-your-cash-flow-like-never-before).

**What it does not do.** BudgetPilot has no Sankey view, which is the thing
Monarch's report does well and this one does not do at all. The two are answers
to different questions and neither replaces the other.

## What this section is not

It is not a feature comparison, and it should not grow into one. Each of the
three above exists because a decision was taken here that a reader could
otherwise mistake for an accident and undo. If a future entry cannot say which
decision it protects, it belongs in marketing copy rather than in this file.

See also [what BudgetPilot deliberately does not
do](./what-this-does-not-do.md).
