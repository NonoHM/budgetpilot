# Two stored forms: the deduplication key, and money

Companion to `2026-08-21-interface-audit.md`. That document enumerated what 1.0 freezes. This one
designs the two forms it found unfinished, and both are here for the same reason: **they are the
only two things left that would force a 2.0 rather than a 1.x.**

## How to read this

Every claim is tagged. **MEASURED** means a command was run in this session and its output is
quoted or summarised. **READ** means a file or a specification was opened at the cited location.
**RESEARCHED** means a primary source outside this repository was fetched; the two research files
under `docs/audits/research/` carry the URLs and their own READ/INFERRED/UNVERIFIED tags, and this
document does not restate a claim more confidently than the file it came from.

This is a design note, not a plan. It records what is stored, why each field exists, what the
module owns, and what we refuse. It does not order the work.

**Three of the assumptions this design started from turned out to be wrong, and they were wrong in
the expensive direction: each one made the design look more constrained than it is.** They are
corrected in place below rather than quietly dropped, because the reasoning that produced them is
the reasoning a future session will produce again.

---

# What the measurements changed

Read this section even if you read nothing else. Three findings reframe the two parts, and two of
them contradict the record.

**1. A key change costs the user nothing. The record says otherwise, and the record is wrong.**

`2026-08-21-interface-audit.md` says of the v2→v3 change: _"the user-visible cost of a key change
is paid once per change and not once per field"_, and `utils/safety.ts:165` says of the v1→v2
change: _"Backfill was rejected as impossible rather than expensive."_ Both sentences assume the
new key must be derived from the old one. It does not have to be.

**MEASURED**, on a throwaway SQLite through the real `parseCsvTransactions` and
`persistImportedTransactions`: a v3 key can be rebuilt **from the row's own columns**, `date`,
`label`, `amountCents`, `type`, `accountId`, with the occurrence ordinal re-derived by grouping,
and **without reading the stored raw key at all**. On a four-row `generic` fixture including a
repeated row and an accented label:

- 4 of 4 rows recomputed; 4 distinct keys;
- a re-import of the same file matched **4 of 4**: **zero duplication event**;
- an overlapping Jan+Feb re-export matched 4 and added exactly 1, so the property `occurrence.ts`
  exists to protect is preserved.

**What that measurement does and does not establish, because four rows on one profile cannot carry
a general claim.** It is a calibration: it shows the mechanism works end to end on a case that
includes the two hard parts (a repeated row needing an ordinal, and an overlapping re-export). The
general claim rests on two things checked separately.

**The collision-freedom is an argument, not a measurement.** v3's group is v2's group plus
`accountId`, and adding a field only makes groups smaller, so two rows sharing a v3 group shared a
v2 group, therefore held distinct v2 ordinals, therefore receive distinct v3 ordinals by
construction. The migration survives `@@unique([userId, dedupeKeyHash])` because of that, not
because four rows happened not to collide.

**The precondition that makes the rebuild exact is MEASURED**: every stored date is
`T00:00:00.000Z`, because `persist.ts:334` writes ``new Date(`${transaction.date}T00:00:00.000Z`)``,
so the key's `YYYY-MM-DD` is recoverable with no timezone question.

**The one real threat to the general claim is a path that stores a different label from the one it
keys on, and the codebase contains exactly one.** **READ, all five CSV profiles**
(`maison.ts:141`/`154`, `maison-v2.ts:148`/`162`, `revolut.ts:233`/`253`,
`banque-populaire.ts:188`/`204`, `resolvedRows.ts:191`/`200`): each builds its group from the same
`label` variable it puts on the transaction, so the fold inverts exactly. **`enablebanking.ts:363`
does not**: it feeds `normalizeForMatch(label)`, which strips accents, into the group while
storing the raw label. **MEASURED**, for `Supérette Générale` the two produce `supérette générale`
and `superette generale`. So **the recompute is source-conditional**, and `source` is a column, so
it can be. This is not a blocker; it is a requirement the migration carries.

**Why no probe of the import path could have found this, which is the part worth keeping.** The
recompute's correctness is the claim that a stored row inverts to the key that was built from it,
and that claim is only interesting where the two might disagree. Every CSV profile builds both from
one variable, so on CSV they agree **by construction**: a fixture drawn from any of the five, or
from all five, measures an identity and returns green for a property it never put under strain.
The only asymmetric path is the connector, and it is asymmetric in a way a fixture does not
advertise: the divergence needs an accent, and an invented merchant is as likely to be spelled
without one. **So this was found by READING the five profiles and the connector side by side, not by
running anything**, and the measurement afterwards only confirmed a difference already located.
That is the `CLAUDE.md` rule about a fixture chosen for legibility being structurally blind, in the
case where the blindness is total rather than partial: on this property the CSV fixture cannot fail.
**When every available fixture makes a claim true by construction, the claim has to be established
by reading the sources, and the probe demoted to a calibration.**

**One claim deliberately not made.** The probe found 0 rows with a NULL `type`, in a database it
had just created. That is a fact about the fixture and says nothing about an installed database,
where rows written by older versions live. **The migration must count NULL-`type` rows before it
runs**, not assume the fixture generalises.

**This is the finding that unblocks everything else in Part A.** v1→v2 was genuinely un-backfillable
because three profiles had embedded the filename in the key and it could not be separated out
again: the _old key_ was unparseable. Nobody asked whether the _row_ was sufficient. It is.

**2. `accountId` in the key does not fix #449 on the CSV path, and the first probe that said it did
was blind.**

The first probe built two buckets by passing different names _and_ different sources to
`resolveImportBucketAccount`. That is a setup the application cannot produce, and it is the
`CLAUDE.md` trap about a fixture chosen for legibility being structurally blind. Re-measured
through what `routes/import/+page.server.ts` actually does, one constant name
(`CSV_ACCOUNT_NAME = 'Compte import CSV'`, line 41) and a `source` derived from the _profile_
(`getImportSource`, line 555), the result inverts:

```
CALIBRATION, account #1 statement: imported=1 duplicate=0 bucket=cmt3755ot0001d4kljgt8qmr1
account #2 statement, same bank, same profile: imported=0 duplicate=1 bucket=cmt3755ot0001d4kljgt8qmr1
SAME BUCKET for both statements: true
Account rows this user now has: 1 -> Compte import CSV/csv
transactions actually stored: 1
CSV Account rows after using all three profiles: 3 (sources: csv,revolut,banque_populaire)
```

**A CSV user has at most three `Account` rows, one per import profile.** Two accounts at one bank,
exported in the same format, are one bucket. So the account-keeping fee in #449 still collides
under a key that carries `accountId`, because both fees carry the _same_ `accountId`.

`accountScope` was never a field somebody forgot to pass. **There is no per-account value to carry
because the CSV import model has no concept of which of the user's accounts a statement belongs
to.** The key is the wrong layer, and #449's remedy has to be read that way.

**And the defect is CSV-only, which the issue does not say and which sharpens the remedy.**
**READ, `banking/sync/service.ts:293-303`: bank sync creates one bucket per provider account**,
passing `name: account.name` and `providerAccountId: account.id`, so two accounts at one bank
already land in two `Account` rows on that path, and `accountScope` already separates their keys.
So the two halves of #449 are in different states: **the bank-sync half is already correct, and
`accountId` in the key is what lets the CSV half become correct once its buckets are per-account.**
The key change is not cosmetic on either path; it is what unifies two mechanisms that currently
disagree.

