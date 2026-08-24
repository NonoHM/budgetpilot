# ASVS deltas since the last re-derivation

**This is not a current state, and it does not compose with the published figure.** It is a
dated list of movements to individual ASVS 5.0.0 Level 2 verdicts made since the assessment
[SECURITY.md](../../SECURITY.md) pins. Adding these entries to that figure is arithmetic on two
things that do not compose: the figure is a count over one commit, each entry below is a change
to one row on a later commit, and nothing here re-checks the rows an entry does not name. The
only way to get a current count is to re-derive the whole assessment, which is what the next
re-derivation is for.

**Why it exists.** The full self-assessment is not tracked in this repository, so a wave that
moves a verdict used to record the movement in a pull request body, which stops being consulted
the moment it merges. The published count then drifts with nothing watching. This file is the
durable half: the count stays point-in-time and honest about it, and the movements since are
readable by anyone who reads the claim.

**How it is written.** Append only. A new entry goes at the top with its date, the change that
caused it, and one line of why. An entry is fixed once its change is merged: if a later wave
moves the same row again, that is a new entry rather than an edit, because the point of the file
is the sequence. Every row is cited by its identifier and quoted from the standard rather than
recalled, per the same rule the assessment itself is held to.

**Verdict letters**, as the assessment uses them: `A` met and verified by attack, `C` met by
construction, `X` an argued exception, `N/A` not applicable with a stated reason.

---

## 2026-08-24, the write paths that name an account

**Verdict letters below are quoted from `scripts/security/asvs-5.0-l2-report.md`, which describes
commit `d9c116c` as assessed on 2026-08-13**, eleven days and roughly twenty commits before this
branch. That report's own opening says a refactor the next morning can move any verdict and nothing
in the file would notice, so these are letters AS OF THAT ASSESSMENT rather than a current state.
`v5.0.0-8.2.2` and `v5.0.0-2.2.1` are **L1** rows, not L2; `v5.0.0-15.3.3` is L2.

Branch `feat/statement-account`, second half. The account a statement belongs to became something a
user chooses, which added four write paths that take an object reference from a browser: creating an
account from inside the import flow, renaming one, archiving or reactivating one, and linking one to
a net worth line. **No row's letter moves.** Three rows gain evidence, one of them with a stated
limit that makes it weaker than the sentence the assessment published, and that is written down
here rather than left for a re-derivation to discover.

### `v5.0.0-8.2.2`: four new id-bearing actions, and where they are guarded

> Verify that the application ensures that data-specific access is restricted to consumers with
> explicit permissions to specific data items to mitigate insecure direct object reference (IDOR)
> and broken object level authorization (BOLA).

Each of the four resolves its reference with `userId` in the **same** where clause rather than as a
check afterwards, and answers not-found for a reference that does not resolve, whether it is missing
or somebody else's. The two that update do it as an `updateMany` scoped by both columns and refuse
on a count of zero, so there is no window between reading a row and writing it.

**Asserted against a real engine, never only in a unit spec, and the reason is a measured green.**
A unit spec's fake decides what `findFirst` returns, so removing the ownership clause from the query
leaves it passing. That exact green happened earlier in this chantier, which is why the battery is
in `src/lib/server/accounts/manageStatementAccount.db-smoke.ts` and
`src/lib/server/import/resolveByChosenId.db-smoke.ts`. Break-checked by deleting the `userId` clause:
3 of 5 reddened on the resolution battery, and the two that stayed green are the calibration and a
case correctly indifferent to scoping, which a unit spec could not have told apart.

**STATED LIMIT, and it is a weakening of this row's published evidence rather than an addition to
it.** That evidence names `e2e/idor-two-account.spec.ts`, 23 id-bearing actions fired by a second
real account. These four are not among them. The property is asserted at the service layer against
a real database instead, which is a different and narrower thing: it proves the query is scoped, and
it does not prove the route reaches that query. Extending the two-account battery is the honest
follow-up and it is not in this change.

### `v5.0.0-15.3.3`: a one-field form is where nobody looks for mass assignment

> Verify that the application has countermeasures to protect against mass assignment attacks by
> limiting allowed fields per controller and action, e.g., it is not possible to insert or update a
> field value when it was not intended to be part of that action.

