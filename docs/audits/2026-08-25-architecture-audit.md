# The architecture audit: one rule, more than one place

Read-only audit run 2026-08-25 against `main` at `c6c59d5`. **Nothing in the application was
changed while it ran, and no branch was opened.** What came out of it is listed at the end.

## Why it was narrow

The interface audit (`2026-08-21-interface-audit.md`) already answered the question that decides
1.0: nothing forces a 2.0. Stored forms are frozen, the backup is versioned, the dedupe key
recomputes. So this audit asked two questions instead of "is the architecture good", because these
are the two shapes that have actually cost this project:

1. **Where does the same rule live in more than one place?** #501 was one: `net-worth/service.ts`
   documented D4 as enforced and `/settings` walked around it. #507 is the drift beside it.
2. **Where does a rule exist that nothing enforces?** A rule written where nothing checks it is a
   preference.

A third question was asked of the component layer: what exists twice, and what exists at all.

Deliberately out of scope, because each has its own document and re-reading it produces noise: the
interface surfaces, the stored forms, the ASVS row-by-row map.

## How to read this

Every claim carries one of two marks, for the same reason the interface audit's do.

- **MEASURED** means a command was run in this session and its output is quoted or summarised here.
- **READ** means the source was opened and the claim is what it says. No execution.

Enumerations use `git ls-files` rather than filesystem globs, because leftover worktrees under
`.claude/worktrees/` make a whole-tree glob return several copies of the tree.

Where a question was of the form "every site that does X", it was asked with Serena rather than
with a text search, per `AGENTS.md`. The `persist.ts` trace in Part 4 is the case where that
mattered: the answer is a caller set, and a grep would have reported where it looked.

## Two corrections to figures this audit was given

Both are stated rather than silently fixed, because the way each was wrong is the reusable part.

| Given                                               | Measured        | How it was wrong                                                                                                                                                                                                        |
| --------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The eight native date inputs"                      | **5**           | Quoted rather than re-run. Three were fixed between the count and the audit, #495 among them. The repo's own current figure agrees: `DateField.svelte:63` says "the five single-date sites", and #497 is filed on five. |
| "#501 found five writers where the issue named two" | **9**, per #502 | Not a figure this audit produced, and not one it re-ran either. Recorded here only so the next reader takes it from #502, which is the document that counted.                                                           |

The first is the `CLAUDE.md` recorded-figure failure in its ordinary form: a number that was right
when it was read, quoted later as a fact about now. The tell was cheap and was available before any
sweep ran, which is what makes it worth writing down: **the component that replaced those inputs
states its own count in its own docstring**, so the disagreement surfaced by opening the file the
finding is about rather than by any clever enumeration.

---

## Part 1: rules with more than one enforcement site

### 1.1 The password policy is written at nine sites, one of which is the definition

**MEASURED.** `git grep` for the literal over `src`, non-spec.

`src/lib/server/auth.ts:96` defines it:

```ts
export function validatePassword(value: string): boolean {
	return value.length >= 12 && value.length <= 256;
}
```

Three server doors write a user-chosen password. Two call the function:

- `src/routes/register/+page.server.ts:131`
- `src/routes/force-password-change/+page.server.ts:34`

The third retypes the literal:

- `src/routes/settings/+page.server.ts:181`, `newPassword.length < 12 || newPassword.length > 256`

Six client affordances carry the floor as a literal too: `settings/+page.svelte:190`, `:194`,
`:1539`, `:1556`, `force-password-change/+page.svelte:48`, `:55`, `register/+page.svelte:44`.

A fourth writer, `routes/admin/+page.server.ts:114`, hashes a generated password rather than a
chosen one, so it is out of scope by construction. **READ:** `auth.ts:99-101` says so, and pins the
generator's size to `validatePassword`'s minimum through a test.