**3. The premise for storing an exponent per amount is false. The conclusion survives, on ONE
reason, and not the one the design started from.**

The claim under test was that ten ISO 4217 codes appear in the standard's own tables with two
different minor-unit exponents, which would make code→exponent not a function. **RESEARCHED, and
REFUTED at the root** (`docs/audits/research/iso4217-money.md`): both XML files were fetched from
SIX and parsed mechanically, and `grep -c "CcyMnrUnts" list-three.xml` returns **0**. The historic
list has no minor-unit field at all, for any of its 169 entries: there is no second exponent for
anything to disagree with. Two of the ten (ANG, HRK) are not in both lists at all. Within List One
the mapping _is_ a function: no code carries two distinct values.

**Where the claim came from, recorded because it is the reason this note is trustworthy rather
than as a courtesy.** It came from the brief that commissioned the design, so the claim that shaped
the whole money form was the commissioning claim, and it was cited from memory of a secondary
source. The source is a Wikipedia template, and its sentence says something else: **its ten codes
are ambiguous about WHICH ROW TO SELECT, not about which exponent applies.** A table that lists a
code twice needs a rule for picking the entry; that is a property of the template's own data and not
a fact about ISO 4217. The misreading converted a lookup problem into a modelling problem, and it
was load-bearing: every field of the stored form was drawn to accommodate it.

**What caught it was procedural rather than clever: go to the standard's own published tables rather
than to a wiki, because the whole design turns on it.** Nothing about the claim looked wrong. It was
specific, it named ten codes, and it predicted exactly the difficulty a careful designer expects to
find. It died in one `grep` against the file SIX publishes and it would have survived any amount of
further reading _about_ the standard. **A claim's specificity is not evidence for it**, and the only
cheap discriminator is the artifact the claim is about.

**A second near-miss is recorded with it, because it runs the other way and would have cost more.**
This note was one message from ruling a refusal of MRU and MGA, on the folklore that they are
base-5 currencies an exponent cannot represent. **ISO assigns both exponent 2** and integer minor
units represent them exactly. The refusal was wrong, and the only thing that stopped it being
written into a stored form was declining to decide before the research landed. **A refusal drafted
on an unverified premise is paid for in a column**, which is the expensive place to be wrong.

Storing the exponent per amount is still right. Part B gives the single reason that does the work,
and it is not the one this design started from.

---

# PART A: THE DEDUPLICATION KEY

## What v3 stores

```
v3 | date | folded label | magnitude | exponent | type | occurrence | accountId | currency
```

Eight fields behind a version marker. Each is here because something breaks without it, and the
justification is per-field rather than per-key.

**`v3`: a literal prefix inside the hashed string.** **MEASURED: no version marker exists
anywhere today.** `git grep -iE "keyVersion|KEY_VERSION"` returns nothing; "v2" is a word in a
doc comment. So the choice is not between two existing mechanisms, it is a first introduction.

A prefix, not a column, and the argument is not the obvious one. The obvious argument for a column
is that you can query which rows are on which version; the obvious argument for a prefix is that v2
and v3 cannot collide. Both are true, and the prefix wins on a third point that only shows up when
you ask how the migration fails. `prisma migrate deploy` **wraps nothing in a transaction on any
engine** (`CLAUDE.md`, and it is why the backfills in this repository are boot-time app code rather
than SQL). So a partial population is reachable, and the question "which rows are still pending" has
to be answerable. A prefix answers it: `dedupeKey NOT LIKE 'v3|%'` reads the column that already
exists, so the prefix delivers the column's advantage as well as its own, and a column would be a
second thing to keep in sync with the string it describes.

The prefix is inside the _hashed_ string, not beside it. The hash is what the unique constraint
compares (`dedupeKey.ts`), so putting the version anywhere else leaves two versions able to collide
on the compared value, which is exactly the false-duplicate this key exists to prevent.

**`date`, `folded label`, `magnitude`, `type`: unchanged from v2, and the v2 reasoning holds.**
`utils/safety.ts:115-165` argues these are the fields every source guarantees, and that `category`
and `reference` left because a key that changes when the user corrects a mapping is not a key. That
argument is sound and this design does not reopen it.

**`occurrence`: unchanged, and now measurably recomputable.** It exists because two coffees at one
price on one day are ordinary and v1 merged them, and a silently dropped transaction is the worse
failure direction. The new fact is that it does not need to be stored to be rebuilt: grouping
existing rows by the other five fields and numbering them reproduces the same _set_ of ordinals a
fresh import produces, which is all the comparison needs. **MEASURED** above: 4 of 4 fresh keys
matched, and the overlapping-statement case still added exactly one row.

**`accountId`: the field `accountScope` was always reaching for, with its limits stated.**
`utils/safety.ts:72-79` already says what this field is for: it _"must be stable for the life of
the account and must never be anything per file"_. `Account.id` is exactly that, and it is
non-nullable on `Transaction`, so unlike `accountScope` it cannot be silently absent. It replaces
`accountScope` rather than joining it: **MEASURED**, `accountScope` has two call sites, both bank
connectors (`enablebanking.ts:376`, `mock.ts:130`), and five CSV profiles pass nothing, so the
field is the empty string on every CSV import.

**What it does and does not buy has to be stated in the same breath, or this design ships a false
claim.** It makes the key _capable_ of separating two accounts. It does not separate the two
accounts in #449, because both statements land in one bucket. See "What actually closes #449".

**`currency`: the row's own, never the account's.** Two amounts of the same magnitude in different
currencies are different transactions; a key that merges them drops one silently. Today that is
unreachable, because an account has one currency, which is why `accountId` looks like it makes
`currency` redundant.

It does not, and the reason is a stability argument rather than a discrimination argument. **READ,
`prisma/schema.prisma:161-179` and `banking/sync/service.ts:295-303`: `Account.currency` is
writable by the bank connector at connection time.** A mutable field is a bad key component: if the
provider re-reports a currency, every key derived from that account changes at once and the user's
whole history re-imports. **A row's own currency never changes after it is written, so it is the
one that belongs in the key.** This is also the interlock between the two halves of this note:
Part A can only take this field because Part B stores it per amount.

**`exponent`: ruled in, and the argument is the money form's own premise.** If the currency
determined the exponent we would not be storing it per row. We are storing it per row precisely
because it does not, and the two facts cannot both be true of one design: **magnitude plus currency
does not identify an amount.** `1000 EUR` is ten euros at exponent 2 and one euro at exponent 3, so
two rows written that way produce one key for two different sums, and the unique constraint drops
one of them.

**This was ruled rather than measured, and the reason is worth keeping.** Measuring reachability
would have measured whether the ambiguity happens to occur in today's data, which is a fact about
the data and not about the key. The design already says the ambiguity CAN occur, since a per-row
exponent is the whole point of Part B. **A key that identifies an amount carries everything that
determines the amount**, and reachability is not the test.

## What actually closes #449

Not this key. **MEASURED** above: the fee collides because both statements carry the same
`accountId`, and they carry the same `accountId` because `resolveImportBucketAccount` is keyed on
`(userId, nameKey, source)` and the route passes a constant name with a profile-derived source.

What closes #449 is **an import that names a real destination account**. The import screen already
has a destination selector, and **READ, `routes/import/+page.server.ts:129-133`, it selects a
`NetWorthAccount` to link, not the `Account` the rows land on**, and only on first creation, which
the code's own comment says out loud. So the model has a place for the concept and the import path
does not use it.