The rename form owns one field and the create sheet owns one field, which is exactly the shape that
gets waved through. `Account` carries five columns a request must not set: `source`, `discriminant`,
`netWorthAccountId`, `archivedAt` and `institution`. Each action reads its named fields out of
`FormData` and passes them to a service whose write is enumerated at the call, so a posted `source`
is inert because nothing reads it, not because a deny list refuses it.

**Positive rather than negative, deliberately.** A deny list has to be complete, and completeness is
a property nobody can check on the day a column is added. The rename service writes `name` and
`nameKey`; the archive service writes `archivedAt`; the link service writes `netWorthAccountId`.
Asserted rather than described: the tests post the forbidden fields and read the row back.

### `v5.0.0-2.2.1`: the net worth link validates positively against an allow list

> Verify that input is validated to enforce business or functional expectations for that input. This
> should either use positive validation against an allow list of values, patterns, and ranges, or be
> based on comparing the input to an expected structure and logical limits according to predefined
> rules.

A net worth line has a type, and only some types are a thing a statement can be about. The link
calls `isLinkableNetWorthAccountType` rather than retyping its list, so the one definition of that
rule serves the savings goals that already used it and this. A house is not a cash line, and filing a
statement's transactions against one would put spending into an asset's balance.

A null clears the link and needs no lookup, because there is no reference to authorise.

### The chapters checked with nothing to add

Stated rather than left silent, because a change that adds four write paths and cites no row is
indistinguishable from one that did not look.

- **V6 authentication and V7 session management**: nothing here touches a credential or a session.
- **V11 cryptography**: no cipher was added, and the identifier fragment is stored as it is read.
- **V16 logging**: nothing on these paths logs. The refusal sentences carry an account NAME, which
  is the user's own word for their own account, and no fragment.
- **V14 data protection**: the fragment's classification is the 2026-08-22 entry above, unchanged.
  These paths read it and never widen where it goes.

`v5.0.0-3.7.2` and `v5.0.0-1.2.2` are the redirect rows a reader might expect from a form that
navigates on success. They do not apply: every one of these actions redirects to a path this
application owns, built from a constant rather than from input.

## 2026-08-22, the account identifier fragment and the backup

**Verdict letters below are quoted from `scripts/security/asvs-5.0-l2-report.md`, which describes
commit `d9c116c` as assessed on 2026-08-13**, nine days and roughly fifteen commits before this
branch. That report's own opening says a refactor the next morning can move any verdict and nothing
in the file would notice, so these are letters AS OF THAT ASSESSMENT rather than a current state.
Two rows the branch's design notes called L2 are in fact L1: `v5.0.0-14.2.1` and `v5.0.0-8.2.2`.

Branch `feat/statement-account`. Reading a statement now keeps at most four characters from the
end of the IBAN or account number it names (`Account.discriminant`), so a bucket can be shown as
`···4417` and recognised again from the same file shape (`ImportSourceSignature.discriminant`).
That is a new sensitive data class, and this entry is the backup half of it: the plaintext export
does not carry it. **No row's letter moves.** Two rows gain evidence toward a future re-derivation
and stay `X`, one is a constraint the change had to satisfy, and one is named only to refuse it.
Stated that way deliberately: a delta whose entries all read as movements inflates the published
figure by accumulation, which is the arithmetic this file's own header forbids.

### `v5.0.0-14.1.1`: a new data class, classified in the change that created it, row stays `X`

> Verify that all sensitive data created and processed by the application has been identified and
> classified into protection levels. This includes data that is only encoded and therefore easily
> decoded, such as Base64 strings or the plaintext payload inside a JWT. Protection levels need to
> take into account any data protection and privacy regulations and standards which the
> application is required to comply with.

**Why it moves rather than staying still.** The row is about the inventory, so a class that arrives
unclassified breaks it even though nothing about the old classes changed. Four characters are not a
payment instrument and are not an account number; among ONE HOLDER'S OWN accounts they are exactly
the attribute that tells two of them apart, which is the whole reason the app keeps them. The
protection level assigned is: at rest and on screen in the single form `···4417`, never in a log
line, a telemetry event, a crash breadcrumb or an error message, and never in an export. It is
written at the column (`prisma/schema.prisma`), at the export contract
(`src/lib/server/backup/schema.ts`) and on the user-facing page
(`docs/reference/backup-restore.md`), rather than in one place a reader has to already know about.