**Do they agree today?** Yes, and at the boundary rather than approximately: `>= 12 && <= 256`
accepts exactly what `< 12 || > 256` rejects the complement of. Checked as a pair rather than by
reading each side, because two correct-looking inequalities is how an off-by-one survives.

**Has it caused a defect?** No.

**Why it is drift and not risk.** All three doors validate server-side, so ASVS 5.0.0 V6.2 is
satisfied at every one of them. The exposure is a future tightening: a character-class rule or a
raised floor added to `validatePassword` reaches `/register` and `/force-password-change` and
silently does not reach `/settings`. The six client sites are affordances, and `AGENTS.md` already
says an affordance is not a control, so their divergence would produce a false promise on a screen
rather than a hole.

### 1.2 The rule-eligibility predicate is written three times inside one file

**READ.** `src/lib/server/categorization/rules.ts`.

`{ userId, manualCategory: null, splits: { none: {} } }` appears at:

- `:236`, the preview scan
- `:303-313`, the apply scan
- `:339-345`, the apply write, plus `natureManual: null` when a nature is being set

The coupling is held by a comment rather than by a function. `:231-235`:

> Same `splits: { none: {} }` as applyCategoryRules, and it has to be the same or the preview is a
> false promise.

**Do they agree today?** Yes.

**Has it caused a defect?** The sibling predicate did. The rule-liveness filter `isRuleTargetLive`
is written at three sites too (`rules.ts:219`, `rules.ts:291`,
`routes/transactions/+page.server.ts:188`), and the third one was added because #161 shipped
without it. The comment at `transactions/+page.server.ts:183-184` names why it was missed:
"nothing here looked like a rules engine".

That is the whole argument for this section. The predicate was correct at two sites and the third
site was somewhere nobody thought to look, because the third site was a page that writes nothing.

### 1.3 "Today" is the server's date, stated twice and violated at three client sites

**READ** for the rule, **MEASURED** for the sites.

The rule, with its reason and its cost, at `src/lib/components/UpcomingBillsCard.svelte:40-43` and
`src/routes/upcoming-bills/+page.svelte:154-155`:

> Whole days from the SERVER's `todayIso`. Never `new Date()`: a browser west of Greenwich can
> already be on the next UTC day while the server-computed statuses are not.

Honoured by `/transactions` (`+page.server.ts:550` hands `todayIso` down), by both upcoming-bills
surfaces, and by `src/lib/domain/periodPresets.ts:9`, which makes the parameter the rule:

> `todayIso` is a parameter, never a clock read inside this module.

Violated at three client sites, each reading the clock for itself:

| Site                                                  | What the value feeds                                         |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `src/routes/net-worth/+page.svelte:96`                | `max` on the `asOfDate` inputs at `:455`, `:561`             |
| `src/routes/imports/bank-connections/+page.svelte:70` | `max` on the `asOfDate` input at `:756`                      |
| `src/routes/+page.svelte:189`                         | the submitted default of the manual-add date field at `:785` |

**Do they agree?** No, and the net-worth pair is the one where the disagreement is legible.
`src/lib/server/net-worth/service.ts:481` reads the clock a second time, server-side, and compares:

```ts
const todayIso = new Date().toISOString().slice(0, 10);
if (raw > todayIso) return null;
if (raw === todayIso) return undefined;
```

Two independent clock reads of one quantity, one at render and one at submit. A submission
straddling UTC midnight has `raw === N` while the server has moved to `N + 1`, so the branch that
means "as of now" is missed and the snapshot is stamped `N` at 12:00:00Z instead. The `undefined`
return exists precisely to avoid that stamping, and the race routes around it.

**Has it caused a defect?** No, and it needs a midnight straddle to reach.

**MEASURED, and it is why the dashboard site is the odd one:** `src/routes/+page.server.ts`
contains no `todayIso` and no `today`, so `getTodayDate()` at `+page.svelte:189` is not a duplicate
of an available server value. It is the only source that page has. Which makes it the cheapest of
the three to fix and the one whose fix has to add something rather than delete something.