**The ordering rule this produces, stated as a rule because it will outlive this issue.** _A
visible fix over an invisible defect is the worst order available._ Landing the bucket change first
puts two accounts on the screen while the account-keeping fee is still silently deduplicated away,
so the screen becomes right and the drop stays invisible, and every later report reads as a new bug
rather than the old one. Landing the key first leaves #449 open and honest. **Order the change that
makes a defect visible before the change that makes the screen look right**, whenever the two are
separable.

That is a model change and a UI change, and it is deliberately not designed here. What this note
fixes is the ordering: **the key must be able to carry the account before the account exists to be
carried**, and the key change is free (measured), so it can land first without costing the user a
duplication event. Landing them in the other order means either shipping a key that cannot express
the fix, or paying a duplication event to change the key later.

**The record should be corrected on this point.** #449's body attributes the defect to a per-user
unique constraint plus an unpassed `accountScope`. Both facts are true and the implied remedy,
pass `accountScope` from the CSV profiles, has nothing to pass. The realistic instance the issue
names, two accounts at one bank, is precisely the instance the bucket model cannot express.

**RESEARCHED, and the same failure has already happened to somebody else.** Firefly III resolves an
imported transaction's external id with a full-text search scoped to the user rather than to the
account; GoCardless's `internalTransactionId` is per-account and not globally unique; the result is
Firefly issue #10914, **a real transaction silently dropped**
(`docs/audits/research/transaction-identity.md`). A per-account identifier compared at per-user
scope drops real rows. That is #449's exact shape, independently arrived at, and it is the strongest
outside evidence that this is worth closing rather than living with.

## Cross-source deduplication: already decided, and not in the key

Should a CSV import and a bank sync of one transaction recognise each other?

**They cannot today, and the decision was made a layer below the key.** **MEASURED**:
`resolveImportBucketAccount` looks up on `(userId, nameKey, source)`, and the sync path passes
`source: 'enablebanking'` while CSV passes `'csv' | 'revolut' | 'banque_populaire'`. A sync bucket
and a CSV bucket can therefore never be the same `Account` row. Adding `accountId` to the key does
not decide the question: **the bucket resolution decided it already**, which is exactly the
"decided by accident" this was worth checking for. It just was not the key that did it.

**READ**, there is a second, independent reason they could not match even in one bucket: the two
paths do not fold labels the same way. **MEASURED**: `enablebanking.ts:363` feeds
`normalizeForMatch(label)`, which strips accents, into the group, while the CSV profiles pass the
raw label to a fold that only lowercases and collapses whitespace. For `Supérette Générale` the two
produce `superette generale` and `supérette générale`. Two sources, two spellings of one key.

**Decision: cross-source deduplication is refused, and it is a refusal with a reason rather than an
omission.** Making it work means making two sources agree on a content fingerprint when they
disagree about accent folding (measured), and about which date field the row carries: the connector
takes `booking_date ?? value_date ?? transaction_date` (`enablebanking.ts:345`) while a CSV has one
date column of unstated provenance. **The failure direction of a false match is a silently dropped
transaction**, which is the direction this repository has already ruled the worse one, twice, in
writing. A false _non_-match shows the user two rows, which they can see.

**What that costs, stated:** a user who imports a statement and later connects the same bank gets
both copies. This is real and it is the visible direction. The remedy is a merge feature over
visible rows, not a wider key.

## Booking date against value date

**READ**, the connector already prefers booking date:
`transaction.booking_date ?? transaction.value_date ?? transaction.transaction_date`
(`enablebanking.ts:345`), and throws when all three are absent.

**RESEARCHED**, and the domain's answer is less reassuring than the code's:
`BookgDt` and `ValDt` are **both `[0..1]`** in camt.053, and there is a case where `ValDt` must not
appear at all. `BookgDt` for a booked entry is the actual posting date; `ValDt` carries the
float/availability adjustment. That `ValDt` is the more likely of the two to move between exports is
marked **INFERRED** in the research file: no source measuring it was found, and this note does not
upgrade it.

**The design consequence is not about which field to prefer. It is about the fallback chain.**
Preferring booking date is right. But a chain of three optional fields means **a provider that
starts emitting `booking_date` where it previously emitted only `value_date` silently changes the
date of every subsequent row**, and therefore its key, and therefore re-imports the user's history.
The chain converts an optional field into a key input whose provenance is not recorded.

**So the row must record which field its date came from**, not in the key, where it would make the
key depend on the provider's emission habits, but beside it, so that a change of provenance is
diagnosable rather than invisible. `metadataJson` already carries per-source fields and is the place
for it.

## What the domain says about identity, and why we are not adopting it

The brief's hypothesis was that if a field exists in the standard whose purpose is exactly this,
using it beats inventing one. **RESEARCHED, and the field does not exist.**

**Nothing in camt.053 is both mandatory and identifying.** The `Refs` block is `[0..1]` and _every_
child of it is `[0..1]`: `MsgId`, `AcctSvcrRef`, `InstrId`, `EndToEndId`, `UETR`, `TxId`. Entry-level
`AcctSvcrRef` and `NtryRef` are `[0..1]` too. Only two fields anywhere carry a stated uniqueness
_scope_, and both are scoped to a "pre-agreed period" rather than to the account. `EndToEndId` is
mandatory in SEPA _initiation_ but carries a sanctioned filler, _"In the event that no reference
was given, 'NOTPROVIDED' must be used"_, so it is present-but-identity-free in practice, and it
relaxes to optional in the statement anyway. And a batch-booked entry has one `AcctSvcrRef` covering
N `EndToEndId`s, so the identifier is not even at the same granularity as the transaction.

**This validates a choice the connector already made, which is worth saying because it is the one
place where the existing code is ahead of this design.** Enable Banking's own documentation states
that `transaction_id` _"should not be used as a unique reference to identify transactions, because
the value may change if the list of transactions is retrieved again"_, while `entry_reference` is
_"not globally unique"_ but _"for accounts with the same identification hashes, the value is
immutable"_. **READ, `enablebanking.ts:373`: the connector keys on `entry_reference`, scoped by
account, and does not use `transaction_id`.** That is exactly right, arrived at before the research,
and it should not be disturbed.

The provider-id branch therefore stays, and stays _branch-shaped_: when the provider supplies a
stable per-account reference the key is `v3|enablebanking:<providerAccountId>:<entryRef>`, and the
content fingerprint is the fallback for providers that omit it. **The two shapes are a permanent
feature of this key, not a transitional state**, because the domain guarantees no identifier we
could depend on everywhere.

**RESEARCHED, and four independent sources converge on one more thing: booked and pending are
different identity regimes.** GoCardless generates its id _"only for booked transactions and not for
the pending ones"_. **READ, `enablebanking.ts:330`: the connector already refuses anything whose
status is not `BOOK`.** Also already right.

**What other systems do, and why neither is a model to copy.** Firefly III hashes the entire
submitted row minus two fields, scoped to `user_id` only: its own documentation admits _"if you
change the mapping … the hash changes"_, which is the defect v2 removed here when `category` and
`reference` left the key. Actual Budget keys on a provider id with an account-scoped match, then
falls back to ±7 days and an exact amount. **The ±7-day fuzzy window is the interesting one and we
are refusing it**: it merges two genuinely distinct same-amount transactions a week apart, which is
the silent direction. Actual can afford it because a human reconciles in its UI. We deduplicate
unattended, at import time, with no review step, so the same tolerance would drop rows nobody ever
sees.

## What v3 refuses

- **Cross-source matching.** Argued above. Two sources that disagree about accent folding and date
  provenance cannot safely share a fingerprint when a false match is invisible.
