# Import screenshots

Captured with:

```bash
BASE_URL=http://localhost:4175 node scripts/doc-screenshots.mjs imports
```

## The arrangement they need

**The same small CSV imported twice**, so the history shows one run that
created transactions and one that skipped them all as duplicates. That pair
is the whole point of the history image: duplicate detection is per
transaction, and one row alone cannot show it.

```csv
date,label,amount,category
2026-01-06,LIDL,-48.30,Alimentation
2026-01-09,TRAINLINE,-27.40,Transport
2026-01-14,PAUL,-6.80,Alimentation
2026-01-21,ODEON CINEMA,-12.50,Loisirs
2026-01-28,SALARY,2850.00,Revenus
```

Dated **January** deliberately. Every other screenshot in these docs is of
the current month or the two before it, so importing into January leaves
every figure on every other page exactly where it was. An import dated into
the captured window would have silently moved the dashboard, the budgets and
the reports.

Unlike the other groups, this arrangement is **not** created by
`scripts/demo-screenshots.mjs`: it is an upload, and the seed drives HTTP
form actions rather than files. Import the file above by hand, twice, before
capturing.

## The summary shot needs a clean account

`summary-desktop.png` is the `import-summary` group, and it is a THIRD arrangement:
an account that has not imported this file before.

```bash
BASE_URL=http://localhost:4175 node scripts/doc-screenshots.mjs import-summary
```

The harness uploads the statement itself, so there is nothing to arrange by
hand, but a **second run against the same account photographs the wrong
thing**, because duplicate detection is per transaction and the panel then
reads 0 imported and 8 duplicates. That is a true summary of a different
event. Capture it on a fresh instance, or delete the run from `/imports`
first.

The file is `scripts/synthetic/make-synthetic.mjs`'s ledger, inlined so a
capture does not depend on somebody having run the generator: holder Paul
Mercier, who does not exist, invented merchants and invented amounts. Eight
movements over June 2026, six debits totalling 367,35 and two credits
totalling 2 524,30.

**This shot asserts what it depicts before writing the file**: five tiles,
the rows read as a sentence above them, and the two totals. It is the only
image here that had no capture step at all: it was taken by hand, went stale
when #386 changed the layout, and nothing could notice (#387). The assertion
is what stops that happening twice, and it earned its place on its first run
by counting ten tiles rather than five, because `/import` renders both
chromes into the DOM.

## The designation shots need their own arrangement

`columns-offer-desktop`, `columns-designation-mobile`, `columns-picker-mobile` and
`columns-designation-desktop` are the `import-columns` group, not `imports`. They
need no seeded history: the harness uploads a statement no profile recognises,
because a seeded import is by definition one that WAS recognised.

```bash
BASE_URL=http://localhost:4175 node scripts/doc-screenshots.mjs import-columns
```

The desktop shot uses its own **thirteen-column** file. The preview's whole
desktop behaviour is what it does with a file wider than the region, where it
draws the columns that fit and counts the rest, and a three-column file
photographs a
table with nothing to scroll.

Both fixtures are invented: holder Paul Mercier, made-up merchants, made-up
amounts and references. Only the SHAPE comes from a real statement: opaque
column names, the amount far from the date. **Nothing in these images comes from
anyone's bank**, and nothing that goes in them should.

## Language

English, with the browser locale pinned as well as the app's. See
[the screenshots README](../README.md).