### 1.4 Ownership checked after the query rather than in it, at two sites

**MEASURED.** 203 Prisma read calls scanned across `src` outside specs and db-smokes. Two carry a
post-hoc ownership comparison:

- `src/routes/settings/+page.server.ts:267`, `if (!target || target.userId !== user.id)`
- `src/lib/server/banking/sync/service.ts:230`, `if (!request || request.userId !== input.userId)`

`AGENTS.md` names the shape it wants instead: the lookup "names `userId` in the SAME where clause,
never as a check afterwards".

**Do they agree with the rule?** No. **Do they do the right thing?** Yes, both. Each refuses with
an undifferentiated not-found, and each subsequent write is re-scoped: `settings:275` carries
`userId` on the `updateMany`. The session read at `:263` does pull another user's `tokenHash` into
memory before the check, which is a session internal, but it never leaves the process.

**Has it caused a defect?** No.

### 1.5 Soft delete, fifteen sites, no shared helper, no drift

**MEASURED.** Two models carry `deletedAt`: `NetWorthAccount` and `SavingsGoal`
(`prisma/schema.prisma:954`, `:1043`). Every read of either was enumerated and its where clause
read:

- `net-worth/service.ts` at `:49`, `:81`, `:140`, `:209`, `:262`, `:330`, `:419`
- `savings-goals/service.ts` at `:51`, `:130`, `:179`, `:205`, `:220`, `:261`
- `net-worth/link.ts:97`

Every one carries the filter. The two `updateMany` calls that do not (`service.ts:146`, `:395`) are
each guarded by a read in the same transaction. The two omissions in `backup/export.ts` are
deliberate and documented in place at `:153` and `:179-181`, and they disagree with each other on
purpose: soft-deleted net worth accounts round-trip so their snapshot history survives a restore,
soft-deleted goals do not because they have no dependent history.

**A rule at fifteen sites with zero drift and a written reason for each exception is not a
finding.** It is recorded here so the next sweep does not spend a session rediscovering it.

---

## Part 2: rules stated where nothing checks them

### 2.1 `AGENTS.md` asserts a CSP property the configuration stopped having in July

**READ**, both documents. **MEASURED**, the dates.

`AGENTS.md`, under "Security boundaries":

> CSP is nonce-based with no `'unsafe-inline'` in `script-src` or `style-src`. A dynamic `style=""`
> is silently blocked; use classes or Svelte's `style:`.

`svelte.config.js:61`:

```js
'style-src-attr': ['unsafe-inline'],
```

`style-src-attr` governs the style attribute specifically, so the second sentence is false: a
dynamic `style=""` is permitted and has been since #57.

**MEASURED, the order.** `git log -S` puts the AGENTS.md sentence in **#44** and `style-src-attr` in
**#57**, dated 2026-07-29. The guide was written first and the change that falsified it landed
after, with nothing to notice.

**The consequence, which is what makes it worth fixing rather than only correcting.**
`src/lib/domain/widthClass.ts` holds **101 hand-written Tailwind class names**, `w-[0%]` through
`w-[100%]`, written out literally because Tailwind's scanner only sees verbatim text. Its own
opening comment states the reason:

> incompatible with a `style-src` CSP that has no `unsafe-inline`

That constraint no longer binds style attributes. `DonutChart.svelte:33-35` carries a second
workaround of the same vintage, routing colour through SVG presentation attributes for the same
reason.

### 2.2 The configuration's own justification is falsified by a component added after it

**READ**, then **MEASURED**.

`svelte.config.js:49-54` justifies the exception:

> Needed because the remaining inline style attributes all come from dependencies, not from this
> app: SvelteKit hardcodes one on its `#svelte-announcer` live region, and bits-ui hides its helper
> inputs with svelte-toolbelt's `srOnlyStyles`.