- **Fuzzy matching on date or amount.** No ±N-day window, no amount tolerance. Both trade a visible
  failure for an invisible one, and neither is reviewable here.
- **`transaction_id` and any other provider identifier the provider does not promise is stable.**
  The provider says it may change; believing it anyway re-imports histories.
- **Pending transactions.** Already refused in code; recorded here so it is a decision rather than
  an artifact.
- **Any field the file may or may not carry.** This is v2's rule and it is kept: `category`,
  `reference`, filename, and the statement's own free-text references stay out.

## What this form already allows

- **A multi-currency account**, because `currency` is on the amount rather than on the account.
- **Re-bucketing.** When #449's real fix moves rows to per-account buckets, those rows' keys change,
  and the recompute rebuilds them with no duplication event, by the same mechanism measured here.
  This is why the recompute must be a **permanent capability of the schema rather than a one-shot
  migration**: three callers need it, the v2→v3 backfill, the backup restore, and the
  re-bucketing #372 performs. **The third caller has to be known while the key work is being done,
  not discovered afterwards.** Known in advance it is one module with an entry point; discovered
  afterwards it is a script inside a migration that a later chantier has to rewrite, and the rewrite
  is where the two copies of the folding rule stop agreeing.
- **A v4.** The prefix means the next version costs a recompute and no collision risk, provided v4's
  inputs stay recoverable from the row, which is now a stated property to preserve rather than an
  accident to rediscover.

## The backup, which the audit did not connect to this

**MEASURED**: `dedupeKey` is in the backup contract, selected at `backup/export.ts:106`, validated
as `z.string().max(500).nullable()` at `backup/schema.ts:291`, and written back **verbatim** at
`backup/import.ts:329`. So the key is not only a stored format, it is an _exported_ one, and it is
frozen by 1.0 in two places rather than one.

**The consequence nobody has recorded: restoring a pre-v3 backup after v3 ships writes v2 keys into
a v3 world, and those rows then duplicate against everything.** The restore path has to recompute
too, and **MEASURED, it can**: `backupTransactionSchema` carries `accountId`, `date`, `label`,
`amountCents`, `type`, `source` and `metadataJson`, which is every input the recompute needs.

One gap, stated rather than assumed away: `type` is `nullable()` in that schema. A backup carrying a
null `type` produces a row that cannot be keyed. The correct behaviour is the existing one for
manual transactions, leave the key null, which makes the row invisible to deduplication rather than
wrongly matched, and it should be that by decision, not by falling through.

---

# PART B: MONEY

## The three findings, checked

The design started from three claims. **Two are refuted and one is reframed**, and reporting that is
more useful than reporting what was built on top of them.

**"Code to exponent is not a function." REFUTED.** Covered above. `list-three.xml` has zero
`CcyMnrUnts` elements; within List One no code carries two values. The claim came from a Wikipedia
template.

**"Some currencies are not decimal, and an exponent model may not represent them." REFUTED as a
storage problem.** **RESEARCHED: ISO 4217 assigns MRU = 2 and MGA = 2**, not 0 and not base-5. The
folklore about five khoums and five iraimbilanja is true about the currencies and false about the
published data. And ISO's choice is the one that makes integer minor units _lossless_: at exponent
2 one khoum is exactly 20 minor units, one iraimbilanja exactly 20. **So these currencies need no
refusal, and the refusal this note was going to propose would have been wrong.** They are ordinary
exponent-2 currencies for storage purposes; only their _display_ is unusual, and display is not
where the irreversible decision lives.

**"The exponent must be stored per row." SURVIVES, on one reason, and not the original one.**

**The reason: a stored row's meaning must not depend on a mutable external artifact.** ISO 4217 is
maintained, republished and revised; a row written today is read in five years. If the exponent is
derived at read time, the meaning of an existing row changes when the list changes, which is
exactly the ambiguity the rule on `Account.currency` exists to prevent, arriving through the front
door instead of the back.

**RESEARCHED, and this is not hypothetical: codes leave.** ANG and HRK are gone from List One
entirely, and because List Three carries no minor-unit field at all, **a row denominated in a
withdrawn currency has no published exponent to look up anywhere.** Deriving at read time makes such
a row unreadable; storing the exponent makes it permanently readable. That single case is the whole
argument, and the refutation of the ten-code claim is what supplies it: it was only by establishing
that List Three has no exponents that withdrawal became fatal to derivation rather than survivable.

**That is the whole argument, and it stands alone deliberately.** The first draft of this section
gave four reasons. Three of them, that CLDR and ISO diverge, that 13 codes have no exponent at all,
that `Intl` never throws on an unknown code, are true and measured, and **none of them requires
per-row storage**: each constrains how a list may be _used_, and a design that derived the exponent
could satisfy all three. They were listed because a refuted premise's replacement felt thin, which
is a failure a reader cannot detect from outside the document. **A count of reasons is not
evidence.** The three facts are deleted from here and kept where they do work, under the refusals
below.

**The rule on `Account.currency` is unchanged and is now better supported than when it was
written.** A currency field and an exponent field must arrive in the same change.

### What the prior art says, including where it does not support us

**RESEARCHED** (`docs/audits/research/money-module-prior-art.md`), four codebases read at pinned
commits rather than documentation about them.

**The strongest corroboration is `dinero.js` v2, which answers the per-amount question with both
names.** `currency.exponent` is the default and `scale` is per amount, always present in the
snapshot, with mixed scales normalising upward before arithmetic and a separately named `trimScale`
as the inverse. That is this design's stored form, arrived at independently, and it is worth more
than an argument because it is a library that had to live with the consequences.

**And the honest half: no standard mandates a per-row exponent, and this note does not claim one.**
ISO 20022 carries the currency as a required attribute of the amount and derives the exponent from
ISO 4217 by a named rule; Fowler's Money pattern declines the question explicitly. Recorded as
UNVERIFIED rather than filled in. What the sources do support is the reconstructibility argument,
which is the one this note actually rests on, and not a precision argument, which it does not make.

**One interface question the research reopened, and it is now RULED rather than left to the
migration.** Firefly III's display path sets ICU's minimum AND maximum fraction digits both to the
currency's stored precision, overriding the locale's own data. This note's first draft did the
opposite, letting the currency decide the display digits and the row decide the storage exponent,
allowed to differ. **The ruling is Firefly's: the stored precision wins, and it overrides the locale
data deliberately.** Letting the locale decide puts a rounded number on screen beside a differently
precise one in storage, which is the class this repository spent a release removing.

**The divergence is recorded so the decision is checkable rather than asserted.** `Intl` formats
from CLDR, which UTS #35 defines as deliberately divergent from ISO 4217 ("may deviate ... where
there is compelling evidence for different customary practice"). **RESEARCHED**, measured by joining
CLDR's `digits` against ISO's `CcyMnrUnts` over all 178 current codes: they disagree on exactly 15,
and CLDR is lower in every case.

| Codes                                                                | ISO `CcyMnrUnts` | CLDR `digits` |
| -------------------------------------------------------------------- | ---------------- | ------------- |
| AFN, ALL, COP, HUF, IDR, IRR, KPW, LAK, LBP, MGA, MMK, SOS, SYP, YER | 2                | 0             |
| IQD                                                                  | 3                | 0             |

