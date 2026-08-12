# What BudgetPilot deliberately does not do

Three capabilities that comparable tools have and this one will not gain. Each
was considered and declined. They are written down so that the absence reads as
a decision rather than as an oversight, and so that a later request meets an
answer instead of silence.

None of these is refused because it is hard. Each is refused because the cost
lands on people who did not ask for it.

## Conditional logic in the rule engine

**Not planned.** The categorisation rules will not gain if-then-else branching,
variables, boolean composition between conditions, or nesting.

The strongest argument for the refusal comes from the project that has the most
elaborate rule engine among the comparable tools. Firefly III's documentation
states that their engine is meant to support basic things, that although it is
technically possible to make it do far more they do not want to make the
application too complicated, and that most rule engines, including Gmail's
filters, have grown so complex under user demand that nobody uses them any more.
Boolean logic is on their list of things that will never be implemented.

Sources: [Firefly III, How to use
rules](https://docs.firefly-iii.org/how-to/firefly-iii/features/rules/);
[Firefly III, Missing
features](https://docs.firefly-iii.org/explanation/more-information/what-its-not/).

There is a second reason specific to this application. Rules here write a
transaction's manual category, and every money figure in the app reads it. A
rule language nobody can debug, with no execution trace, that quietly files six
months of transactions wrongly is worse than no rule at all, because the totals
it produces stay plausible.

**What is not refused:** adding trigger or action types to the existing flat
vocabulary. That stays open. The refusal is of composition, not of vocabulary.

## Double-entry bookkeeping

**Not planned.** Transactions will not gain a mandatory source and destination
account.

This is the trade-off that separates the two self-hosted tools this project is
measured against: Firefly III chose accounting rigour, Actual Budget chose ease
of use. Making the complex simple puts BudgetPilot on Actual's side of that
line, and crossing it later would be a change of product identity rather than a
feature. Double entry asks somebody who wants to know what they spent on
groceries to first understand asset, expense and revenue accounts and the
direction of every leg.

Source: [Firefly III,
Transactions](https://docs.firefly-iii.org/explanation/financial-concepts/transactions/).

The concrete benefit double entry buys for a personal budget is that transfers
between your own accounts are unambiguous instead of counting as both spending
and income. That is a real problem here and it is tracked. Double entry is a
disproportionate way to solve it: a counterparty link between two transactions
is one nullable column, not a change to what a transaction is.

## Envelope budgeting as a second system

**Not planned as a parallel mode.** Zero-based budgeting in the YNAB sense,
where every unit of income is assigned a job and unspent category balances roll
forward, will not be added alongside the existing monthly ceilings.

A second budgeting mode is a second product inside the first: a pool of money
waiting to be allocated, per-category carry-forward, reallocation between
categories, and a screen organised around assignment rather than around a limit.
Every surface that reads a budget would then have to ask which mode the user is
in. The cost does not stay with the people who wanted it: a mode appears in
settings, in the documentation, in the dashboard's wording, and in every support
answer that now begins by asking which mode you are using.

Both YNAB and [Actual Budget](https://actualbudget.org/docs/) use this model, so
the demand is real in the market. It is not yet real here.

**What would be built instead.** A single per-category checkbox, "carry unspent
balance to next month", off by default. It delivers the part people actually
miss, which is that an underspent month should not silently reset, for roughly a
tenth of the work, with no second mode and no change to what a budget means for
anybody who leaves the box unticked.

**The trigger to act:** two or more separate operators asking for rollover
specifically and saying what they do today instead. On that signal, build the
checkbox. The full envelope system stays refused regardless of how many ask,
because a request for rollover is not a request for a second budgeting
philosophy and the two must not be conflated when the requests arrive.