**MEASURED:** three app-authored dynamic `style=""` attributes now exist, all in
`src/lib/components/import/FilePreviewTable.svelte`, at `:160`, `:184` and `:223`. That file was
added in **#367**, after #57. The justification was true when written.

This is the `CLAUDE.md` comment-rot family in the position that entry says is the dangerous one: a
**why**-comment, load-bearing, trusted because it justifies, and never re-read because the **what**
around it did not change.

### 2.3 The domain-purity rule has two violations and no gate

**MEASURED.** 42 non-spec files under `src/lib/domain/`. `AGENTS.md`:

> `src/lib/domain/` pure logic, no `$lib/server`, `$app/*` or Prisma imports.

Two violate it:

- `src/lib/domain/importSummary.ts:1`, from `$lib/server/import/refusals`
- `src/lib/domain/takeawayLabels.ts:2`, from `$lib/server/reports/monthly`

**Both are `import type`**, so they erase at build and create no runtime dependency. Stated rather
than omitted, because it is the difference between a layering violation and a naming one. Nothing
checks either way.

Eleven domain files import `$lib/paraglide`, which the rule does not forbid and this audit did not
treat as a finding. Two of those, `budget.ts:4` and `typography.ts:1`, import `getLocale`, which is
the ambient-locale shape `CLAUDE.md` records `domain/money.ts` failing on at container startup.
Neither is on a stored-and-recomputed path, so the narrow rule in `AGENTS.md` under "Code style"
does not reach them. Recorded, not filed.

### 2.4 A comment promises a scope the action does not have

**READ.** `src/routes/transactions/+page.server.ts:238-240`:

> it's scoped to the already-fetched, `FOCUS_STACK_CAP`-bounded stack ... the "accept all" button
> only ever acts on that same stack anyway.

**MEASURED.** `FOCUS_STACK_CAP = 5000` (`:76`), applied as `take` at `:234`. `classifiableCount` is
computed over those rows at `:241-245` and rendered on the control as
`m.transactions_accept_all({ count })` at `+page.svelte:1812` and `:1887`, which reads "Accept all
({count} reliable)".

The action does not act on that stack. `classifyAll` at `:959` calls
`applyCategoryRules(user.id, { categoryId })`, whose own scan is a batched walk with no id list and
no cap. Above 5 000 uncategorized rows the label under-reports what the press does.

**Has it caused a defect?** Not observed, and it needs more than 5 000 uncategorized transactions.

### 2.5 A prop that is carried and not enforced, and says so

**READ**, and **MEASURED** for the caller count.

`src/lib/components/ui/DateField.svelte:55-66` documents its `max` prop as "carried, not enforced,
and that is a gap rather than a design", and corrects an earlier version of its own sentence that
called it "advisory only, exactly as the native `max` was", which was false.

**MEASURED:** zero of the six `DateField` call sites pass `max`. So the gap is real and unreachable,
exactly as the docstring claims.

Recorded as a negative result about the documentation rather than as a finding: this is what a
correctly stated unenforced rule looks like, and it is the control case for the four above.

---

## Part 3: components that exist twice, or not at all

### 3.1 Two components have no references anywhere in the tree

**MEASURED.** Every `.svelte` under `src/lib/components/` was counted for importers by matching the
import specifier, excluding the file itself. Two came back at zero, and a second pass grepping the
bare name across `src`, `e2e`, `docs` and `scripts` confirmed **zero hits of any kind**:

- `src/lib/components/ActionCard.svelte`
- `src/lib/components/SettingsSection.svelte`

Both date to `617e274`, the initial public release, and neither has been touched since.

**The calibration matters here**, because a zero from an import-specifier match is exactly the
confident zero `CLAUDE.md` records six instances of. The same command returned 1 for
`ui/__fixtures__/ComboboxInForm.svelte`, a fixture imported once by
`Combobox.svelte.spec.ts:5`, which is the smallest true positive the tree contains. A detector that
finds the one-importer case is one whose zero means something.