So a row stored as `12345` HUF at exponent 2 renders as `123 HUF` under the locale's own data and as
`123,45 HUF` under the stored precision. IQD is the widest gap and the one that shows the size of
it: a factor of a thousand. **MEASURED, and this is not a future problem: the defect was reproduced
against the module before the ruling was applied and is now a test.** A caller may still override
the digits explicitly, and one does, because a forecast range rounds to the whole unit on purpose:
a caller saying what it means is a different thing from a locale deciding it by default.

**Two smaller findings, promoted to REFUSALS with their evidence attached, because each is a
convenience somebody will propose later.**

- **The inbound door refuses rather than rounds.** Firefly stores a per-currency precision and does
  not validate it on write, so a JPY amount of `100.55` is storable there. **A per-row precision
  with no gate on the write path records a lie rather than a value**, and the gate has to be the
  parser, because it is the only place that sees the text.
- **The machine door returns a string, never a number.** Actual Budget's CSV export returns a
  JavaScript `number`, and carries a pinned test asserting that `-2500` minor units export as `-25`
  rather than `-25.00`. The trailing zeros are gone, the precision is gone with them, and a test now
  holds it that way. **A machine door that returns a number is not a machine door**, and the quoted
  test is the evidence, because the convenience reads as harmless right up until something parses
  the file.

## What is stored

Per amount: **minor units as an integer, the currency code, and the exponent that says what the
integer means.** The exponent is stored beside the amount rather than derived, for the reason
above: a stored row must not depend on a mutable external list, and a withdrawn code has no
published exponent anywhere.

**What the exponent is, precisely: a property of the amount as written, not of the currency as it
stands today.** It records how to read this integer. That is what makes an old row's meaning
independent of any list, and it is the whole of the irreversibility argument.

**Existing rows are stamped with exponent 2 explicitly, never left to a column default.** They are
exponent-2 by construction, so a default reads identically today and the difference only appears
later: a value that was never written is a value nobody can correct. The key carries the magnitude,
so correcting a row's exponent afterwards changes what its key means without changing the key, and
the row silently stops matching the statement it came from. **A default is a value with no author**,
and this is the class of column where that is fatal rather than tidy. The stamping precedes the key
recompute, so every key is computed over an exponent somebody wrote.

**A constraint the audit does not record, and it lands inside this window.** **MEASURED**: all 8
money columns are `Int`, which is 32-bit on PostgreSQL and MySQL. **READ**, `domain/netWorth.ts:70`
sets the net-worth cap at `1_000_000_000` minor units: 10M in major units, deliberately raised from
1M as too low for real estate. **MEASURED**, that cap at exponent 3 is 10,000,000,000 minor units,
which **overflows a signed 32-bit integer by roughly five times**:

```
exponent 0 -> max major unit 2,147,483,647
exponent 2 -> max major unit 21,474,836.47
exponent 3 -> max major unit 2,147,483.647
exponent 4 -> max major unit 214,748.365
```

So **supporting the seven 3-decimal currencies requires widening those columns**, or refusing the
app's own stated cap for them. Widening `Int` to `BigInt` preserves every value, so this is not a
2.0, but it is a migration across eight columns on the largest tables, and it is enormously cheaper
before 1.0 than after. It belongs in the same change as the exponent for that reason alone.

## The module, and where the seam goes

**The deletion test decides the shape.** Delete a money module today and nothing is lost, because
there is no module: there is a parser (`domain/money.ts`) and a formatter
(`domain/budget.ts:formatCents`) and fourteen other places doing arithmetic. Delete the _proposed_
module and the exponent reappears at every one of those sites. It earns its keep.

**The shallow version, rejected.** An `exponentFor(currency)` lookup is a small implementation
behind a small interface, and every call site still has to know that money scales by a power of ten
and remember to apply it. That does not remove the assumption; it parameterises it sixteen times and
leaves sixteen chances to forget. It is the shape that fails the deletion test while looking like
progress.

**The seam is a `Money` value, and the interface has three doors, because the census says the sites
are not all the same kind.**

- **Inbound.** Text or a provider's decimal string, plus a currency, becomes a `Money`. This door
  owns the _grammar_, how many fraction digits are accepted, which today is a literal `{1,2}` in
  four regexes.
- **Outbound, human.** A `Money` and a locale become a display string. This door owns the scaling
  _and_ the fraction digits handed to `Intl`, which is where the current code disagrees with itself.
- **Outbound, machine.** A `Money` becomes a plain decimal string for the CSV export, the LLM
  prompt, and the naming report. **This is a frozen format** (`2026-08-21-interface-audit.md`,
  Part 3), so it is a separate door on purpose: changing how a human sees an amount must not be able
  to change what a downstream tool parses.

**What the module owns:** the exponent, every power-of-ten scaling, the accepted grammar, the
fraction digits handed to `Intl`, and division. **What stays outside:** the locale, which belongs to
the request; the currency's identity, which belongs to the row; and the decision of which door to
use, which belongs to the caller and should be obvious from the door's name.

**One thing must not be inside it: cross-currency arithmetic.** Adding two `Money` values of
different currencies is refused, loudly, rather than converted or silently allowed. That single
refusal is what makes every aggregate in the application honest without any aggregate having to
think about it.

## The prerequisite, measured properly

The brief put this at eighteen files dividing by 100. The audit put it at "19 sites across 18
non-spec files". **Both are wrong, in both directions, and the way they are wrong is the point.**

**MEASURED**: a plain `git grep '/ 100'` returns 20 sites across 16 files today, but it matches
`/ 1000` as a substring, which is why `banking/enablebanking/jwt.ts` (a JWT `getTime() / 1000`) and
`database/advisoryLock.ts` (an elapsed-seconds log line) are in it. It also sweeps in percentage
arithmetic, `DonutChart.svelte`, `domain/typography.ts`, `domain/savingsGoal.ts`, which is not
money. And it misses `* 100` entirely, which is where parsing lives.

Reclassified by hand, the exponent-2 assumption exists in **four syntactic forms**:

| Kind                                     | Sites | Files | What it does                                    |
| ---------------------------------------- | ----- | ----- | ----------------------------------------------- |
| **Scale** (`/ 100`, `* 100` on money)    | 16    | 13    | Converts between minor and major units          |
| **Grammar** (`\d{1,2}`, `padEnd(2,'0')`) | 7     | 2     | Decides what the parser will _accept_           |
| **Output grammar** (`toFixed(2)`)        | 6     | 6     | Fixes the decimals of a machine-readable string |
| **Symbol** (a literal `€` or `'EUR'`)    | 3     | 3     | Names the currency in the UI or an export       |

The 16 scale sites: `SavingsGoalsSection.svelte:73`, `splits/SplitEditor.svelte:90`,
`splits/SplitRemainderBand.svelte:45`, `domain/budget.ts:171`, `domain/money.ts:97`,
`domain/upcomingBills.ts:396` and `:399`, `enablebanking.ts:412`, `:413` and `:430`,
`insights/prompt.ts:61`, `insights/rules.ts:52`, `naming/report.ts:185`, `exportCsv.ts:102`,
`budgets/+page.server.ts:107`, `net-worth/+page.server.ts:213`.

**The grammar sites are the ones that matter most and the `/100` grep cannot see them.** A scale
site produces a _wrong number_, which is visible. A grammar site _refuses the data_, and
**MEASURED**, it refuses in two opposite directions inside one file:

```
"12.34"      tx-grammar: ACCEPTED   balance-grammar: ACCEPTED
"12.345"     tx-grammar: REFUSED    balance-grammar: REFUSED
"1234.567"   tx-grammar: REFUSED    balance-grammar: REFUSED
```

