# The interface audit: what 1.0 freezes, before it freezes it

Read-only audit run 2026-08-21 against `main` at `50b284e`. **Nothing in the application was
changed while it ran.** What came out of it is listed at the end: five issues (#449, and #451
through #454) and one pull request (#450), which closes the three findings that share a failure
moment.

## How to read this

Every claim below carries one of two marks, because a survey's value is entirely in which half
it is.

- **MEASURED** means a command was run in this session and its output is quoted or summarised
  here. Where a probe could have reported an emptiness, it carries a calibration case, and the
  calibration result is stated alongside the finding.
- **READ** means the source was opened and the claim is what it says. No execution.

Enumerations use `git ls-files` rather than filesystem globs, because three leftover worktrees
under `.claude/worktrees/` make a whole-tree glob return four copies of the tree and make
`tsconfigRootDir` ambiguous.

### What the verification pass caught, and why it is in the preamble

A gate was run over this document before it was handed over: every figure in it had to come from
a command run in this session rather than from a draft, a memory or another document.

**Five figures were wrong, and all five had been counted by eye or quoted rather than run.**

| Drafted                            | Actual             | How it was wrong                                                           |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| 8 defaulted root keys              | **9**              | counted off a printed table by eye                                         |
| 6 optional fields                  | **8**              | same                                                                       |
| 12 files divide by 100             | **18**             | the command had `head -12` on it, so the truncation became the finding     |
| 1536 catalogue keys                | **1586**           | quoted from `CLAUDE.md`, which had drifted 50 since its own re-measurement |
| "the report contains no em dashes" | true, but unproven | asserted before the detector was shown to detect                           |

Every one of those is a figure this audit would have published as measured. The `head -12` case is
the one worth dwelling on: the command was real, its output was real, and the number it produced
was an artefact of how much of the output had been printed. **A truncated command does not look
truncated once its result has been written into a sentence.**

The fourth is the reason the catalogue key count has since been deleted from `CLAUDE.md`. It is
the second figure removed from that file for the same reason, and the two together name the shape:
both were counts of a growing quantity with no consumer, so both drifted by doing nothing wrong,
and both were most dangerous to the reader who trusted the file.

**The fifth is the one that is easiest to skip, and it is about this document rather than about
the codebase.** The claim was that the report contains no em dashes, so it can be committed
without reddening `emDashesInProse.spec.ts`. The first check ran the detector over the report (0)
and over `AGENTS.md` as a control (0), and _that control proves nothing_: a broken detector
returns 0 everywhere. The real control was a file containing one em dash, which had to return 1
before the 0 meant anything. Calibration is hardest to remember on a claim about your own work,
because that is the claim you already believe.

None of the five would have been caught by re-reading. Each was caught by re-running.

## The frame, and what it excludes

IADA: Identifiers, API, Data, Architecture, in decreasing order of difficulty to change. This
application has no REST API, which is a decision (roadmap item B) rather than an omission, so the
audit is identifiers and persistent formats. Architecture is out of scope by instruction, and the
database schema is treated as internal for the reasons set out at the end.

The audit is small because the absence of an API makes it small. That is the point of not having
one.

---

# PART 1: THE BACKUP FORMAT

Users hold these files, so this part comes first.

## The version question

**The export carries a version field.** `formatVersion: 1`.

- **READ.** Written as a literal by `buildBackupExport` at `src/lib/server/backup/export.ts:243`.
- **READ.** Declared as `z.literal(1)` at `src/lib/server/backup/schema.ts:383`.

It is read twice on restore, and the duplication is deliberate rather than redundant.

1. A hand-rolled pre-check in the route, `src/routes/settings/+page.server.ts:347-355`, refuses
   anything whose `formatVersion` is not exactly `1` with the message
   _"Unsupported backup format."_
2. The schema refuses the same payload with _"Invalid or corrupted backup file."_

The pre-check exists so that a version mismatch gets a **different message from corruption**. A
user holding a file from a newer build is told the format is unsupported, which is true and
actionable, rather than being told their file is damaged, which is false and alarming. Keep this.

**MEASURED.** Both a higher and a missing version are refused identically, and nothing is
written:

```
formatVersion 2       -> refuse, invalid_value at ["formatVersion"]
formatVersion absent  -> refuse, invalid_value at ["formatVersion"]
```

So the scenario where a format with no version can never be changed safely does not apply here.
This was the single largest thing the audit could have found, and it is absent.

## Strict or tolerant of unknown keys

**Strict, at every level.** This is the property that decides Part 5, so it was measured rather
than inferred from the presence of `.strict()`.

**MEASURED**, with the unchanged payload as a calibration case, because a schema that refused
everything would produce the same six refusals and mean nothing:

| Mutation                                        | Result | Zod issue                                 |
| ----------------------------------------------- | ------ | ----------------------------------------- |
| unchanged seed (CALIBRATION)                    | accept | none                                      |
| unknown root key (`households: []`)             | refuse | `unrecognized_keys` at `[]`               |
| unknown nested key (`accounts[0].householdId`)  | refuse | `unrecognized_keys` at `["accounts",0]`   |
| renamed root key (`accounts` to `bankAccounts`) | refuse | `invalid_type` at `["accounts"]`          |
| renamed field (`accounts[0].name` to `label`)   | refuse | `invalid_type` at `["accounts",0,"name"]` |
| `formatVersion: 2`                              | refuse | `invalid_value`                           |
| `formatVersion` absent                          | refuse | `invalid_value`                           |
| collection absent (`columnMappings`)            | accept | defaulted                                 |

Calibration result: 8 probes, 2 accepted, 6 refused. A validator accepting nothing would have
shown 0 accepted and every refusal below would have been vacuous.

### The correction this forces

Tolerance of unknown keys is **not** what makes additive evolution possible here. The
`.default([])` convention is. The two directions are separate and only one of them matters:

- **Old file into a new build: supported.** Every collection added since v1 arrived defaulted.
  **MEASURED: 9 of the 20 root keys are defaulted**, and **8 of the 111 fields are optional**.
  Each carries a comment in `schema.ts` saying which release it postdates and why it must not
  become required.
- **New file into an old build: refused, by construction.** A 1.1 export carrying
  `households: []` cannot restore on a 1.0 build.

Nine collections have been added without a `formatVersion` bump, because adding one never breaks
an existing file. What strictness costs is downgrade-restore only, which is already unsupported
and already documented.

### `.strict()` is a control, not a convention

This needs saying explicitly, because somebody will propose loosening it the first day a
downgrade-restore is wanted.

**READ.** `schema.ts:14-17` states it: `.strict()` on each object rejects any undeclared field,
`passwordHash`, a real `userId`, `role`, even when present in the payload. The
`backupBankConnectionSchema` comment at `schema.ts:150-154` makes the same point for
`credentialsEncrypted` and `providerSessionId`: a hand-edited backup that smuggles them in is
rejected, so a restored connection can never come back functional with imported secrets.

Loosening strictness opens exactly what it closes. **Freeze it as is.**

## The rename rule, uniform across all 111 fields

There is no per-field nuance to report, and that is itself the finding. Because every object is
`.strict()`, a rename breaks an old file in both directions at once: the old name becomes an
unrecognised key and the new name becomes a missing required one. **MEASURED** for both a root
key and a leaf field, in the table above.

The only additive-safe moves are: add a collection with `.default([])`, or add a field with
`.optional()`.

## The full enumeration

**MEASURED**, read off the schema at runtime rather than typed, by importing
`backupExportSchema` and walking `.shape`:

```
root keys      : 20
  scalars      : 3
  collections  : 17
defaulted keys : 9
total fields   : 111
  optional     : 8
```

| Root key                                   | Evolution | Fields                                            |
| ------------------------------------------ | --------- | ------------------------------------------------- |
| `formatVersion`, `exportedAt`, `userEmail` | required  | scalars                                           |
| `accounts`                                 | required  | 8 (4 optional)                                    |
| `categories`                               | required  | 3 (`defaultKey?` accepted and ignored since #162) |
| `importBatches`                            | required  | 10                                                |
| `columnMappings`                           | defaulted | 12                                                |
| `transactions`                             | required  | 15                                                |
| `monthlyBudgets`                           | required  | 3                                                 |
| `categoryRules`                            | required  | 6                                                 |
| `categorizationRules`                      | required  | 5                                                 |
| `categoryNatureMappings`                   | required  | 3                                                 |
| `netWorthAccounts`                         | defaulted | 5                                                 |
| `netWorthSnapshots`                        | defaulted | 5                                                 |
| `savingsGoals`                             | defaulted | 9                                                 |
| `bankConnections`                          | defaulted | 7 (2 optional)                                    |
| `recurringStreamActions`                   | defaulted | 9                                                 |
| `tags`                                     | defaulted | 3                                                 |
| `transactionTags`                          | defaulted | 2                                                 |
| `transactionSplits`                        | defaulted | 6 (1 optional)                                    |

## The round trip

Nothing in the suite answered whether a real export re-imports, so it was run.

**MEASURED.** A throwaway SQLite created empty by `prisma migrate deploy`, seeded with synthetic
rows only (invented holder, invented merchants, deterministic amounts). No real database was
read and `dev.db` was never touched. The account was non-trivial: 62 transactions across four
categories, a two-part split, a tag link, two net worth accounts one of which soft-deleted, a
snapshot, a savings goal, a bank connection, a column mapping, an import batch and a recurring
stream action anchored on five transaction ids.

```
export validates against its own schema: YES
compared 17 collections, 2 differ
split parent sum check: parts -1037 vs parent -1037 -> OK
```

Fifteen of seventeen collections are identical modulo regenerated identifiers. The two that
differ are both intended and both documented:

- `categories` 4 into 5: the restore guarantees the `uncategorized` sentinel exists even when the
  file has no such category.
- `bankConnections`: status `active` becomes `expired`, so a restored connection is never
  functional with imported secrets.

Money survived the trip: the split's parts still sum to their parent.

### #322 does not apply to the backup

**MEASURED.** The seed deliberately included #322's exact shape, two transactions with the same
date, merchant, amount and direction. Both survived: 62 in, 62 out.

#322 is a **CSV** defect in the `maison` v2 group validation, not a backup JSON defect. It is
still open, unlabelled and unmilestoned. It belongs to Part 3.

## The seam nothing tests

**MEASURED**, by checking every tracked spec for one that uses both halves:
`buildBackupExport`'s output is never fed to `backupExportSchema` or to `restoreBackup` by any
test. Every restore test uses a hand-built payload, including the real-database
`volume.db-smoke.ts`, which imports `restoreBackup` and not `buildBackupExport`.
`schema-properties.spec.ts` seeds from `schema.spec.ts`'s fixture, and says so in a comment, so
the property harness tests the schema against a hand-written object too.

TypeScript pins the **shape**: `BackupExport = z.infer<typeof backupExportSchema>` and
`buildBackupExport` returns that type. Nothing pins the **values**, and the values are where the
bounds live: `min(1)`, `max(191)`, `length(64)` on a fingerprint, and the two `superRefine`
ceilings that depend on a sibling key.

The repository already knows this class of defect. The `MAX_ANCHOR_IDS` comment at
`schema.ts:47-70` reasons about precisely this cell: a remapped anchor array can grow past what
was validated on the way in, "leave through an export that never runs this schema, and be
rejected on the way back in, the user is told their own export is corrupt". The class is
understood and the general case is not closed.

Untested is not broken. It passes today, **MEASURED** above. It is one assertion, and it is a
Part 4 item.

---

# PART 2: THE IDENTIFIERS

Hardest to change, per IADA, because a rename breaks every existing installation silently.

## Environment variables

### The enumeration required three passes, and the first two were blind

This is worth recording because it is the shape of an audit failing without noticing.

1. `process.env.X` over tracked sources found 27 names. It missed every bound the boot gate
   validates.
2. Those are read through a **constant holding the name**, `const BACKUP_MAX_JSON_NODES_ENV =
'BACKUP_MAX_JSON_NODES'`, so no literal `process.env.BACKUP_MAX_JSON_NODES` exists anywhere.
   Seven names are reached this way.
3. `.env.example` still named variables neither pass had found. Those are read through
   SvelteKit's `env` object from `$env/dynamic/private`, a third syntax, used in 6 files.

A single-pattern enumeration would have reported a confident and wrong list. **MEASURED**: the
union across all three access patterns is **34 application-read variables**, excluding `NODE_ENV`
and `TZ` which are platform rather than product.

### The cross-reference

**MEASURED** by script over `git ls-files`, cross-referencing the union against `.env.example`,
every `docker-compose*.yml`, and all 60 tracked docs plus `README.md`.

The docs column was calibrated with a positive control before being trusted: `DATABASE_URL`
resolves in 2 doc files, so a "no" in that column is an absence and not a broken matcher.

**Four variables are read by the application and absent from `.env.example`:**

| Variable                   | In docs | What it does                                           |
| -------------------------- | ------- | ------------------------------------------------------ |
| `ADDRESS_HEADER`           | yes     | which header carries the client address behind a proxy |
| `XFF_DEPTH`                | yes     | how many hops to trust in that header                  |
| `CSV_MAX_COLUMNS`          | yes     | upload bound                                           |
| `COLUMN_MAPPINGS_PER_USER` | yes     | per-user cap                                           |

All four appear in `docs/configuration.md`, two of them inside a dotenv block an operator is
meant to copy. The first two are the pair the boot gate validates through
`assertForwardingConfigSafe`, and they are the ones an operator behind a reverse proxy must set
correctly or the rate limiter keys on the wrong address. An operator who configures from
`.env.example` alone never sees them.

**Five variables are in `.env.example` and read by no application source**: `APP_PORT`,
`BODY_SIZE_LIMIT`, `DATABASE_PASSWORD`, `HOST`, `NODE_ENV`. None is a defect. They are consumed
by Compose (`APP_PORT` publishes the port, `DATABASE_PASSWORD` configures the database
container) or by adapter-node (`HOST`, `BODY_SIZE_LIMIT`). They are real operator interface owned
by other tools, and they should stay in the file.

**Reverse direction, MEASURED: `docs/configuration.md` documents 20 variables and every one is
genuinely read.** There is no phantom documentation. That is a clean result and worth stating,
because the opposite is the common failure.

**Docs gaps, MEASURED**: `BANK_SYNC_FIRST_LOOKBACK_DAYS`, `ENABLE_BANKING_BASE_URL`,
`LLM_HTTP_PERMITTED_HOSTS`, `LLM_PROVIDER` and `PORT` appear in no tracked doc.

### Names we would regret

**`IMPORT_MAX_BYTES` is declared twice, MEASURED**, at
`src/routes/import/+page.server.ts:36` and `src/routes/import/columns/+page.server.ts:26`, both
`256_000`, with no shared source. It is not an environment variable at all: it is a hard-coded
constant governing a user-facing refusal, duplicated across two routes that refuse the same
upload. Today they agree. Nothing makes them agree tomorrow, and the two screens would then
refuse different files with the same message.

`.env.example:127-129` documents the value as "256,000 bytes, separate, and not configurable",
so the _documentation_ has one source and the _code_ has two. The direction of that asymmetry is
the wrong way round.

**The production database file is named `dev.db`.** **MEASURED: 11 tracked files reference
`/data/dev.db`**, including `ENV DATABASE_URL=file:/data/dev.db` at two separate layers of the
Dockerfile (lines 148 and 185), `boot.mjs:51` as the fallback, both `docker-compose.yml` and
`docker-compose.prebuilt.yml`, `docs/configuration.md`, `docs/operations.md`, `setup.mjs` and
`docker-smoke.sh`.

This is the clearest instance of a name describing an implementation rather than an intent, and
it is not cosmetic: the path is **persisted state inside every operator's volume**. Rename it
after 1.0 and an installation that never set `DATABASE_URL` explicitly boots against a new empty
file, runs migrations, and presents an empty application while the real database sits beside it
on the same volume. The operator's data is recoverable by setting `DATABASE_URL`, but the
experience is indistinguishable from total loss at the moment it happens.

Before 1.0 this is a default change plus a boot-time compatibility shim. After 1.0 it is a
breaking change to a path users never chose and cannot see.

### One more identifier that is not a variable

**READ.** `docs/operations.md` publishes the image verification command, and it embeds the
workflow file path:

```
--certificate-identity-regexp '^https://github\.com/NonoHM/budgetpilot/\.github/workflows/docker-publish\.yml@refs/tags/'
```

**MEASURED: that path appears 3 times in `docs/operations.md`.** It means
`.github/workflows/docker-publish.yml` is a **public identifier**, not an internal filename.
Renaming or splitting that workflow invalidates every operator's copied verify command, and the
failure mode is the worst available: `cosign verify` reports that the signature does not match,
which reads as "this image is not authentic" rather than "we moved a file".

## The Docker surface

**READ** from `docker-compose.yml`, `docker-compose.prebuilt.yml`, `Dockerfile` and
`.github/workflows/docker-publish.yml`.

| Surface                   | Value                                                    | Frozen by 1.0                                |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| Image                     | `ghcr.io/nonohm/budgetpilot`                             | yes                                          |
| Tags published            | exactly two: `<X.Y.Z>` and `latest`                      | see below                                    |
| Git tag format            | `budgetpilot-v<X.Y.Z>` (release-please component prefix) | yes                                          |
| Compose service name      | `budgetpilot`                                            | yes, operators reference it in every command |
| Container name            | `budgetpilot`                                            | yes                                          |
| Named volume              | `budgetpilot_data`                                       | yes, renaming orphans the data               |
| Mount path                | `/data`                                                  | yes                                          |
| Internal port             | `3000`, fixed                                            | yes                                          |
| Published port            | `${APP_PORT:-3000}:3000`                                 | yes                                          |
| Version pin variable      | `BUDGETPILOT_VERSION`                                    | yes                                          |
| Runtime uid               | 65532 (distroless)                                       | yes                                          |
| Compose overlay filenames | 7 files, referenced by `-f` in docs                      | yes                                          |

**There is no floating major or minor tag. MEASURED**, the metadata action emits exactly:

```
type=raw,value=${{ steps.version.outputs.version }}
type=raw,value=latest
```

An operator cannot express "track 1.x". Their only choices are an exact version, which never
receives a patch fix, or `latest`, which will silently carry them across into 2.0 on the next
`docker compose pull`. Crossing a major boundary unattended is precisely the event a major
version promise exists to prevent, and today the promise has no tag that expresses it.

This is cheap now, one line in the metadata action, and it is the kind of thing that cannot be
added later without an awkward period where `:1` does not exist for versions that predate it.

## Routes and their query parameters

**MEASURED**, 19 page routes enumerated from `git ls-files 'src/routes/**/+page.svelte'`.

Query parameters read per route, and here again the first enumeration was blind. Grepping the
route files found only `page` and `selected` on `/transactions`. The filter vocabulary lives in a
shared module, `resolveTransactionScope` in `src/lib/server/transactions/scope.ts:140-155`, used
by the page, the CSV export, the tag counts and the split counts.

That is good design and it matters to this audit: the query vocabulary has **one definition
site**, so freezing it is a decision about one module rather than about four call sites.

**`/transactions` carries 12 parameters:**

| Parameter     | Kind                                        | Stable?                          |
| ------------- | ------------------------------------------- | -------------------------------- |
| `q`           | search text                                 | stable                           |
| `qMode`       | `regex`, else `contains`                    | stable                           |
| `type`        | `income`, `expense`, `classify`, else `all` | stable                           |
| `category`    | category name                               | stable, but see the caveat below |
| `from`, `to`  | date range                                  | stable                           |
| `split`       | `split`, `unsplit`, else `all`              | stable                           |
| `page`        | pagination                                  | stable                           |
| `importBatch` | **carries a database id**                   | see below                        |
| `tag`         | **carries a database id**                   | see below                        |
| `ids`         | **carries a list of database ids**          | see below                        |
| `selected`    | **carries a database id**                   | see below                        |

Other routes: `/admin` reads `page`; `/import` reads `batch` and `correct`; `/imports` reads
`cancelled`; `/imports/bank-connections` reads `connected`, `country`, `error`; `/login` reads
`notice` and `redirectTo`; `/login/verify-totp` reads `redirectTo`; `/register` reads `invite`;
`/rules` reads `preview`; `/upcoming-bills` reads `month`.

### The URL surface is deliberately tolerant, and the backup is deliberately strict

**READ.** `parseTransactionFilter`, `parseQueryMode` and `parseTransactionSplitFilter` all fall
back to a default on an unrecognised value rather than erroring. So a bookmark carrying a value
this build does not know degrades to the default view.

That is the **opposite** posture from Part 1's backup format, and both are correct. A wrong
backup file must never half-restore, so it is refused whole. A stale bookmark should still show
something, so it is absorbed. The application has two persistence surfaces with deliberately
opposite strictness, and neither should be brought into line with the other.

Consequence for 1.0: **adding a value to any of those vocabularies is additive and safe**.
Removing or renaming one silently changes what an existing bookmark shows, with no error.

### Four parameters carry identifiers a restore regenerates

This is where Part 2 meets Part 1. `selected`, `importBatch`, `tag` and `ids` carry cuids.
Part 1 established, **MEASURED**, that a restore regenerates every identifier. So a bookmarked
filtered view survives a restore only if it carries no id, and the four that do will silently
resolve to nothing after the user restores a backup.

This is not a 1.0 blocker and probably not worth fixing. It is worth **writing down**, because
the two decisions were made in different places and their interaction is not recorded anywhere.

`category` deserves the same note for a different reason: it matches on a name, and the repository
already records that joining on displayed text rather than an identifier once took a page from
5000 cents to 0. Here the tradeoff is deliberate and correct, since a name in a URL survives a
restore where an id does not.

---

# PART 3: THE OTHER PERSISTENT FORMATS

## The CSV export header

**READ.** `src/lib/server/transactions/exportCsv.ts:43`:

```
date;libelle;categorie;montant;type;nature;source_bancaire;montant_total;part;categorie_parent
```

The file already treats this as a contract and says so at line 10: "This header is a contract,
not an output. A file produced by one version must stay importable by every later one."

**The evolution model is already correct and already exercised.** Rather than editing the shape,
a new shape becomes a **new profile**: `import/profiles/maison.ts` is left untouched and
`maison-v2.ts` recognises the ten-column shape as a second profile. The header row is the
discriminator, so the format needs no version field of its own.

This is a better answer than the backup format's, and the two are not interchangeable. A CSV is
handed to a spreadsheet and has no place to put a version field. A backup JSON has one and uses
it.

**Freeze the header. The rule to freeze with it is the one already written: version the profile,
never edit the shape a user's installed file already has.**

### #322 remains open against this format

**READ** from the issue. Two identical unsplit transactions both emit `1/1`, so the v2 parser
sees one group claiming one line and containing two, and refuses both by name. The refusal
message describes a répartition problem on a file containing no répartition.

Part 1 measured that the **backup** path handles this case correctly, which isolates #322
cleanly: it is a property of the CSV format's group key, and the backup format is not affected.

## The dedupe key

**READ.** `src/lib/server/import/utils/safety.ts:174`. Version 2. The stored format is:

```
date | folded label | magnitude | type | occurrence | accountScope
```

**MEASURED** on a real import, the key written for a synthetic generic-profile row was:

```
2026-08-01|superette fictive|840|expense|0|
```

v2's history is documented in the source and is sound: the filename left in #317 because a
statement re-downloaded as `releve (1).csv` imported twice; `reference` and `category` left
because a key that changes when the user fixes a mistake is not a key; `occurrence` arrived
because two coffees at the same price on the same day are ordinary and v1 merged them.

### Can we live with the current version?

**Two reasons why not, and they are independent.**

**First, and this is now filed as #449.** The trailing empty field above is `accountScope`. It is
passed by exactly two call sites, both bank connectors, and omitted by all five CSV profiles,
while uniqueness is `@@unique([userId, dedupeKeyHash])`, scoped per user rather than per account.
**MEASURED**: one transaction imported into two different accounts of one user is stored once,
and the second import calls it a duplicate. Full detail in the filing.

**Second, the key carries no currency field**, and this is the collision between Part 3 and
Part 7. `currency` exists on exactly one model, `Account`. Two transactions with the same date,
folded label and magnitude in different currencies produce an identical key. Today that is
unreachable in practice because an account has one currency and accounts differ. Under #313 it
becomes reachable within a single multi-currency account, and the failure is silent.

**So the answer is no, and the third version is already owed.** The two changes should be made
together rather than as two separate duplication events, since the user-visible cost of a key
change is paid once per change and not once per field.

## Everything else written to disk or handed to a user

**READ.**

| Artifact        | Format                                                        | Public?                                    |
| --------------- | ------------------------------------------------------------- | ------------------------------------------ |
| SBOM            | `budgetpilot-<version>.spdx.json`, SPDX-JSON, release asset   | **Yes.** The filename is fetched by tools. |
| Signature       | cosign keyless, verified against the workflow identity regexp | **Yes**, see Part 2                        |
| Backup download | `budgetpilot-backup-YYYY-MM-DD.json`                          | **Yes**, users have folders of these       |
| Doc screenshots | `docs/screenshots/**`, PNG                                    | internal to the docs                       |
| Logs            | **no structured logger**                                      | **not an interface**, see below            |

**MEASURED: there is no logging library.** 18 `console.log` and 23 `console.warn` calls across
non-spec server sources, and no `pino`, `winston` or `createLogger` anywhere. Nothing parses this
output and no format is promised.

That is worth stating as a positive: **log output is explicitly not an interface**, and staying
that way keeps it free to change. The moment a doc tells an operator to grep for a specific
string, that stops being true. `docs/operations.md` already tells operators to read
`docker compose logs budgetpilot` to distinguish a schema mismatch from other failures, which is
close to that line without crossing it, since it describes what they will see rather than
promising a parseable shape.

---

# PART 5: THE AUTHORIZATION MODEL

The model is two roles, isolated users, no sharing, everything scoped by `userId`. The question
is not whether that is right for an application of this shape. It is what 1.0 commits us to if
households (#6) ever ship.

## Would a household relation be additive?

**Yes, and Part 1 settles it: households are a 1.1.**

This is recorded rather than re-derived. Part 1 measured that restore does **not** tolerate
unknown keys, and that the working mechanism for additive evolution is `.default([])`, which has
already absorbed nine collections without a `formatVersion` bump. A `households` collection and a
`householdMemberships` collection added the same way break no existing file. What they break is
restoring a 1.1 export on a 1.0 build, which is downgrade-restore, already unsupported and
already documented as _"From a newer format version: Unsupported backup format."_

Nothing is removed, no variable is renamed, no route is retired. The backup gains two collections
and the constraint that they arrive defaulted.

## Does `User.role` survive?

**Yes, unchanged, and the reason is that it is cleanly instance-scoped today.**

**MEASURED.** `requireAdmin` has 5 call sites and all 5 are in
`src/routes/admin/+page.server.ts`. The route has 5 entry points: one `load` and four actions,
`deleteUser`, `resetPassword`, `createInvitation`, `revokeInvitation`. Every one is guarded.
**MEASURED: 5 guards, 5 entry points.** There is no admin `+server.ts`, and `hooks.server.ts`
contains no role gate.

Every one of those four operations is about **the instance's user accounts**. Not one touches a
transaction, an account, a budget or a category. So `Role { USER, ADMIN }` means "administrator
of this instance" and nothing else, and household membership means "member of this household",
which is a relation with a capacity rather than a role.

**The failure to name now, so it is refused later:** adding `HOUSEHOLD_ADMIN` to the `Role` enum
would conflate instance scope with household scope. That is how role explosion starts, and the
enum is exactly where it would start, because it is the easiest place to put it. The two axes
must stay separate: `Role` stays instance-level, membership becomes a relation.

## The per-action guard, and what a test would cost

**#246 records that `requireAdmin` is called per action rather than enforced globally. The gap is
narrower than that framing suggests, and the narrowing matters.**

**MEASURED**: not only is every current entry point guarded, every current entry point already
has its own test asserting a non-admin gets a 403. `src/routes/admin/page.server.spec.ts` carries
five such tests, one per entry point, two of them explicitly named "garde indépendante de load".

So the present state is correct and covered. The defect is genuinely a **future** one: a sixth
action added tomorrow gets neither a guard nor a test, and nothing turns red.

**What the test costs:** one spec file, roughly 30 to 40 lines, no new infrastructure. It imports
the real `actions` object and `load` from the route module, and asserts each rejects a non-admin.

**The one design constraint, and it is the whole value of the test:** it must enumerate from the
module, `Object.keys(actions)`, and never from a literal list of action names. A hardcoded list
is the same manual maintenance one level up, and this repository already records that an
anti-drift test guards future divergence and never a present common error. Enumerating turns five
hand-written tests into one that covers N, including the ones nobody has written yet.

No policy engine is proposed. OpenFGA and SpiceDB are for relationship-heavy products across many
services. This is one binary and two roles, and the correct time to add relationship-based
authorization is the day user-driven sharing ships, as a data-model change.

---

# PART 6: THE UPGRADE CONTRACT

Nobody has written one. Here is what the code actually supports.

## Does skipping versions work?

**Nothing tests it. MEASURED across every migration step in the repository:**

| Where                                        | Against what                                |
| -------------------------------------------- | ------------------------------------------- |
| `ci.yml:242` (db-matrix, postgres and mysql) | an empty database                           |
| `ci.yml:291` (sqlite-migrations)             | an empty database, and the step is named so |
| `docker-smoke.sh:297`                        | a fresh container                           |
| `docker-publish.yml:490`                     | a fresh boot                                |

**No job applies pending migrations to a database that already holds rows written by an older
schema.** Every one starts empty.

**A correction worth recording.** `ci.yml:239-240` comments the step as "The provider's own
migration history, applied to an empty database, the upgrade path an operator on this engine
actually takes." Applying the entire history to an empty database is a **fresh install**. An
upgrade applies only the pending tail to a populated database. The comment conflates the two, and
it sits directly above the job that would be the natural place to test the real thing.

**The honest policy sentence is therefore "not tested", not "supported".**

Two facts soften this and should be stated with it: `prisma migrate deploy` applies all pending
migrations in order, so 0.11 to 1.0 very probably succeeds; and `migrate diff --exit-code` on
every provider proves each history converges on the authored schema, which is a real and unusual
guarantee. What is untested is the interaction of a pending migration with **existing rows**,
which is exactly where a data migration goes wrong.

## Is downgrade possible?

**No, and the documentation is already honest about it. READ**, `docs/operations.md:113-157`.

There are **zero down migrations. MEASURED: 69 `migration.sql` files across the three providers
and no `down.sql` anywhere**. Counts per provider: sqlite 48, postgresql 10, mysql 11.

What an operator does today, step by step, as documented:

1. Pin `BUDGETPILOT_VERSION` to the previous version and bring the stack back up. The docs
   correctly note that leaving the pin set is what you want, since `latest` would pull them
   straight back onto the bad release.
2. **If the release contained a migration, that is not enough.** The old image now points at a
   newer schema and may fail to start or behave incorrectly.
3. In that case the rollback is: restore the backup taken before the upgrade, then run the old
   image against it.

**What they lose: everything written between the backup and the rollback.** The docs say this
plainly, along with four things a rollback does not undo.

`docker compose logs budgetpilot` distinguishes the two cases, and the docs say a schema mismatch
shows up immediately at startup rather than later. That is the right level of detail.

## What happens if `migrate deploy` fails halfway

**This is already in the operator documentation**, `docs/operations.md:183-215`, contrary to the
assumption that it lived only in a PR body. It is thorough, and the figures were re-measured
today rather than quoted.

**MEASURED, reproducing the recorded figures exactly** on the `add_column_mapping` migration:

| Engine     | Statements |
| ---------- | ---------- |
| MySQL      | 2          |
| SQLite     | 3          |
| PostgreSQL | 4          |

**MEASURED: zero of the 69 migration files contain `BEGIN`, `START TRANSACTION` or `COMMIT`.**
Nothing is wrapped in a transaction on any engine, PostgreSQL included.

So a mid-file failure leaves a different half-built state per engine, bounded by `P3009`
refusing every later deploy. The docs already say all of this, already tell the operator to read
the migration file for their own engine, and already frame `P3009` as a feature rather than an
obstacle. Nothing to add.

## Does anything tell an operator to back up before upgrading?

**No, and this is the one-sentence gap. MEASURED** by reading the section.

`docs/operations.md:30-38`, the entire `## Updating` section:

```
## Updating

**Published image:**

docker compose pull
docker compose up -d
```

Two commands. No mention of a backup.

`docs/operations.md:140`, in the rollback section, says the recovery is **"restore the backup you
took before upgrading"**. The document presupposes a backup that the document never told anyone
to take.

The application **has** a backup feature, documented, with its own reference page. Turning it
into the upgrade safety net costs one sentence in the section operators actually read before
running `docker compose pull`. This is the cheapest item in the entire audit.

## The proposed policy, for your approval

Written in the shape the comparable projects use. Wording is yours to change; this is a draft.

> ## Upgrade policy
>
> **Take a backup before upgrading.** Settings, Export. Every upgrade path below assumes you
> have one, and the rollback path requires it.
>
> **Within a major version, upgrades are non-disruptive.** Migrations run automatically at
> startup. No manual step is required.
>
> **Skipping versions is untested rather than unsupported.** Migrations apply in order, so
> jumping several versions is expected to work, and no automated test exercises an upgrade of a
> populated database. If you are skipping more than one minor version, take the backup and read
> the release notes for each version you skip.
>
> **Downgrades are not supported.** No migration in this project is reversible. Running an older
> image against a newer database may fail at startup or behave incorrectly. To go back: restore
> the backup you took before upgrading, then run the older image against it. You lose everything
> written since that backup.
>
> **A major version may break compatibility** with configuration, file formats and the upgrade
> path itself. Read the release notes before upgrading across one.

The third clause is the one that differs from Omni, which states plainly that version skipping is
unsupported because untested. Ours can be weaker because `migrate diff --exit-code` proves the
histories converge, which Omni does not have. It should not be stated as "supported" until a job
upgrades a populated database.

---

# PART 7: THE ASSUMPTIONS INSIDE STORED DATA

Not identifiers and not formats. Semantics that a future feature reinterprets, carried silently
by rows that already exist. The second question, "would a planned feature require reinterpreting
existing rows", is what separates a 1.1 from a 2.0.

## Money precision

**MEASURED: 8 money columns, every one `Int`**: `amountCents` on `Transaction`,
`TransactionSplit` and `MonthlyBudget`; `balanceCents` on `NetWorthAccount` and
`NetWorthSnapshot`; `targetAmountCents`, `currentAmountCents` and `startingBalanceCents` on
`SavingsGoal`.

**MEASURED: `currency` exists on exactly one model**, `Account`, defaulting to `"EUR"`. No
transaction, split, budget, snapshot or goal carries a currency. Every amount inherits its
account's, and the aggregates inherit nothing at all.

### Is the assumption documented?

**Partially, and in the wrong register. READ.**

- `src/lib/domain/money.ts:2` describes itself as the "single source of truth for parsing a
  **euro**-amount text input into integer cents". So the assumption is stated, in a module
  comment, as euro rather than as exponent-2.
- `prisma/schema.prisma:440` documents `TransactionSplit.amountCents` as "signed integer cents",
  which says the unit and not the assumption behind it.
- No user-facing or reference documentation states that amounts are two-decimal.

### What a three-decimal currency would do

**READ.** `formatCents` at `src/lib/domain/budget.ts:149-171` already accepts a `currency`
parameter, defaulting to `'EUR'`, and its body is:

```ts
return new Intl.NumberFormat(locale, { style: 'currency', currency, signDisplay }).format(
	amountCents / 100
);
```

The division by 100 is unconditional; the rendering exponent comes from the currency. **For any
currency whose exponent is not 2, the two disagree**, and the disagreement is a factor of ten or
a hundred:

- A three-decimal currency (TND, KWD, BHD) stored in thousandths renders ten times too small.
- A zero-decimal currency (JPY, KRW) stored as if it had cents renders one hundred times too
  small.

**MEASURED: 19 sites divide by 100 across 18 non-spec files**, so the assumption is not confined
to the one formatter. Parsing is genuinely centralised in `parseMoneyCents`; formatting is not.

**Would #313 reinterpret existing rows?** Existing rows are euro and stay correct, so this is
**not** a 2.0 on the storage question alone. What #313 requires is: a currency and its exponent
carried per amount or per account, a scaling decision at every one of the 19 division sites, and
the dedupe key v3 from Part 3. That is a large 1.x feature, not a breaking change, **provided
the exponent is introduced alongside the currency rather than after it.** If a currency column is
added without an exponent and a non-euro currency is allowed in, the rows written in that window
are the ones that cannot be reinterpreted later, because nothing records what they meant.

**One more bound, noted rather than raised as a finding**: `Int` is 32-bit on PostgreSQL and
MySQL, so the largest representable amount is 21,474,836.47 in the currency's major unit. SQLite
stores 64-bit. For a personal budgeting application this is not a constraint, and it is a real
cross-engine difference worth knowing before anybody stores a portfolio in `balanceCents`.

## Date and time semantics

**READ**, and this is the mixed-semantics column.

`NetWorthSnapshot.capturedAt` holds **two different kinds of value**, decided in `parseAsOfDate`
at `src/lib/server/net-worth/service.ts:461-473`:

| Input                   | Stored value                                        | Meaning                                     |
| ----------------------- | --------------------------------------------------- | ------------------------------------------- |
| a **past** `YYYY-MM-DD` | `<date>T12:00:00.000Z`                              | a **calendar day**, sentinel, no time known |
| **today**, or no date   | the real clock                                      | an **instant**                              |
| a bank sync             | the real clock at the start of `syncBankConnection` | an **instant**                              |

The noon sentinel is deliberate and its reasoning is sound: a past date has no instant of its
own, so any position inside the day would do, and #443 moved "today" off the sentinel because
pinning it to noon made the winner of two same-day writes depend on which side of noon the other
landed. That comment records the measurement.

**The remaining property is that the column cannot tell you which kind a given row is.** A real
sync at exactly 12:00:00.000Z is indistinguishable from a backdated entry. Nothing depends on
telling them apart today, which is why this is a note and not a defect.

**On the four rendering sites.** `formatFullDate` in `NetWorthChart.svelte:35` and the four call
sites at lines 202, 227, 264 and 284 render **day, month and year only**. No time is displayed.
So the sentinel is **not** rendered as a fact, and the concern that it might be does not hold:
the function cannot display a time it was never given.

There is a subtler consequence, stated precisely rather than inflated. `toLocaleDateString`
renders in the reader's local zone. A row pinned to noon UTC shows the same calendar day for any
offset within about eleven hours either way. A row carrying a real instant near midnight UTC
shows the neighbouring day for a reader far enough east or west. Both are correct renderings of
what is stored. The effect is that two snapshots a user thinks of as "the same day" can appear on
different days depending on whether each was backdated or live. Ordering is unaffected, since it
is by `capturedAt` then `id`, so this is a display alignment nuance and not a wrong figure.

**Other date columns, READ**: `Transaction.date` is a `DateTime` with no doc comment stating
whether it is a day or an instant, which is the column most worth documenting since every import
writes it and every filter reads it. `ImportBatch.periodStart` and `periodEnd` are day-valued.
`SavingsGoal.targetDate` is day-valued; `reachedAt` and `reachedBannerDismissedAt` are instants.
`RecurringStreamAction.dueDate` is day-valued. The `createdAt` and `updatedAt` pairs throughout
are instants and are bookkeeping.

**Would a planned feature reinterpret existing rows?** Only if something starts depending on the
time of day inside `capturedAt`, which nothing does today. Recording which columns are days and
which are instants is cheap now and expensive to reconstruct later, because the evidence lives in
the writers rather than in the rows.

## Password hash format

**READ.** bcrypt, at a configurable cost with a floor.
`src/lib/server/auth.ts:107` hashes, `:111` compares, `:116` keeps a dummy hash so the login path
takes comparable time whether or not the account exists.

**`validatePassword` at `src/lib/server/auth.ts:95-97` accepts 12 to 256 characters. bcrypt uses
the first 72 bytes.**

**MEASURED: the string "72 bytes" appears in zero tracked source or documentation files.** The
truncation is documented nowhere.

**MEASURED: `docs/reference/account.md:11` states "Maximum length | 256 characters".** That row
is literally true of the validator and materially misleading about the effect: a user who chooses
a 200-character passphrase is told all 200 count, and 128 of them do nothing. Two distinct
passwords sharing their first 72 bytes are interchangeable at login.

**MEASURED: the user-facing catalogue states only the minimum**, "12 characters minimum". The
256 bound is never shown to users, so the misleading claim is confined to the reference page.

### If we move to argon2

**The stored hash format is not public.** It is never exported: `coverage.spec.ts` lists `User`
as "the restore target, never part of its own payload", and Part 1 measured that `.strict()`
rejects a `passwordHash` smuggled into a backup. So the algorithm can change without breaking any
interface this audit is about.

**Dual verification is possible and is the right answer**, because bcrypt hashes are
self-describing: they begin `$2b$`, and argon2 hashes begin `$argon2`. Nothing today implements
it and there is no `algorithm` column, but none is needed. The migration shape is: on successful
login, detect the prefix, verify with the matching algorithm, and rehash with the new one. No
forced reset, no data migration, and the population converges as users sign in.

**The one thing to decide when that happens is the 72-byte question**, since argon2 has no such
limit. Moving to argon2 while leaving the 256-character maximum in place would make the two
algorithms disagree about what a password is: a passphrase over 72 bytes would verify under
bcrypt and, once rehashed, become sensitive to bytes that never mattered before. Anyone whose
password differs from their own only past byte 72 would then be locked out, which is a small
population and not an empty one.

## Soft versus hard delete

**MEASURED: exactly two models are soft-deleted**, `NetWorthAccount` and `SavingsGoal`, both with
`deletedAt DateTime?` and both indexed `@@index([userId, deletedAt])`. Everything else is a hard
delete, across 27 distinct `delete`/`deleteMany` call patterns in server code.

**The backup treats the two differently, deliberately, and says why. READ**, `export.ts:133` and
`:148`:

- Soft-deleted `NetWorthAccount` rows **are** exported, "so their history round-trips through a
  restore rather than being silently dropped". Their snapshots depend on them.
- Soft-deleted `SavingsGoal` rows are **not** exported, because "a deleted goal has no such
  dependent history to preserve".

Part 1 measured this: the seeded soft-deleted net worth account survived the round trip with its
`deletedAt` intact.

**This is documented as a user-visible contract, which is what freezes it. READ**,
`docs/reference/net-worth.md:30`: _"Deletion is an end. A deleted account counts up to the day it
was deleted, and not after."_ And `docs/using/net-worth.md:48-54` explains what the two effects
are.

So soft deletion here is **not an implementation detail**. It is a promise about what a user's
history means: the account's contribution stops at the deletion date and the past is preserved.
Changing it to a hard delete after 1.0 would rewrite what every existing chart means, and
changing any hard delete into a soft one would make rows reappear that users believe are gone.

**MEASURED: no documentation states the delete semantics for anything else.** A user deleting a
category, a tag, an account or a transaction is not told whether it is recoverable. It is not,
and saying so is cheap.

---

# HOW THE PARTS CONNECT

The findings are not independent, and four of the connections change what should be done.

**Part 1 decides Part 5.** Strictness plus the `.default([])` convention is what makes households
a 1.1. Without measuring the backup's tolerance, Part 5 could only have concluded on an
assumption, and the assumption most people would make, that strictness blocks additive evolution,
is the wrong one.

**Part 1 collides with Part 2 at the four id-carrying query parameters.** A restore regenerates
every identifier; four bookmarkable parameters carry identifiers. Neither decision is wrong and
their interaction is recorded nowhere.

**Part 3 collides with Part 7 at the dedupe key.** The key has no currency field, so #313 forces
a v3, and #449 forces one too. Both should be done at once, since the cost of a key change is a
duplication event paid per change rather than per field.

**Part 2 and Part 6 are the same finding seen twice.** The absence of a floating major tag and
the absence of a "back up first" sentence are both about the moment an operator upgrades
unattended. `latest` crossing into 2.0 is the event; no backup is what makes it unrecoverable.
They should be fixed together, and the policy in Part 6 should mention the tag.

**Part 1's untested seam and Part 5's unenumerated guard are the same class.** Both are correct
today, both are covered by hand-written cases, and both fail the day someone adds the N+1 thing.
Both are closed by a test that **enumerates from the module** rather than from a list. This is
the repository's own recorded rule that an anti-drift test guards future divergence and never a
present common error, and it applies twice.

**Two documentation defects share an aggravating property.** The nineteen-keys claim and the
refusal-table row both sit in a document that states it was measured. "Read off a real export" is
a claim about **method**, and it is wrong by one. That is worse than ordinary staleness: a reader
who spots the drift loses confidence in every other figure on the page, including the ones that
are right.

---

# PART 4: THE VERDICT

## Freeze as is

Correct, and 1.0 commits to it.

| Item                                                                 | Part | Why it is right                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion: 1`, read twice, distinct message per failure         | 1    | The version exists, is enforced, and a mismatch is distinguishable from corruption                                                                                                                                                 |
| `.strict()` on every backup object                                   | 1    | **A control, not a convention.** It rejects a hand-edited file smuggling `passwordHash`, `userId` or `role`, and `credentialsEncrypted` on a bank connection. Loosening it to allow downgrade-restore opens exactly what it closes |
| `.default([])` for every new collection                              | 1    | Nine collections added without a version bump and without breaking a file                                                                                                                                                          |
| The 20 root keys and 111 fields as named                             | 1    | Renaming any of them breaks every installed file in both directions                                                                                                                                                                |
| Backup filename `budgetpilot-backup-YYYY-MM-DD.json`                 | 3    | Users have folders of these                                                                                                                                                                                                        |
| The CSV header, and versioning by profile                            | 3    | The rule is already written and already exercised by `maison-v2`                                                                                                                                                                   |
| URL parameter tolerance (unknown value falls back)                   | 2    | Correct and deliberately opposite to the backup's strictness. A stale bookmark should degrade, a wrong backup should not                                                                                                           |
| The `resolveTransactionScope` vocabulary as a single definition site | 2    | Freezing it is one decision, not four                                                                                                                                                                                              |
| Two roles, instance-scoped                                           | 5    | Right for this shape. Relationship-based authorization is the day sharing ships, not before                                                                                                                                        |
| Soft delete on `NetWorthAccount`, hard everywhere else               | 7    | Documented as a user-visible promise about what history means                                                                                                                                                                      |
| Log output as a non-interface                                        | 3    | No structured logger, nothing parses it, and it stays free to change                                                                                                                                                               |
| Compose service name, volume name, mount path, internal port         | 2    | Operators reference all four by name                                                                                                                                                                                               |

## Change before 1.0

Wrong, and cheaper now than ever again. Strict list: each of these is a rename or reshape that
genuinely improves, not a preference.

| Item                                                   | Part | Cost now                                                                                   | Cost after 1.0                                                                                                                          |
| ------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **The production database file is named `dev.db`**     | 2    | A default change plus a boot compatibility shim, 11 files                                  | A rename of persisted state inside every volume. An installation that never set `DATABASE_URL` boots empty with its real data beside it |
| **No floating major tag**                              | 2    | One line in `docker/metadata-action`                                                       | `:1` cannot exist for versions that predate it, and `latest` silently carries unattended installs into 2.0                              |
| **`## Updating` never says to take a backup**          | 6    | One sentence, in the section operators read before `docker compose pull`                   | The rollback path keeps presupposing a backup nobody was told to take                                                                   |
| **The dedupe key has no `accountScope` on CSV (#449)** | 3    | A v3 key, once                                                                             | A second duplication event if done separately from the currency change                                                                  |
| **The dedupe key has no currency field**               | 3, 7 | Same v3, same change                                                                       | As above. Do both at once                                                                                                               |
| **`IMPORT_MAX_BYTES` declared twice**                  | 2    | One shared constant                                                                        | Two screens refusing different files with the same message                                                                              |
| **Four env vars missing from `.env.example`**          | 2    | Four lines. `ADDRESS_HEADER` and `XFF_DEPTH` are the pair a proxied install must get right | An operator configuring from the example file alone keys the rate limiter on the wrong address                                          |
| **The export/restore seam has no test**                | 1    | One assertion: a real export parses and restores                                           | The bounds drift from the exporter and only a user finds out                                                                            |
| **The admin guard is not enumerated**                  | 5    | 30 to 40 lines, enumerating `Object.keys(actions)`                                         | The N+1 admin action ships unguarded and nothing turns red                                                                              |
| **Three documentation defects**                        | 1, 7 | Three edits                                                                                | See the filings section                                                                                                                 |

## Change after, with a major

Things we will want to change and cannot do quietly. Naming them now means the 2.0 conversation
starts from a list.

| Item                                                  | Part | Why it needs a major                                                                                                                                                                                          |
| ----------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renaming any backup collection or field               | 1    | `.strict()` makes every rename break every installed file in both directions. Only a `formatVersion` bump with a translation step can do it                                                                   |
| Making restore tolerant of unknown keys               | 1    | Would allow downgrade-restore, and would weaken the control that rejects smuggled credentials. If ever wanted, it needs a design that keeps the rejection and relaxes only unknown **collections**            |
| Editing the CSV header shape                          | 3    | The rule is to version the profile instead. Editing the shape breaks files users already hold                                                                                                                 |
| The four id-carrying query parameters                 | 2    | Not worth changing, but if URLs ever need to survive a restore, `selected`, `importBatch`, `tag` and `ids` are the four to reconsider                                                                         |
| `.github/workflows/docker-publish.yml` as a path      | 2    | Embedded in every published `cosign verify` command. Moving it makes verification fail in the way that reads as "not authentic"                                                                               |
| Money as exponent-2 integers                          | 7    | Existing euro rows stay correct, so #313 is a 1.x feature **only if** the exponent arrives with the currency. Rows written with a non-euro currency and no exponent are the ones that cannot be reinterpreted |
| bcrypt's 72-byte truncation, if argon2 lands          | 7    | The algorithm change itself is internal and needs no major. Reconciling the 256-character promise with 72 effective bytes can lock out a small population                                                     |
| Turning any soft delete hard, or any hard delete soft | 7    | Rewrites what a user's existing history means. Documented for net worth as a promise                                                                                                                          |
| Skipping versions, if ever promised as supported      | 6    | Requires a job that upgrades a populated database first. Until then the policy says "untested"                                                                                                                |

## What is explicitly NOT public

Writing this down is as valuable as the rest, because it says what we are free to move.

| Not public                               | Qualification                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Prisma schema**                    | Additive migrations are not breaking changes for a self-hosted application, and expand-contract covers the rest. **One qualification, MEASURED**: `coverage.spec.ts` pins every model name to its export key, `camelCase` plural or an explicit override. So renaming a model forces either an override entry or a backup format change. The coupling is deliberate and gated, and it means the schema is free to move only if the export key is held still |
| **The message catalogue keys**           | **MEASURED: 1586 keys per locale**, both locales equal, none user-addressable. Noted because `CLAUDE.md` records 1536, re-measured 2026-08-16, so that figure has drifted by 50                                                                                                                                                                                                                                                                             |
| **Component props**                      | Internal to the application                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Internal module boundaries**           | Including `resolveTransactionScope`'s own signature. The **query vocabulary** it parses is public; the function is not                                                                                                                                                                                                                                                                                                                                      |
| **The stored password hash format**      | Never exported, and `.strict()` rejects it on the way in. Changeable by dual verification with no interface consequence                                                                                                                                                                                                                                                                                                                                     |
| **Log output**                           | No structured logger, nothing parses it                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **The `dedupeKey` raw column**           | Kept for traceability, compared only via its hash. Its **format** is a stored contract; its presence in the row is not an interface                                                                                                                                                                                                                                                                                                                         |
| **Everything under `docs/superpowers/`** | Working notes, not operator documentation                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

# FILINGS

## Filed during the audit

**#449, cross-account import deduplication.** Filed on its own, before the rest of the audit
continued, because it is a false displayed figure rather than an interface question. One
transaction imported into two of a user's accounts is stored once and the second import calls it
a duplicate. Labelled `bug`, and placed in **"Nothing on screen is false"**: that milestone stood
at zero open issues, and a milestone at zero is empty rather than closed, so putting a matching
issue in it is what makes the name mean something.

## The four documentation defects

All four filed, and the first is the worst for a reason that is not its size.

| Issue    | Defect                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **#451** | The backup reference claims nineteen top-level keys "read off a real export". There are 20; `columnMappings` is absent from the list |
| **#452** | Both refusal tables give the wrong message for a file that is not JSON, and the reference table is missing two of the eight branches |
| **#453** | The account reference promises a 256-character password maximum; bcrypt uses the first 72 bytes, documented nowhere                  |
| **#454** | `ci.yml` calls migrating an empty database "the upgrade path an operator actually takes"; it is a fresh install                      |

**#451 is the worst because "read off a real export" is a claim about METHOD.** A stale number is
a stale number. A stale number that states how it was obtained tells the reader they may stop
checking, which is the only reason that phrase is in the document. A reader who notices the drift
does not lose one figure, they lose their reason to trust every other figure on the page,
including the ones that are right.

#454 is the odd one out and is filed anyway: it misdescribes a gate to the people maintaining it,
and it is the exact sentence that would have ended Part 6's question with the wrong answer.

## Fixed rather than filed

**PR #450** closes the three items from "change before 1.0" that share a failure moment: the
database default name with its boot shim, the floating major tag, and the backup sentence in
`## Updating`. The composition is the finding, and none of the three would have justified a PR
alone. See "How the parts connect" above.

## The original filing list, kept for the record

**1. `docs/reference/backup-restore.md:17` claims nineteen top-level keys. MEASURED: there are
20**, and `columnMappings` appears zero times in that document. The line reads "Nineteen
top-level keys, read off a real export", which is a claim about method, so the defect is not
only the count.

**2. Both refusal tables carry a row the code contradicts.** `docs/reference/backup-restore.md:98`
and `docs/using/backup-restore.md:73` both say _"Not JSON: Unsupported backup format."_
**MEASURED**: a `JSON.parse` failure returns `settings_error_restore_invalid_json`, _"The file is
not valid JSON."_ The reference table is also missing two of the eight refusal branches, the
JSON-node cap and the duplicate-category refusal. Both documents state their tables were produced
on a running instance.

**3. `docs/reference/account.md:11` states a 256-character password maximum.** True of the
validator, misleading in effect: bcrypt uses the first 72 bytes, and the truncation is documented
nowhere in the tree.

**4. `ci.yml:239-240` describes migrating an empty database as "the upgrade path an operator
actually takes".** It is a fresh install. The comment sits above the job that would be the
natural place to test the real thing.

These four are documentation and comment defects. The first three are user-facing; the fourth
misdescribes a gate to the people maintaining it, which is why it is here rather than dropped.

## Not filed, deliberately

The four id-carrying query parameters, the mixed semantics of `capturedAt`, and the 32-bit `Int`
ceiling are all recorded above and none of them causes a false claim, a security risk or data
loss today. By the standing rule, a backlog item earns a follow-up only when it does one of
those three. They are written down here so the next reader does not rediscover them.