**Not merely unused.** `src/routes/settings/+page.svelte:287` builds
``const card = `${cardBase} p-5` `` inline, which is byte-identical to `SettingsSection`'s own
default `sectionClasses`, and uses it at ten sites. The comment above it says the pattern is
"already used by /rules, /categories".

### 3.2 The newest brick is not in the referential, and the divergence has already happened

**MEASURED.** `DateField.svelte` shipped in **#495**, commit `fab3633`, three commits before this
audit's HEAD. `grep -c DateField docs/reference/design-referential.md` returns **0**. The
referential was last touched in **#397**, two chantiers earlier.

**MEASURED, the consequence:** `src/routes/+page.svelte` imports `DateField` at `:18` and renders a
native `<input type="date">` at `:784`. Same file, both ways.

That is the referential's own stated failure mode, from its own preamble:

> A registration nobody can reach registers nothing. The next screen needing a pressed state had no
> way to discover that one had been decided.

Filed as a process finding rather than a missing row. The row is the symptom.

### 3.3 Brick 1 is hand-rolled at three sites, and the copies lack the press

**MEASURED.** `src/lib/components/ui/IconButton.svelte` is brick 1. Three sites reproduce its class
string inline rather than using it:

- `src/routes/upcoming-bills/+page.svelte:859` and `:879`, character-identical to its neutral-circle
  string
- `src/routes/settings/+page.svelte:1103`, its danger-circle string, under a comment that restates
  brick 1's own tone clause

A fourth, `upcoming-bills/+page.svelte:1079`, passes the same string as a dropdown `triggerClass`,
where a component cannot be substituted.

**Do they agree?** No. **MEASURED:** `use:pressable` appears in exactly seven components
(`Button`, `CheckboxField`, `IconButton`, `ListCard`, `RangeCalendar`, `SwitchRow`, `TapLink`), and
none of the three copies is one. So each is missing the pressed state that Wave 5 Planche 5a
registered, along with its 120 ms minimum-display and pointercancel clauses, which live in
`$lib/press.ts` and cannot be expressed in a class string at all.

**Has it caused a defect?** No, and #392 already closed the gate for this as 14 exceptions of 18 on
day one.

### 3.4 What is centralised, measured rather than assumed

The negative results, which no issue will carry.

| Rule                        | Sites                                                    | MEASURED                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regex safety                | **1** implementation, `src/lib/server/matching/regex.ts` | **Zero** other `RE2JS.compile` or `new RegExp` sites in `src`. `categorization/rules.ts:166` and `transactions/search.ts:14` are named partial applications with different bounds, both delegating.            |
| Money denomination defaults | **1** home, `src/lib/domain/money.ts:93-94`              | Every consumer imports `DEFAULT_CURRENCY` / `DEFAULT_EXPONENT`. **Zero** retyped `'EUR'` or bare `2` at a denomination site.                                                                                   |
| Badge, brick 2              | **16** importers                                         | **Zero** inline pill-shaped label spans across every route and component, matched on `rounded-full` with `px-2/2.5` and a small text size.                                                                     |
| Exported symbol names       | **1** collision tree-wide                                | `isSafeRegexPattern`, and it is the delegating alias above. No other exported function or screaming-case constant name is defined in two files.                                                                |
| Card chrome, brick 5        | **26** files consume `cardBase` from `src/lib/styles.ts` | The token is the seam and it is doing its job. The two orphans in 3.1 are the exception, not the pattern.                                                                                                      |
| `Switch` versus `SwitchRow` | **Not** a duplication                                    | `SwitchRow.svelte:28-33` rules on it explicitly: a button cannot contain a button, so there is no composition, and `Switch`'s three callers keep it unchanged. The decision was already made and written down. |

The last row is the one to keep. The question "why are there two switch components" is the exact
question a future sweep will ask, and the answer is four lines long and already exists.

---