- A 3-decimal **transaction** amount throws `'Enable Banking transaction has an unparseable amount'`
  (`enablebanking.ts:339`). **READ**: that throw is **not caught** in the fetch loop
  (`enablebanking.ts:202-204`), so one such amount aborts the entire account's fetch.
- A 3-decimal **balance** returns null and is filtered out silently (`enablebanking.ts:262-271`),
  so the account's balance simply disappears from net worth with nothing to report it.

**So "eighteen files divide by 100" understates the prerequisite twice over**: the count is wrong,
and the sites the count is drawn from are not the dangerous ones.

**And the seam is already half-built and already wrong.** **READ**, `formatCents`
(`domain/budget.ts:149-171`) already takes a `currency` parameter defaulting to `'EUR'`, and
divides by 100 unconditionally while `Intl` takes its fraction digits from the currency.
**MEASURED**:

```
EUR  formatCents(123456) => 1 234,56 €
JPY  formatCents(123456) => 1 235 JPY      (stored ¥123 456, a 100x error, rounded)
KWD  formatCents(123456) => 1 234,560 KWD  (stored 123.456 KWD, a 1000x error)
```

**A caller can pass a currency today and get a silently wrong figure.** That is the strongest
argument for the ordering the brief already proposed: the module comes first, and the currency
column comes second. A currency column added to a codebase with sixteen unguarded scale sites and a
formatter that already accepts a currency it cannot honour produces wrong amounts on screen with
nothing red.

**Two negative results, both calibrated so the zero means something.** **MEASURED**: the message
catalogues contain **zero** hardcoded currency symbols in either locale: checked for the literal
`€` _and_ for the escaped forms `€` / `20AC`, because a grep for the glyph alone would report
a confident zero over a file that spelled it as an escape. And **MEASURED**: no money arithmetic
happens in raw SQL: every `$queryRaw` / `$executeRaw` in the tree is in `database/advisoryLock.ts`
or `database/privileges.ts`, so the census above is not missing a scaling site hidden in a query.

The three symbol sites are
`MoneyInput.svelte:128` (a literal `€` suffix on the shared amount field), `naming/report.ts:185`
(a hardcoded `" EUR"` in an export) and `budget.ts:153` (the default parameter).

## Rounding

**RESEARCHED, and the honest answer is that no standard gives you a mode.** IFRS/IAS specifies none:
a sweep of the EU-endorsed corpus finds "rounding" twice, both in IAS 1, both about _disclosing_
the level of rounding, and IAS 21 has zero hits. ISO 20022 constrains digit counts and never a mode.
What _is_ legally binding points in incompatible directions: EU Regulation 1103/97 Article 5 mandates
**half-up** for euro conversion; HMRC VAT Notice 700 §17.5 mandates **round-down** for invoice
traders and §17.6 forbids it for retailers.

**So the mode is a parameter of the operation, never a property of the currency, and a global
`ROUNDING_MODE` constant would be a bug wearing a standard's clothes.** There is no correct value
for it.

**Which means the design's answer is that no rounding mode belongs in the stored form, and the
first draft of this section overreached by saying no rounding mode is needed at all.**

The stored claim is the defensible one: **every amount this design stores is an integer number of
minor units, arrived at without a non-integer multiplier.** Parsing a decimal string to minor units
is exact. Splitting is exact by construction (below). Refusing conversion removes the FX case, which
is the only one that would have forced a mode into the stored path. So there is no rounding decision
to freeze at 1.0, and adding a `ROUNDING_MODE` constant would be freezing a decision with no correct
answer.

**What the first draft got wrong: the application already produces fractional minor units, just
never stores them.** **MEASURED**: `domain/savingsGoal.ts:105`, `:107` and `:128` divide cents by a
month count to produce a required monthly pace, and `server/dashboard/insights.ts:147` averages
cents across a period. Both yield non-integers. Both are _derived for display_ and neither is
written to a money column, so they do not touch this note's subject, but "nothing in this
application applies a non-integer multiplier" was simply false, and a reader checking it would have
found the counterexample in two greps. **Where those figures round is a display decision, outside
this note, and it should not be smuggled in under a stored-form heading.**

**Division is the one real case, and it is already decided, proved and shipped.** **READ**,
`domain/allocation.ts:219-247`: `distributeEvenly` is largest-remainder over integer minor units,
with the extra unit going to the _first_ parts, and its docstring carries the conservation proof
(`Σ = s(nq + r) = sA = T`, exact for every `n ≥ 1` and either sign). The choice of _first_ is
load-bearing rather than an arbitrary tiebreak, because `TransactionSplit.position` exists so that
which part carries the extra unit is stable and visible, and the editor's UI states it in words.

**RESEARCHED, this is the right algorithm and the reasoning is the standard one.** Fowler's decisive
sentence: _"There's no general rounding scheme I can apply to both that will avoid losing or gaining
a penny."_ No rounding mode solves allocation; largest-remainder over integer minor units does, and
conservation is a theorem of the construction rather than a property to test for.

**So the brief's "nobody has decided rounding here" is half wrong, and the half that is decided is
the half that matters.** Allocation is settled, implemented and proved. Only a conversion mode is
undecided, and refusing conversion means it stays that way.

**One residual, recorded because refusing conversion is what keeps it out of scope.** Both HMRC
(0.1p) and Regulation 1103/97 Article 4(4) (a 3-decimal euro intermediate) legally require a
_higher-precision intermediate_ wherever a non-integer multiplier is applied. If conversion is ever
added, that intermediate is a requirement and not a refinement, and it is the point at which the
integer-minor-unit model stops being sufficient on its own.

## IEEE 754 decimal: a distraction, with one caveat kept

**RESEARCHED**: the standard's own §1.4 says _"This standard does not specify: Formats of
integers"_, and its scope clauses never mention money. For an application storing integer minor
units it is not relevant.

**The caveat is kept rather than dropped**, because it is the one place the research disagrees with
the convenient answer: Cowlishaw, the primary source for the decimal format's rationale,
explicitly criticises scaled integers as _"error-prone… hard to maintain"_. That criticism lands
squarely on this codebase **as it is today**: sixteen ad-hoc scale sites and four grammars. It lands
much more weakly on a single `Money` type. **So the critique is not an argument for decimal floating
point; it is an argument for the module**, and it is worth recording that the strongest available
authority against the chosen representation is answered by the design rather than ignored by it.

## Where the exponent list comes from

**RESEARCHED, and this is the one open question this note does not close.** The SIX licence position
is genuinely ambiguous rather than unresearched: the data page offers the lists "free of charge",
the site-wide terms say the content is copyright-protected and "exclusively for personal use", and
**no redistribution grant was found anywhere**. The npm `currency-codes` package cites _Wikipedia_
as its reference, which given the refutation above disqualifies it as an authority.

**The design's answer is to need the list as little as possible.** The exponent is stored per row,
taken from the provider or the user at write time, so no list is consulted on read. A list is needed
only to _validate_ a currency at write time, and validation can be a small curated set of the
currencies actually supported, checked into this repository with its own provenance, which is a
different and much smaller artifact than a vendored copy of ISO 4217. **A stored exponent is
precisely what turns a licensing question into a small one.**

## What money refuses

- **Conversion between currencies.** Firefly's precedent, already settled: a budget counts only its
  own currency, and a second amount is entered per currency rather than derived. **This refusal is
  what removes the rounding-mode decision, the rate-storage decision and the as-of-rate ambiguity in
  one move**, which is why it is the load-bearing refusal rather than a limitation.
