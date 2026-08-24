# Reference

Rules, limits and exact values. Look things up here; the pages in
[using BudgetPilot](../using/README.md) tell you how to do things.

- **[Dashboard](./dashboard.md)**: what each figure counts, the period
  choices, and the caps on every card.
- **[Budgets](./budgets.md)**: the 80% threshold, what the summary strip
  adds up, and what deleting one does.
- **[Reports](./reports.md)**: the six figures, the three-month horizon,
  and the rule a flow must meet to reach the projection.
- **[Imports](./imports.md)**: accepted files, the four counts, duplicate
  detection, how the account a statement belongs to is worked out, and what
  deleting a run removes.
- **[Upcoming bills](./upcoming-bills.md)**: the two badges, what the
  header total counts, and the three windows it is compared against.
- **[Categories](./categories.md)**: naming rules, the eight natures, and
  the three outcomes of a delete.
- **[Rules](./rules.md)**: how matching works, what the table holds, and
  the manual-category exclusion.
- **[Cash-flow forecast](./cash-flow-forecast.md)**: the gates a flow
  must pass, the checking-account anchor, and the three horizons.
- **[Savings goals](./savings-goals.md)**: the two tracking modes, the
  fields, and how the pace is derived.
- **[Net worth](./net-worth.md)**: the account types, what the curve is
  built from, and which accounts the forecast anchors on.
- **[Split transactions](./split-transactions.md)**: how many parts, the
  amount ceiling, the rounding cent, what a filtered row displays, the CSV
  columns, and every refusal message.
- **[Two-factor authentication](./two-factor.md)**: the TOTP and
  recovery-code figures, what each step verifies, the rate limits, and the
  one route back into a locked-out account.
- **[Backup and restore](./backup-restore.md)**: the nineteen sections of the
  export, what it deliberately leaves out, what the validator checks, and
  every refusal message.
- **[Account settings](./account.md)**: the password rules, the session
  lifetime, where the language preference lives, the rules for the accounts
  your imports go into, and what Settings cannot do.

Settings and environment variables are not here: those are in
[configuration](../configuration.md), because they belong to the install
rather than to the app.

One page here is not about a feature: **[ASVS deltas](./asvs-deltas.md)** lists the
security-assessment verdicts that have moved since the commit
[SECURITY.md](../../SECURITY.md) pins, and is linked from there. It is a list of movements and
not a current state, which is the first thing the page itself says.

Nor is **[the design referential index](./design-referential.md)**: it maps every brick of the
component referential to the file in this repository that implements it, records the entries each
wave has added to that referential, and names the gaps a plate flagged and did not fill. The
referential itself is a Design deliverable and is not tracked here, so this index is how a later
session finds a decision without going back to the plate that made it.

## How these pages are written

Every number, label and limit is read out of the code before it is written
down, never recalled. Documentation is exactly where recall feels sufficient,
because the person writing it has just built the feature and is sure they know
it.

So: if a sentence here states a number, a label, a cap or a behaviour, check it
against the code before changing it, and check it again before trusting it.