## Part 4: the one item that was traced to the end

`src/lib/server/import/persist.ts:618` is an unscoped read of a client-reachable id:

```ts
const bucket = await prisma.account.findUniqueOrThrow({
	where: { id: input.accountId },
```

It was reported as unverified rather than cleared in the first pass, then traced.

**MEASURED**, with Serena's reference search rather than a grep, because the question is a caller
set. Three production callers, no others:

| Caller                                      | Passes             | Provenance                                                                       |
| ------------------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `routes/import/columns/+page.server.ts:333` | `bucket.accountId` | `resolveImportBucketAccountById` at `:216-218`                                   |
| `routes/import/+page.server.ts:539`         | `bucket.accountId` | `decideAutoAccount` at `:409`, or `resolveImportBucketAccountBySource` at `:511` |
| `banking/sync/service.ts:503`               | `bucket.id`        | the connection's own rows, server-derived                                        |

There are exactly **two** client-posted entry points for an `accountId`,
`columns/+page.server.ts:218` and `import/+page.server.ts:415`, and both funnel through one
resolver. `persist.ts:371-374`:

```ts
const account = await prisma.account.findFirst({
	where: { id: input.accountId, userId: input.userId },
```

`userId` in the same where clause. Foreign and absent collapse to one `not-found`; `archived` is
differentiated only for an owner, with the reason at `:379-389`. `autoAccount.ts:73-75` states why
the second entry point calls it rather than retyping its query. The attack is
`resolveByChosenId.db-smoke.ts`, against a real engine rather than a fake.

**Verdict: cleared as a vulnerability, kept as debt.** Nothing is reachable. But the property is
deep rather than enforced: `PersistImportedTransactionsInput` takes `userId` and `accountId` as two
independent fields and its interface says nothing about the id needing prior authorisation. A
fourth caller passing a raw posted id compiles, typechecks, and reads exactly like the other three.

That is #501's shape one module over, and it is attached to #486 rather than filed separately.

---

## The verdict on 1.0

**Nothing here blocks it.** Stated rather than assumed, because the expectation going in was that
nothing would, and an audit that confirms its own expectation is the one that needs its reasoning
written down.

Against the standing bar, which is a false displayed figure, a security risk, or data loss:

- **1.1** is the closest call, because it is a security control. All three doors validate
  server-side and all nine sites agree at the boundary today. A retyped constant that is currently
  correct is drift, not risk.
- **1.3** and **2.4** are the only two that can reach a screen. One needs a submit straddling UTC
  midnight, the other more than 5 000 uncategorized transactions. Both are real and neither has
  been observed.
- **2.1** and **2.2** mislead contributors, and they mislead in the safe direction: the guide is
  stricter than the configuration. The cost is 101 class names carried for a constraint that was
  lifted.
- **1.2**, **1.4**, **1.5**, **2.3**, **2.5**, **3.1**, **3.3** cannot reach a user at all.
- **3.2** has already produced its consequence, and the consequence is #497, which is filed.
- **Part 4** is cleared.

## What came out of it

Everything below is post-1.0 and scheduled after the release.

| Finding                 | Where it went                                                                   |
| ----------------------- | ------------------------------------------------------------------------------- |
| Part 4                  | Attached to #486, which is the battery that would notice a fourth caller        |
| Date-input figure       | Correction posted to #497, which was already right at five                      |
| 1.1                     | #511                                                                            |
| 1.3                     | #512                                                                            |
| 2.1 + 2.2               | #510, one issue, because they are one drift with two documents downstream of it |
| 2.3                     | #514                                                                            |
| 2.4                     | #513                                                                            |
| 3.1                     | #515                                                                            |
| 3.2                     | #509, as a process finding rather than a missing row                            |
| 3.3                     | #516                                                                            |
| 1.2, 1.4, 1.5, 2.5, 3.4 | Not filed. Nothing is wrong with them and this page is the record.              |