### `v5.0.0-14.2.4`: the control implemented at the export, and the row STAYS `X`

> Verify that controls around sensitive data related to encryption, integrity verification,
> retention, how the data is to be logged, access controls around sensitive data in logs, privacy
> and privacy-enhancing technologies, are implemented as defined in the documentation for the
> specific data's protection level.

**CORRECTED before merge: this row does not move, and the reason is two rows away.** The first
draft of this entry claimed `C`, met by construction. The assessment's own evidence for this row
refuses that: it is marked `X` because « the requirement asks whether controls are implemented AS
DEFINED IN the documentation for each protection level, and `v5.0.0-14.1.2` establishes there is no
such documentation. The controls exist; the specification they should conform to does not. » This
change writes a protection level for ONE class. It does not create the documented set of protection
requirements `14.1.2` asks for, so the precondition that makes this row unevaluable is untouched and
the row stays `X`. What follows is progress toward it, recorded as such, not a closure.

**The same correction applies to `14.1.1` above: it stays `X` too.** That row asks that ALL
sensitive data be identified and classified, and its recorded evidence is « No data classification
exists ». One class now does. That is one item, not an inventory, and an entry that reads as a
movement where the letter has not moved is the drift this file exists to prevent.

**The measurement that decided the design, made before the design.** There is no encryption of any
kind under `src/lib/server/backup/`: no cipher, no passphrase, no key derivation. The only
occurrences of the word are `credentialsEncrypted`, a column the export already refuses to carry.
So the export is plaintext JSON the user downloads and stores wherever they store files, and the
protection level above cannot be honoured by anything except not writing the value.

**What implements it.** `Account.discriminant` is absent from the export's account schema, and the
memory table is filtered at the QUERY (`where: { userId, discriminant: null }`) rather than mapped
afterwards, so a fragment is never read out of the database into this process at all. `.strict()`
on both objects makes it an interdict in both directions: no export writes one, and a hand-edited
file cannot smuggle one back in. Five break-checks, each reverted in a `finally`: adding
`discriminant: true` to the account select reddens 4 of the 5 new tests, dropping the query filter
reddens 3, and the calibration run before them is 0 failed / 5 passed.

**The compromise that was available and is refused in writing, at the code.** Exporting every
signature with its `discriminant` nulled out keeps the whole memory and none of the fragments, and
it is unsafe for a reason that lives two models away: two rows of one user that share a fingerprint
and differ only by fragment collapse onto one key, so a restore either violates
`@@unique([userId, fingerprint, discriminant])` mid-transaction, which on PostgreSQL takes the
whole restore with it, or lands two rows a later read cannot choose between and the memory then
answers with an arbitrary account. A wrong answer replayed for ever, manufactured by the backup.

### `v5.0.0-16.2.5`: a constraint the new refusal message had to satisfy

> Verify that when logging sensitive data, the application enforces logging based on the data's
> protection level. For example, it may not be allowed to log certain data, such as credentials or
> payment details. Other data, such as session tokens, may only be logged by being hashed or
> masked, either in full or partially.

Not a movement. The restore gained one refusal, for a memory naming an account the file does not
carry, and a refusal message is exactly the thing that travels: through a screenshot, a support
ticket and a clipboard. It names the first 12 characters of the header FINGERPRINT, which is a hash
of a bank's public column names and identifies a file shape rather than a person, the same handle
the duplicate-mapping refusal already uses. The payload carries no fragment for it to name, which
is the property above doing the work rather than a second rule.

### The chapters checked with nothing to add, and one row refused by name

Stated rather than left silent, because a change that touches an export and cites no row is
indistinguishable from one that did not look. V6 authentication, V7 session management, V8
authorization and V11 cryptography were read against this change: the export is still scoped by an
explicit `userId` on every query and the restore still writes only into the account performing it,
nothing here touches a session or a credential, and no cipher was added.