- **Cross-currency aggregation.** Follows from the above. Sums are per currency, and a mixed sum is
  refused rather than approximated.
- **A global rounding mode.** No standard specifies one and the binding rules conflict. Allocation
  is the only division and it has its own settled rule.
- **Currencies with no exponent** (`N.A.`: XAU, XDR, the bond units, XTS, XXX). An amount whose
  minor unit is undefined cannot be stored as integer minor units, and pretending otherwise is the
  ambiguity the whole rule exists to prevent.
- **Deriving the exponent at read time**, from ISO, from CLDR or from `Intl`. The three
  measurements sit here rather than upstream, because refusing a source is the work they actually
  do. **RESEARCHED**: CLDR and ISO diverge on 15 current codes (IQD is ISO 3, CLDR 0), so a
  CLDR-derived exponent misreads stored rows. **RESEARCHED**: 13 codes carry the literal text `N.A.`
  rather than a number (XAU, XAG, XDR, XPT, XPD, the bond units, XTS, XXX), so an ISO-derived
  exponent has nothing to read for them. **MEASURED**: `Intl.NumberFormat` **never throws** on an
  unknown code: `BTC` and `ZZZ` both resolve to `maximumFractionDigits: 2`, so an `Intl`-derived
  exponent turns a typo or a crypto ticker into a silently wrong row. Each fails differently and
  only the third fails silently.
- **Not refused, contrary to this note's first draft: MRU and MGA.** ISO assigns both exponent 2 and
  integer minor units represent them exactly. The refusal was drafted on folklore and removed on
  measurement.

## What this form already allows

- **A multi-currency account**, and the dedupe key can express it because the currency is per amount.
- **A currency whose exponent the standard later revises**, without reinterpreting a single stored
  row.
- **A display exponent that differs from the storage exponent**: needed for the 15 codes where CLDR
  and ISO disagree, and for MRU's cash rounding, without either being a special case in storage.
- **Per-currency aggregates** on every screen, with no conversion and no rate.

---

# What would still force a 2.0 after this

Named now rather than discovered.

**Nothing on the two forms this note designs.** That is the finding, and it is stronger than
expected on the key side:

- **Money.** The rule holds: a currency field and an exponent field in one change. Everything else
  about multi-currency is a 1.x over rows that stay correct. The `Int` widening is a migration that
  preserves every value, so it is cost and not breakage, but it has to happen in the same window
  as the exponent, because the app's own net-worth cap does not fit at exponent 3.
- **The dedupe key.** **This was believed to be a 2.0-adjacent duplication event and it is not.**
  Measured: a full recompute from row columns with zero duplication events. The correction stands
  on its own: the audit's cost sentence and `safety.ts`'s "backfill was rejected as impossible"
  both generalise from v1→v2, where the _old key_ was unparseable, to a case where the _row_ is
  sufficient. Nobody asked the second question.

**Five things remain, and none is a 2.0. They are named because each is cheaper now than later.**

1. **The import has no destination account.** #449 does not close without one, and this note's key
   cannot close it alone. A 1.x feature, but it changes which bucket rows live in, so it wants the
   recompute to exist first.
2. **Widening the money columns.** `Int` → `BigInt` on eight columns. Value-preserving, therefore
   not breaking; expensive on a large table, therefore best before 1.0, and forced into the same
   window as the exponent, because the app's own net-worth cap does not fit at exponent 3.
3. **The restore path must recompute too.** `dedupeKey` is in the backup contract (**MEASURED**:
   `export.ts:106`, `schema.ts:291`, written verbatim at `import.ts:329`), so a backup taken before
   v3 and restored after it writes v2 keys into a v3 world, and those rows duplicate against
   everything. **MEASURED, the backup carries every input the recompute needs**:
   `accountId`, `date`, `label`, `amountCents`, `type` and `source`, including the `source` the
   recompute must branch on. This is not a new mechanism, it is the same recompute at a second call site, and it is
   before 1.0 because 1.0 is what freezes the backup format.
4. **`Transaction.type` is nullable and the backup schema allows null.** A row with a null type
   cannot be keyed. Decide it (null key, row invisible to dedup, which is the existing behaviour
   for manual transactions) rather than letting it fall through. **And count such rows on a real
   database before migrating**: the only figure this note has is from a fixture it created, which
   is worth nothing here.
5. **The date-provenance gap.** The connector's three-field fallback means a provider changing which
   date field it emits silently re-keys a history. Recording the provenance beside the row makes it
   diagnosable. Not breaking; invisible if skipped.

**And one honest uncertainty, which is not a 2.0 but is the thing most likely to become one.** The
provider-id branch of the key trusts Enable Banking's statement that `entry_reference` is immutable
_"for accounts with the same identification hashes"_. That is a vendor's promise about a vendor's
data, not a property of the standard, and the research found the standard guarantees nothing here.
If it turns out to be false in practice, the affected rows re-import once and the recompute cannot
help, because the input itself changed. **The mitigation is not a design change; it is to notice.**
A count of provider-id-keyed rows whose fingerprint matches an existing row would catch it, and
nothing today would.

---

# What the migration measured, and the two corrections it forced

Added when the columns landed, because a design note whose claims were never executed is a
proposal. Everything below was run.

**The widening forces `bigint` into TypeScript, and there is no schema-level escape.** **MEASURED**:
`Int @db.BigInt` is refused on all three connectors. Reads, aggregates and inputs on a `BigInt`
field are `bigint`, `bigint | null` and `bigint | number` respectively, so writes and filters need
nothing and only reads do. One `result` extension at `createPrismaClient` narrows the eight columns
back to `number`, which is sound because a `number` holds every integer to 2^53 exactly, about nine
million times the largest amount this application allows. The 64 bits are for the column, not for
the language.

**The extension seam holds, and it was verified rather than asserted.** Zero `new *PrismaClient(`
outside `client.ts`, and zero imports of a generated client anywhere else in the tree, so nothing
else CAN build one. **MEASURED**: the extension survives `findMany`, a narrow `select`, and an
interactive `$transaction` callback's `tx`. It does NOT survive `$queryRaw`, which returns a
`bigint` and typechecks as whatever the caller declares.

**The aggregate is a type lie, and it is the sharpest thing this piece found.** **MEASURED both
ways**: under the extension, `aggregate({ _sum: { amountCents: true } })` typechecks as
`number | null` and returns a `bigint`. The compile-time answer is the one that is wrong, so
`npm run check` reports clean over five sites that throw. They were found by reading and are gated
by a source scan calibrated on real instances, because the typechecker cannot be the detector for
a defect whose whole shape is that the typechecker is wrong.

**"A default is a value with no author" is literal on PostgreSQL.** **MEASURED on 17.10**:
`ADD COLUMN NOT NULL DEFAULT 2` leaves `pg_attribute.atthasmissing` true with `attmissingval = {2}`
and rewrites no row, so the value is synthesised on read and there is nothing in the row to correct.
The three-step used instead leaves `atthasmissing` false on all twelve new columns, and no column
default survives the migration on any engine.

**What a halfway failure leaves, per engine, and the correction.** **MEASURED on PostgreSQL 17.10**
with a unique-violation poison after the `Transaction` block: earlier statements stay committed,
`_prisma_migrations` records `finished_at` NULL, `rolled_back_at` NULL, `applied_steps_count` 0.
**The migration is NOT restartable**, which the first draft of its own header claimed it was:
`migrate resolve --rolled-back` then `migrate deploy` fails with 42701, "column already exists",
because `ADD COLUMN` is idempotent on no engine and SQLite's leg is a table rebuild. What the
`WHERE ... IS NULL` on each UPDATE buys is hand recovery without double-stamping, not re-running.
63 statements on SQLite, 37 on PostgreSQL, 27 on MySQL.

