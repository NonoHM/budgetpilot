# Glossary

The words this project uses for the things it handles, and what confusing them has cost.

**A glossary that lists words is a dictionary.** This one lists what happened when two things
shared a name, because that is the part a reader acts on. Every entry below is a term that was
ambiguous in the code at some point, not a term somebody thought might one day be unclear.

No implementation detail belongs here. Where a decision needs recording it goes in the commit that
made it or in [the design referential index](./docs/reference/design-referential.md); this file
holds vocabulary and nothing else.

---

## Import

A single run that read one statement file and wrote transactions. What a user deletes from
`/imports` is one import: its rows go, and their splits and tags go with them.

Two imports of one statement, minutes apart, is the ORDINARY shape of this product rather than an
edge case: it is what correcting a wrong column mapping produces. They agree on file name, profile,
period and all four counts. **The only attribute that tells them apart is the timestamp**, which is
why every control that names an import names it by that, to the second.

> **What confusing this cost.** A delete control was named « Supprimer &lt;fichier&gt; ». Both cards
> carried that name, so assistive technology could not tell them apart, and the control did not
> delete anything: it was a disclosure that revealed a second button. Filed as #380 and closed by
> naming the control after the timestamp.

## Delete, not cancel

Removing an import and its transactions. **The word is delete**, in every string a user reads and in
every catalogue key.

The route is still `?/cancel` and the redirect is still `?cancelled=1`. Those are addresses rather
than captions, and a bookmark is worth more than the consistency.

> **What confusing this cost.** The notice after a successful delete read « Import annulé », and the
> failure read « Annulation impossible ». Nothing was cancelled: an import was deleted, and every
> control on the path already said _Supprimer_. An action keeps one name through a whole flow, so a
> button that says Supprimer has to produce a message that says supprimé.

## Detected header row, and the declared one

Two different facts that used to share the name `hasHeaderRow`.

- **`detectedHeaderRow`** is what DETECTION guessed when the file was read. It lives on the payload
  the server sends to the designation screen, and `/import`'s action always sends it as `true`.
- **`hasHeaderRow`** is what the USER declared, with the switch above the column list. It lives on
  the submit and on the resolved file every component draws.

They are not interchangeable, and the type system now says so: the resolved file has no
`detectedHeaderRow` at all, so reading the guess where the declaration is meant does not compile.

> **What confusing this cost. This one ate a transaction.** The collision repost carried
> `pending.view.hasHeaderRow` where it meant the user's answer. Since the payload always says `true`,
> that hard-coded a header row back in: answering « Importer quand même » on a file the user had
> declared headerless made the server read its first line as a heading and drop it. The two reads sat
> two lines apart in one object literal. It survived the author's review and a full test suite, and
> was found by an outside reviewer, because every collision fixture in the repository kept the two
> values equal and a wrong read therefore agreed with a right one.

## Profile

The parser that read a statement: `generic`, `banque-populaire`, `revolut`, `maison`, `mapped`.

**It is a key, not a label.** The parsers dispatch on it, the fingerprint logic reads it, and it is
stored. What a user sees is a separate rendering, and `mapped` in particular has no meaning outside
the code: it names the profile that resolves its columns through a remembered correspondance rather
than through a header table.

> **What confusing this cost.** `/imports` printed the stored token verbatim, so a badge on the card
> read « MAPPED » twelve pixels above the block that explains what it means. Rendering it through a
> label also had to be measured rather than assumed: the first label was long enough to wrap the
> card's own timestamp onto two lines, and that timestamp is the one thing telling two imports apart.

## Correspondance

The stored mapping from a file's columns to the four roles, remembered per file shape so the next
statement of the same shape does not ask again. Fingerprinted over the header row.

A correspondance can be WRONG and still work: it names a column that parses and means something
else, so nothing is invalid, no count is off, and no banner appears. That is the case the whole
correction path exists for, and it is why the recap screen states two facts separately rather than
one pairing.

## Correction, and replacement

A **correction** re-imports a statement through a repaired correspondance. A **replacement** is what
the correction does to the import it was launched from: it deletes it, so the repair is one journey
rather than two.

The order is fixed by the deduplication key: correct first, delete second. The consent for the
deletion is asked in the designation footer, at the moment the user has changed the offending role
and reads how many rows will be imported.

## Collision

Two imports the application believes may be the same statement. Detected before a write by
fingerprint, and after the fact by comparing period, row count and totals.

It is stated as a possibility rather than a verdict: for an import already written the fingerprints
cannot be recomputed, so « the same statement twice » and « two statements agreeing on three
figures » are no longer distinguishable. The interface says _peut-être_ because that is what is
known.

## Pressed

The state a control shows while a finger or a pointer is on it. Distinct from **selected**
(`aria-pressed`, `aria-checked`), which is a value and survives the release.

Pressed never survives `pointerup`, is removed without delay by `pointercancel`, and carries no
`aria-*` at all. See [the design referential index](./docs/reference/design-referential.md) for where
its timing rule lives.