`v5.0.0-14.2.3` ("Verify that defined sensitive data is not sent to untrusted parties (e.g., user
trackers)...") is the row a reader might expect and it does NOT apply: a backup goes to the account
that asked for it, which is not a third party. Citing it would make this change look larger than it
is and devalue the citations that are real.

## 2026-08-22, version 3 of the deduplication key

Branch `feat/dedupe-key-v3`. The key that decides whether an imported transaction is one you
already have gains the account it lands on and the currency and exponent its amount is in, and
every field is now delimiter-encoded. Two rows move and one is a constraint restated.

### `v5.0.0-1.3.3`: `X` an argued exception at one site, to `C` met by construction

> Verify that data being passed to a potentially dangerous context is sanitized beforehand to
> enforce safety measures, such as only allowing characters which are safe for this context and
> trimming input which is too long.

**Why it moves, and the honest half is that the site was worse than the previous assessment
recorded.** The deduplication key is a delimited string whose structure decides identity, so a
field that can contain the delimiter can change the structure. The content branch was safe by an
argument: every field after the label was delimiter-free by its own grammar, so the boundaries were
recoverable from the right. That argument was nowhere in the tree, and the provider branch did not
satisfy it at all. `enablebanking:<providerAccountId>:<entryReference>` joined **two
provider-supplied values** with a colon both can contain, so `("a", "b:c")` and `("a:b", "c")`
produced one key. **Two real transactions then hold one identity and the second is dropped
silently**, which is the failure direction this repository has refused twice in writing.

Pre-existing rather than introduced: the v2 key had the same shape. Found by attacking the plan
rather than by anything failing.

**What closes it.** Every variable field is percent-encoded before it is joined, escape first, so
the map from fields to key is injective by construction rather than by an argument that has to be
re-derived each time a field is added. `import/dedupeKeyInjectivity.spec.ts` asserts it as a
property, calibrated against the pre-fix builder so a clean run means something: seed 20260822,
5 000 runs, the calibration finds `enablebanking:a:b:c` from `("a:b", "c")` against `("a", "b:c")`
and the current format finds nothing.

### `v5.0.0-2.2.1`: `C` met by construction, unchanged, at a site that did not meet it

> Verify that input is validated to enforce business or functional expectations for that input.
> This should either use positive validation against an allow list of values, patterns, and ranges,
> or be based on comparing the input to an expected structure and logical limits according to
> predefined rules.

**Not a movement, a repair.** The guard deciding whether a row can be keyed tested `type === null`.
`Transaction.type` is `string | null` in the database, so a null check reads as sufficient and is
not: an untyped caller reaches it with `undefined` and an older row can hold any string, and both
were interpolated straight into the key. A row with no direction produced a key reading
`...|undefined`, and every such row deduplicated against every other one. It is an allowlist of
`income | expense` now, and a row outside it is left unkeyed rather than wrongly matched. Caught by
a test, not by review.

### `v5.0.0-16.2.5`: a constraint the new boot pass had to satisfy

> Verify that when logging sensitive data, the application enforces logging based on the data's
> protection level. For example, it may not be allowed to log certain data, such as credentials or
> payment details.

A deduplication key contains the transaction's own label, which is a merchant name and therefore
personal financial data. The boot recompute reports progress per batch, because a boot that takes a
minute with no output is indistinguishable from a hung one and `docker compose up -d` gives an
operator no other window onto it. It reports counts only.

**The test asserting that could not fail when it was written**, and the correction is the entry: it
looked for `Docteur` in a message that would have carried the FOLDED `docteur fictif`, so appending
the whole key to the progress line gave 0 red across all sixteen tests. It folds both sides now and
also refuses anything containing the version marker, which is the general form rather than a list
of the strings one fixture happens to use.

### `v5.0.0-1.5.2`: two new sites, both met by construction

> Verify that deserialization of untrusted data enforces safe input handling, such as using an
> allowlist of object types or restricting client-defined object types, to prevent deserialization
> attacks.

The recompute reads the provider's entry reference out of `metadataJson`, which is a free-form
column a restore can fill from a file the user hands us, validated as a bounded string and never as
a shape. Both readers (`backup/import.ts` and `import/dedupeRecomputeBackfill.ts`) parse it inside a
`try`, refuse anything that is not a non-empty string, and fall back to the content branch. A throw
in the boot reader would take the instance down over a cell nothing else reads.