**The MariaDB shadow database, read rather than inferred from an exit code.** The ordinary user
fails with `P3014` wrapping `P1010`, exactly as recorded. Generated as root: five databases before,
the same five after, zero `prisma_migrate%` left behind.

**A security gap this piece opened and closed in the same change.** `Intl.NumberFormat` raises a
`RangeError` on any currency code that is not three ASCII letters. **MEASURED**: `AB`, `ABCD`, the
empty string, `ABC DEF` and `<script>` all throw; `ZZZ` and `BTC` do not. Threading a stored
currency into a display made that reachable, and the backup schema validated length only, which
break-checking shows caught 1 of 6 malformed codes. The grammar is now checked where untrusted
input crosses in and again in `money()`. Whether a code is KNOWN is deliberately still not checked:
that would need the list this design refuses to consult, and an unknown but well-formed code is
accepted, which is the calibration that keeps the six refusals meaningful.

**Two things a review caught that the first implementation got wrong, and both were about the same
mistake: treating "everything is euros today" as true when it already was not.**

The first: **the migration stamped every transaction `EUR`, and `Account.currency` has been
writable to a non-euro value since bank sync existed.** `banking/connectors/enablebanking.ts`
stores whatever the provider names. So an install with a sterling account would have had every one
of its transactions stamped with a currency it is not, where before the migration those rows
asserted nothing at all. Making a row newly WRONG is worse than leaving it silent, and the
information needed for the right answer was sitting in the account. All three legs now read it, and
`persistImportedTransactions` reads the bucket once before its loop so future writes agree.
**MEASURED on all three engines** with a populated database holding one euro bucket and one
sterling bucket: the sterling account's transaction is stamped `GBP`.

**The exponent is the honest limit and is stated rather than hidden.** No pre-existing row records
one and no list is consulted, so 2 is stamped for everything. Every currency this application has
actually seen has two decimals; a pre-change account in one of the seven 3-decimal currencies is
the one case the migration cannot recover, and nothing else could recover it either, because the
information was never written down.

The second: **the backup contract accepted a currency with no exponent beside it, which is exactly
the ambiguity this whole design exists to prevent**, and the comment beside it claimed `.strict()`
already forbade that. It does not: `.strict()` rejects unknown keys and says nothing about two
optional fields being independent. **MEASURED before the rule existed**: a payload naming `JOD` with
no exponent parsed successfully and the restore stamped it 2, so a row meaning 1.000 JOD came back
meaning 10.00 JOD, under a contract 1.0 freezes. Both-or-neither is now enforced on the five
money-bearing entities. `Account` is the exception and cannot be otherwise: its `currency` predates
the exponent column, so "currency present, exponent absent" is the shape of every backup ever
exported, and refusing it would make them all unrestorable.

**A third, smaller, in the same family.** The provider's currency was the one trust boundary left
without a check, and the asymmetry pointed the wrong way: the backup boundary enforces ISO 4217's
grammar, so a malformed code stored from a provider would surface as the user's OWN export refusing
to restore. It is now uppercased and validated at the connector, falling back to the default,
because a bucket denominated in the wrong currency is visible and correctable while one denominated
in a code no formatter can render takes the screen down.

**One deviation from "per amount", recorded rather than rounded away.** `TransactionSplit` carries
neither column. A part is denominated by its parent, and `sum(parts) = parent.amountCents` is a
conservation theorem a second currency would falsify. `NetWorthSnapshot` carries both even though
it always agrees with its account today, because a snapshot is a fact about the past and an account
is a verdict on the present.

---

# Corrections to the record

Collected so they are actionable rather than buried.

| Where                                   | Says                                                               | Measured                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-08-21-interface-audit.md`, Part 3 | a key change costs a duplication event, paid once per change       | **Zero.** A v3 key recomputes from row columns; 4 of 4 fresh keys matched on re-import                                                                                                                                          |
| `2026-08-21-interface-audit.md`, Part 7 | "19 sites divide by 100 across 18 non-spec files"                  | A `/ 100` grep also matches `/ 1000` and sweeps in percentage math. **16 scale sites across 13 files**, plus 7 grammar sites in 2 files the grep cannot see                                                                     |
| `utils/safety.ts:165`                   | "Backfill was rejected as impossible rather than expensive"        | True of v1→v2 (the old key was unparseable). **Not true in general**: the row is sufficient                                                                                                                                     |
| #449                                    | implies the remedy is passing `accountScope` from the CSV profiles | There is nothing to pass. The CSV bucket is per-profile, so both accounts at one bank share one `accountId`                                                                                                                     |
| The brief's Part B premise              | ten ISO codes carry two exponents                                  | **Refuted at the root.** `list-three.xml` has zero `CcyMnrUnts` elements. The claim was cited from memory of a Wikipedia template whose ten codes are ambiguous about **which row to select**, not about which exponent applies |
| The brief's Part B premise              | MRU/MGA may not be representable                                   | **Refuted.** ISO assigns both exponent 2; integer minor units represent them exactly                                                                                                                                            |
| The brief's Part B premise              | "nobody has decided rounding"                                      | Allocation is decided, implemented and proved (`allocation.ts:219`). Only a conversion mode is open, and refusing conversion closes it                                                                                          |

**And four corrections this note made to itself**, kept because the reasoning that produced each is
the reasoning a later session will produce again:

| First draft said                                     | Survived as                                                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "a v3 key can be rebuilt for **every** imported row" | Rebuilt for every **CSV** row (five profiles read); `enablebanking.ts:363` stores a different label from the one it keys on, so the recompute is source-conditional                     |
| "0 imported rows carry a NULL `type`"                | A fact about a fixture the probe had just created. The migration must **count** them on a real database first                                                                           |
| The key carries `currency` but not the exponent      | **Ruled in.** Magnitude plus currency does not identify an amount, because the exponent is stored per row precisely because the currency does not determine it                          |
| The exponent must be stored, "on four reasons"       | **One** reason: a stored row must not depend on a mutable list, and a withdrawn code has no published exponent. The other three constrain how a list is used and do not require storage |
| "no rounding mode is needed"                         | No rounding mode belongs in the **stored** form. `savingsGoal.ts:105` and `insights.ts:147` already produce fractional minor units for display                                          |

## Sources

- `docs/audits/research/transaction-identity.md`: ISO 20022 MDR Part 2 (camt.053.001.09), EPC132-08
  and EPC115-06, Firefly III and Actual Budget source, GoCardless and Enable Banking documentation.
- `docs/audits/research/iso4217-money.md`: SIX `list-one.xml` and `list-three.xml` (both
  `Pblshd="2026-01-01"`), ISO 20022 `CurrencyAmount` rule, EU Regulation 1103/97, HMRC VAT Notice
  700, IEEE 754 §1.4, Fowler's `allocate`.

Both carry their own READ / INFERRED / UNVERIFIED tags, and two traps worth knowing: EUR-Lex serves
HTTP 202 with an empty body to a naive fetch, which reads exactly like "the article does not exist",
and an inline-strings `.xlsx` has an empty `sharedStrings.xml`, so a first sweep of the ISO 20022
code sets searched nothing and returned a confident zero. Both were caught by calibrating on terms
known to be present.
