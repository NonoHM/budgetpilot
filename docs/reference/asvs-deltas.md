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