### The chapters checked with nothing to add

Stated rather than left silent, because a change that rewrites a stored identifier and cites no row
is indistinguishable from one that did not look. V3 web frontend, V4 API, V6 authentication, V7
session management, V8 authorization, V11 cryptography and V14 data protection were read against
this branch and none moves. Nothing here touches a session, a credential, a cipher or an
authorization decision; the recompute is scoped by `Account`, which belongs to one user, and every
entry point takes an explicit `userId` from `requireUser`.

And plainly: ASVS has nothing to say about whether a re-imported export creates a second copy of a
transaction. That is #464 and it is a correctness defect, not a security one. Dressing it in a row
would devalue every other citation in the assessment.

## 2026-08-17, the import correction that replaces the batch it corrects

Branch `feat/import-correction-replaces-batch`, at `a9f2a39` on that branch. A correction
launched from an existing import now deletes that import once the corrected rows are written,
which removes a state where an account held double its transactions. Two rows move.

### `v5.0.0-2.3.3`: `A` met, to `X` an argued exception at one site

> Verify that transactions are being used at the business logic level such that either a
> business logic operation succeeds in its entirety or it is rolled back to the previous correct
> state.

**Why it moves.** "Replace this import" is one business operation and it is not all-or-none. The
delete is a `prisma.$transaction`; the write that precedes it cannot be inside one at all, and
the reason is documented at `src/lib/server/import/persist.ts:288-295`: the row writer relies on
catching a unique violation and carrying on with the next row, and on PostgreSQL a constraint
violation aborts the enclosing transaction, so wrapping the import would turn one duplicate row
into a failed import. There is therefore no single transaction that can hold both halves, and a
crash between them leaves both imports present.

**The argument for the exception rather than an issue.** The ordering is the control, and it was
chosen for its failure mode: write, then delete. A crash between the two leaves the user with two
imports and a delete they can perform themselves, from a screen that now names each import by its
timestamp. The reverse ordering, delete then write, fails by destroying rows that the write might
then not produce, and that is unrepairable. So the operation is not atomic, and the non-atomic
state it can reach is the recoverable one by construction rather than by luck. The site is named
in the docstring on the replace block in `src/routes/import/columns/+page.server.ts`, together
with this argument, so the reason travels with the code rather than only here.

**What would close it.** Not a signature change: the constraint above says the write must stay
outside a transaction, so atomicity would have to come from somewhere else entirely, such as
writing into a staging batch and promoting it by an id swap. Not attempted in this wave.

### `v5.0.0-16.3.3`: exception enlarges

> Verify that the application logs the security events that are defined in the documentation and
> also logs attempts to bypass the security controls, such as input validation, business logic,
> and anti-automation.

**Why it enlarges.** The exception previously covered attempts to bypass a control: a rate
limiter tripping, an origin check refusing a POST, an input validation rejecting a row, all
silent. This wave adds a path on which an authorised, irreversible destruction of a user's own
data is equally silent. An import deleted by its owner, whether from the confirmation on
`/imports` or automatically as part of a correction, leaves no record that it existed, so an
operator answering "where did these transactions go" has nothing to read. That is a different
kind of gap from an unlogged bypass attempt and it is now inside the same exception.

Recorded on [#250](https://github.com/NonoHM/budgetpilot/issues/250), which covers the class.

### The chapters checked with nothing to add

Stated rather than left silent, because a wave that adds a delete path and cites no row is
indistinguishable from a wave that did not look. V1 encoding, V3 session management, V4 access
control, V6 authentication, V8 authorization and V11 cryptography were read against this wave's
changes and none of them moves: the delete is scoped by `userId` on a `findFirst` before it runs,
which is the control V4 already counts, and nothing here touches a session, a credential or a
cipher.

And plainly, because the temptation runs the other way: ASVS has nothing to say about the step
count of a repair, the tint of a confirmation dialog, or whether a destructive control arrives
pre-ticked. Dressing those in a row would devalue every other citation in the assessment.
