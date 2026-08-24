# What canonically identifies a bank transaction

Primary-source research note. Compiled 2026-08-21.

**How to read the tags.** Every claim below carries one of:

- **READ**: I fetched the named URL in this session and the statement comes from that
  document. Where the difference between _may_ and _must_ carries weight, the decisive
  sentence is quoted verbatim rather than paraphrased.
- **INFERRED**: follows from something I read, and the note says from what. It is my
  reasoning, not the source's words.
- **UNVERIFIED**: I could not confirm it. The note says what I tried.

**One typographic note.** This repository's prose rule (`AGENTS.md`, gated by
`src/lib/prose/emDashesInProse.spec.ts`) allows no em dash in a tracked Markdown file. Where a
quoted source used one, it is rendered here as a comma or a colon; no quoted wording is altered.

**What I could not fetch at all**, stated up front so it is not mistaken for absence of
evidence:

- The **current** ISO 20022 Message Definition Report for `camt.053.001.14`. The registry at
  `iso20022.org` distributes MDRs as ZIP downloads behind a catalogue page. What I read
  instead is the ISO-hosted MDR PDF for the **2020/2021 maintenance round**, which covers
  `camt.053.001.09` and is watermarked _"For evaluation by the Payments SEG"_. Every
  multiplicity I quote from it is corroborated by at least one independent implementation
  guideline below, but the reader should treat the version as v09-era, not v14.
  (**UNVERIFIED**: that v14 has identical multiplicities. I did not read v14.)
- The GoCardless Bank Account Data knowledge-base article on `internalTransactionId` at its
  live URL: `bankaccountdata.zendesk.com` sits behind a Cloudflare JS challenge and returns
  403 to both WebFetch and curl. I read the **Wayback Machine capture of 2026-06-02** instead
  and cite that URL.
- The GoCardless status-page incident about `UNICREDIT_BACXROBU internalTransactionId will
change`. The incident.io page renders client-side; curl returns only the page chrome. The
  incident's **title** is READ (from search results and the page `<title>`); its **body** is
  **UNVERIFIED**.
- CGI-MP's own camt.053 market-practice document. Search surfaced only third-party
  descriptions of it. I did not find a CGI-MP-published PDF, so nothing below is attributed to
  CGI-MP.

---

## (a) ISO 20022 identification fields on a transaction entry

### The two levels, because it decides everything else

**READ**: `https://www.iso20022.org/sites/default/files/2020-12/ISO20022_MDRPart2_BankToCustomerCashManagement_2020_2021_v1_ForSEGReview.pdf`

A `camt.053` statement nests as: `Document/BkToCstmrStmt/Stmt/Ntry/NtryDtls/TxDtls/Refs`.

- `Statement <Stmt>` is `[1..*]`; `Entry <Ntry>` is `[0..*]`.
- `EntryDetails <NtryDtls>` is `[0..*]` (§6.1.9.2.18) and inside it
  `TransactionDetails <TxDtls>` is `[0..*]`.
- `References <Refs>` is `[0..1]` (§6.1.9.3.1), _"Provides the identification of the
  underlying transaction."_

So a single booked **entry** may carry **zero, one or many** transaction-detail blocks, and
each of those may or may not carry a `Refs` block. The bank's own reference (`AcctSvcrRef`)
exists at the **entry** level; the payment-chain references (`EndToEndId`, `TxId`, `InstrId`,
`UETR`, `MsgId`) exist at the **transaction-detail** level, i.e. one level deeper and
potentially many per entry.

**INFERRED** (from the multiplicities above): an entry-to-reference mapping is not
one-to-one. A batch-booked entry, one debit for a whole payment file, has one
`AcctSvcrRef` and _N_ `EndToEndId`s. Any key built on `EndToEndId` alone therefore cannot
address an entry.

### Field by field

Unless noted, presence and definition are **READ** from the ISO MDR above (§6.1.9.2.x for
entry-level, §6.1.9.3.1.x for `Refs`), and all are `Max35Text`.

| Field         | Where                                      | ISO presence                             | Assigned by                                                             |
| ------------- | ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------- |
| `NtryRef`     | Entry                                      | `[0..1]`                                 | account servicer (implied)                                              |
| `AcctSvcrRef` | Entry **and** `Refs`                       | `[0..1]` at both                         | account servicing institution                                           |
| `MsgId`       | `Refs` (and `GrpHdr`, and `NtryDtls/Btch`) | `[0..1]` in `Refs`; `[1..1]` in `GrpHdr` | instructing party of underlying message / account servicer for `GrpHdr` |
| `PmtInfId`    | `Refs`, `Btch`                             | `[0..1]`                                 | sending party                                                           |
| `InstrId`     | `Refs`                                     | `[0..1]`                                 | instructing party                                                       |
| `EndToEndId`  | `Refs`                                     | `[0..1]`                                 | initiating party (debtor)                                               |
| `UETR`        | `Refs`                                     | `[0..1]`                                 | initiating party (UUIDv4)                                               |
| `TxId`        | `Refs`                                     | `[0..1]`                                 | first instructing agent (debtor agent)                                  |
| `ClrSysRef`   | `Refs`                                     | `[0..1]`                                 | clearing system                                                         |

**Every identification field inside `Refs` is optional in the message definition. There is no
mandatory transaction identifier in camt.053.** (**READ**, from the presence lines above.)

#### `AcctSvcrRef`: the bank's reference for the entry

> §6.1.9.2.8 `AccountServicerReference <AcctSvcrRef>`: Presence: `[0..1]`. Definition:
> "Unique reference as assigned by the account servicing institution to unambiguously identify
> the entry."

**READ** (ISO MDR). Note the object is _the entry_, not the payment.

Inside `Refs`, the same tag has a different object:

> §6.1.9.3.1.2: "Unique reference, as assigned by the account servicing institution, to
> unambiguously identify **the instruction**."

**READ**. So `AcctSvcrRef` means two different things depending on depth.

**Scope of uniqueness: the definition says "unique … to unambiguously identify the entry" and
states no scope.** No sentence in the MDR bounds it to an account, a bank, a period, or
anything else. (**READ**: this is an observation about what the text does _not_ contain.)

Corroboration on presence, and it is a _should_, not a _must_:

**READ**: `https://www.betaalvereniging.nl/wp-content/uploads/2026/03/IG-Bank-to-Customer-Statement-CAMT-053-v2.0.pdf`
(Dutch national implementation guideline, camt.053 v2.0). Its structure table keeps
`AccountServicerReference <AcctSvcrRef> [0..1]`, i.e. it does **not** raise the multiplicity.
But its section _"Usage rules as determined by DPA / Usage rules SCT"_ marks
`2.84 AccountServicerReference` with an `x` in all five columns of the SCT matrix, SCT
Outgoing (SCT, Reject/Return, Recall) and SCT Incoming (SCT, Recall), the same treatment it
gives `2.82 BookingDate` and `2.83 ValueDate`. Read as: Dutch banks populate it for every SCT
variant, while the schema still permits its absence.

**READ**: `https://www.bil.com/BIL-digital/assets/doc/BIL_CAMT053_V2_final.pdf` (Banque
Internationale à Luxembourg, camt.053.001.02 implementation guidelines, dated 08.08.2023).
Keeps `[0..1]`, and adds the gloss: _"Additional info: It is known as the bank's reference"_.

#### `EndToEndId`: the debtor's own reference, and `NOTPROVIDED`

ISO definition (**READ**, §6.1.9.3.1.5):

> "Unique identification, as assigned by the initiating party, to unambiguously identify the
> transaction. This identification is passed on, unchanged, throughout the entire end-to-end
> chain."

In camt.053 it is `[0..1]`.

In the **payment initiation** direction it is mandatory under SEPA:

**READ**: `https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2024-11/EPC132-08%20SCT%20C2PSP%20IG%202025%20V1.0.pdf`
(EPC132-08, SEPA Credit Transfer Customer-to-PSP Implementation Guidelines, 2025 v1.0).
Item **2.81**, multiplicity **`1..1`**, `Max35Text`, mapped to _"AT-T014 The Originator's
Reference of the Credit Transfer Instruction."_

**READ**: `https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2024-11/EPC115-06%20SCT%20Inter-PSP%20IG%202025%20V1.0.pdf`
(EPC115-06, Inter-PSP IG 2025 v1.0). Item **2.3**, multiplicity **`1..1`**, with this SEPA
Usage Rule quoted verbatim:

> "A customer reference that must be passed on in the end-to-end chain. In the event that no
> reference was given, **"NOTPROVIDED"** must be used."

and this usage note:

> "Usage: In case there are technical limitations to pass on multiple references, the
> end-to-end identification must be passed on throughout the entire end-to-end chain."

**This is the NOTPROVIDED convention, and it is a `must`.** The consequence matters: the field
is mandatory-present, so it is never empty, but the literal string `NOTPROVIDED` is a legal
value that carries no identity at all. (**INFERRED** from the rule: a field that is
mandatory _and_ has a sanctioned null-sentinel is, for identity purposes, an optional field
wearing a mandatory field's multiplicity.)

**Uniqueness: neither EPC document I read states a uniqueness constraint on `EndToEndId`.**
The ISO definition uses the word "unique", but no rule in either IG obliges the initiating
party to make it so, and none names a scope. (**READ**, from the absence of such a rule in
the quoted items; I grepped both extracted texts for every occurrence of "End To End" and
read each hit.)

**UNVERIFIED**: real-world frequency of `NOTPROVIDED` in received statements. I found no
source measuring it.

#### `TxId`: the debtor agent's reference, and the only field with a stated uniqueness scope

ISO definition (**READ**, §6.1.9.3.1.7), `[0..1]` in camt.053:

> "Unique identification, as assigned by the first instructing agent, to unambiguously
> identify the transaction that is passed on, unchanged, throughout the entire interbank
> chain."
>
> "Usage: The instructing agent has to make sure that the transaction identification is unique
> for a **pre-agreed period**."

**READ**: EPC115-06 item **2.4**, multiplicity **`1..1`** in the interbank message, SEPA
Usage Rule:

> "Must contain a reference that is meaningful to the Originator's PSP and **is unique over
> time**. Mandatory."

So `TxId` is the one identifier whose specification says out loud that its uniqueness is
**bounded by a time window agreed between banks** rather than absolute. (**READ**, both
sentences above.) The scope of the "unique over time" claim is the Originator's PSP:
**INFERRED** from _"meaningful to the Originator's PSP"_ in the same sentence; the document
does not say "globally".

#### `InstrId`: point to point only

**READ** (ISO §6.1.9.3.1.4, and EPC132-08 item 2.80 at `0..1`, and EPC115-06 item 2.2 at
`0..1`):

> "Usage: The instruction identification is a **point to point** reference that can be used
> between the instructing party and the instructed party to refer to the individual
> instruction. It can be included in several messages related to the instruction."

Optional everywhere I read it. **INFERRED**: a point-to-point reference between two specific
parties is not expected to survive to a third party's statement, so it is the weakest of the
chain references for a statement consumer.

#### `UETR`: the only globally-shaped identifier, and it is optional

**READ**: ISO §6.1.9.3.1.6, `[0..1]`, datatype `UUIDv4Identifier`. EPC132-08 item **2.82**
and EPC115-06 item **2.5**, both `0..1`, with the pattern spelled out:
`[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}`.

**INFERRED**: a UUIDv4 is globally unique by construction, so this is the only field in the
list whose uniqueness does not depend on a scope statement. But it is optional in the SEPA
IGs and optional in camt.053, so a consumer cannot require it.

**UNVERIFIED**: how often European banks actually populate `UETR` on retail statements. I read
no source measuring it. (The datapoint I _do_ have is indirect and negative: the Firefly III
GoCardless model, read in §(c), has fields for `endToEndId`, `entryReference`, `transactionId`
and `internalTransactionId` and none for `UETR`.)

#### `MsgId`: a message reference, not a transaction reference

Two different `MsgId`s exist and they must not be conflated.

**READ**: ISO §6.1.19.9.1, the `GroupHeader` one, `[1..1]`:

> "Point to point reference, as assigned by the account servicing institution, and sent to the
> account owner or the party authorised to receive the message, to unambiguously identify the
> message."
>
> "Usage: The account servicing institution has to make sure that MessageIdentification is
> **unique per account owner for a pre-agreed period**."

That is the clearest scope statement in the whole set, and it identifies the **message**,
not a transaction. **INFERRED**: two exports of the same statement period are two messages and
will carry two different `GrpHdr/MsgId` values, so it is useless as a transaction key and
actively harmful in one (it would make every re-export look new).

**READ**: ISO §6.1.9.3.1.1, the one inside `Refs`, `[0..1]`: _"Point to point reference, as
assigned by the instructing party of the underlying message."_ This is the debtor's original
pain.001 `MsgId` echoed back, not the statement's.

#### `NtryRef`

**READ**: ISO §6.1.9.2.1, `[0..1]`: _"Unique reference for the entry."_ No assigner named, no
scope named. Both the Dutch IG (item 2.77) and BIL keep it `[0..1]`.

### Summary of (a), as sentences the sources actually support

- **READ**: no identification field on a camt.053 entry is mandatory. `Refs` itself is
  `[0..1]`, and every child of it is `[0..1]`.
- **READ**: the only _stated_ uniqueness scopes anywhere in the material are (i) `GrpHdr/MsgId`,
  per account owner, per pre-agreed period; (ii) `TxId`, "unique over time", meaningful to
  the originator's PSP, per pre-agreed period. Everything else says "unique" with no scope, or
  says nothing.
- **READ**: `EndToEndId` is mandatory in SEPA _initiation and interbank_ messages with
  `NOTPROVIDED` as the sanctioned filler, and optional in the _statement_.
- **INFERRED**: "unique" in an ISO definition is a statement about intent, not a checkable
  constraint on a received file.

---

## (b) `ValDt` vs `BookgDt` in camt.053

### Definitions, verbatim

**READ**: ISO MDR §6.1.9.2.6:

> `BookingDate <BookgDt>`: Presence: `[0..1]`. "Date and time when an entry is posted to an
> account on the account servicer's books."
>
> "Usage: Booking date is the **expected** booking date, unless the status is booked, in which
> case it is the **actual** booking date."

**READ**: ISO MDR §6.1.9.2.7:

> `ValueDate <ValDt>`: Presence: `[0..1]`. "Date and time at which assets become available to
> the account owner in case of a credit entry, or cease to be available to the account owner
> in case of a debit entry."
>
> "Usage: If entry status is pending and value date is present, then the value date refers to
> an **expected/requested** value date."
>
> "For entries subject to availability/float and for which availability information is
> provided, the value date **must not** be used. In this case the availability component
> identifies the number of availability days."

BIL's IG (**READ**, `https://www.bil.com/BIL-digital/assets/doc/BIL_CAMT053_V2_final.pdf`)
reproduces both definitions and the same `[0..1]` presence, and its worked examples show the
two diverging by a day in ordinary cases: _"Booking date: 20/03/2014 / Value date:
19/03/2014"_ and _"Booking Date: 08/07/2014 / Value date: 07/07/2014"_.

### Are both guaranteed present?

**No.** Both are `[0..1]` in the ISO message definition, in BIL's IG, and in the Dutch IG.
(**READ**, all three.)

The Dutch IG marks both `2.82 BookingDate` and `2.83 ValueDate` with an `x` across all five
columns of its SCT usage matrix (**READ**), so in that market both are expected in practice:
a _should_ expressed as a usage table, not a schema change. (**UNVERIFIED**: whether the same
holds for its SDD matrix; I read only the SCT table.)

Additionally, the ISO text contains an explicit case where `ValDt` **must be absent**: entries
subject to availability/float that carry an `Avlbty` component. (**READ**, §6.1.9.2.7,
quoted above.) That is a _must not_, and it is the one place the standard forbids rather than
permits.

### Which of the two is more likely to differ between two exports of the same statement?

**INFERRED, and I want to be explicit that I found no source that answers this question
directly.** What the sources support:

1. `BookgDt` for a **booked** entry is defined as the _actual_ posting date on the servicer's
   books: a fact about a past event that has already happened. (**READ**, §6.1.9.2.6.) A
   fact about the past has no reason to be recomputed.
2. `BookgDt` for a **pending** entry is defined as the _expected_ booking date. (**READ**,
   same sentence.) An expectation can be revised.
3. `ValDt` for a **pending** entry is likewise an _expected/requested_ value date. (**READ**,
   §6.1.9.2.7.)
4. camt.053 _"contains information on booked entries only"_ (**READ**, ISO MDR, camt.053
   Usage section). So in camt.053 specifically, case (1) is the normal case for `BookgDt`.

**INFERRED** from (1)+(4): within camt.053, `BookgDt` is the more stable of the two, because
the standard defines it as the actual posting date of an already-booked entry.

**INFERRED** from (3) and from the value-date/availability interaction in (2): `ValDt` is the
one carrying a business adjustment, interest availability, float, back-valuation, and is
therefore the one a bank has a reason to restate. The `Avlbty` rule is the tell: the standard
itself treats value-dating as a thing that can be expressed two different ways for the same
entry, which is not something it says about booking date.

**Independent corroboration that dates move at all**, from the sync side rather than the
statement side:

**READ**: `https://enablebanking.com/blog/2024/10/29/how-to-sync-account-transactions-from-open-banking-apis-without-unique-transaction-ids`
(Enable Banking, by their CTO). On **booked** transactions:

> "These transactions are considered stable because their 'fundamental values' –
> `transaction_amount`, `credit_debit_indicator`, and `booking_date` – remain constant.
> Although some transaction properties may vary due to the multiple layers involved in
> processing, the 'fundamental values' remain constant."

and, about the general case:

> "The complexity grows further if the order of transactions is not guaranteed, or if some
> transaction properties, such as **booking date or amount**, might change after they're
> initially fetched."

**Note the tension inside one document, and I am not resolving it.** The first quote says
booking date never changes once booked; the second says booking date is among the things that
might change. The reconciling reading is that the second sentence describes the general PSD2
problem and the first describes the subset the algorithm restricts itself to, but the
document does not say that, so it is **INFERRED**. What is safely **READ** is that this
vendor's recommended algorithm asserts `booking_date` should never change for a booked
transaction and treats a change as an error to log:

> "It is also good at this early stage to assert that the values of the field `booking_date`,
> `credit_debit_indicator` and `transaction_amount` have not changed (these values should
> never change)."

**UNVERIFIED**: I found no source stating a measured rate at which either date differs between
two exports of the same period. Nothing below rests on a figure I did not read.

---

## (c) How other personal-finance systems deduplicate imported transactions

### Firefly III: content hash, computed server-side, over the whole submitted row

**READ**: `https://raw.githubusercontent.com/firefly-iii/firefly-iii/main/app/Factory/TransactionJournalFactory.php`

The hash is built in `hashArray()`:

```php
private function hashArray(NullArrayObject $row): string
{
    unset($row['import_hash_v2'], $row['original_source']);
    try {
        $json = json_encode($row, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        Log::error(...);
        $json = microtime();
    }
    $hash = hash('sha256', $json);
    ...
}
```

**So the key is: SHA-256 of the JSON encoding of the entire submitted transaction row, minus
exactly two fields (`import_hash_v2`, `original_source`).** Not a chosen tuple. Everything
the importer sent, description, dates, amounts, account ids, tags, external id, notes, is in
the hash, and field order is whatever `json_encode` produces. (**READ**.)

The stored hash is `import_hash_v2`, written as journal metadata; `createJournal()` sets
`$row['import_hash_v2'] = $this->hashArray($row);` then calls `errorIfDuplicate()`. (**READ**.)

The lookup, verbatim from `errorIfDuplicate()` (**READ**):

```php
$result = TransactionJournalMeta::query()
    ->withTrashed()
    ->leftJoin('transaction_journals', ...)
    ->whereNotNull('transaction_journals.id')
    ->where('transaction_journals.user_id', $this->user->id)
    ->where('data', json_encode($hash, JSON_THROW_ON_ERROR))
    ...
```

Three things fall out, all **READ** from that snippet:

- The search is scoped to **`user_id` and nothing else**. Not to an account, not to a source,
  not to a date window.
- `withTrashed()`: **soft-deleted journals still match**. The docs confirm this is deliberate:
  _"The Data Importer will also check **deleted** transactions when checking for duplicates.
  This is on purpose!"_ and _"Even when you **delete** the original transaction, importing it
  again will result in a duplication error."_
  (**READ**: `https://raw.githubusercontent.com/firefly-iii/docs/main/docs/docs/how-to/data-importer/import/duplicates.md`)
- The whole check is behind a flag: `if (false === $this->errorOnHash) { return; }`. The
  importer sets it per import via `'error_if_duplicate_hash' => $this->configuration->isIgnoreDuplicateTransactions()`
  (**READ**: `https://raw.githubusercontent.com/firefly-iii/data-importer/main/app/Services/Nordigen/Conversion/Routine/GenerateTransactions.php`, line 200).

**Note the `$json = microtime()` fallback**: if `json_encode` throws, the row hashes to
something unique-by-clock and can never collide with anything. (**READ**. **INFERRED**: an
encode failure therefore silently degrades to "never a duplicate", which fails open.)

What the hash costs, stated by the project itself (**READ**:
`https://raw.githubusercontent.com/firefly-iii/docs/main/docs/docs/references/data-importer/duplicate-detection.md`):

> "If you change the mapping, or the roles of the data before it gets send to Firefly III, the
> hash changes"
>
> "If your bank uses new transaction IDs or changes the CapItaliZAtiON, the hash changes"

and, on the other side:

> "If you edit the transaction after it's imported, the hash remains the same, it will not be
> updated"

#### The second method: identifier-based ("cell")

**READ**: `https://raw.githubusercontent.com/firefly-iii/data-importer/main/resources/views/v2/import/004-configure/partials/duplicate-detection-options.blade.php`

The importer offers three methods: `none`, `classic` (labelled "Content-based"), `cell`
(labelled "Identifier-based"). For file imports the user names the column(s) holding the
identifier: the field accepts _"Composite identifier: Enter comma-separated numbers (e.g.,
0,3,5) to combine multiple columns"_, and a target field.

**READ**: `https://raw.githubusercontent.com/firefly-iii/data-importer/main/app/Services/Shared/Import/Routine/ApiSubmitter.php`

The identifier check is not a database key. It is a **full-text search against the Firefly III
API**:

```php
$searchModifier = config(sprintf('csv.search_modifier.%s', $field));
$query          = sprintf('%s:"%s"', $searchModifier, $value);
```

with `external-id` normalised to `external_id` and `note` to `notes`. The candidate fields are
notes, external identifier, description, internal reference (**READ**, the docs page above
lists all four).

**Scope: the search runs against the whole Firefly III instance for that API token, i.e. the
user, not the account.** (**INFERRED** from the query shape, which carries no account filter;
**READ** as corroboration, the upstream bug report below says exactly this.)

#### Is an external/provider id used when available? Yes, and it collided

**READ**: `https://raw.githubusercontent.com/firefly-iii/data-importer/main/app/Services/Nordigen/Model/Transaction.php`

```php
// overrule transaction id when empty using the internal ID:
// 2025-09-07: switch to using internal transaction ID, never "transactionId".
$object->transactionId = trim($array['internalTransactionId'] ?? '');
```

A dated in-code decision to **stop trusting the bank's `transactionId` entirely** and use
GoCardless's own id. If that is empty too, the importer synthesises one:

```php
$hash = hash('sha256', json_encode($array, JSON_THROW_ON_ERROR));
$object->transactionId = sprintf('ff3-%s', Uuid::uuid5(config('importer.namespace'), $hash));
```

i.e. a UUIDv5 over the raw payload: a content hash wearing an id's clothes. (**READ**.)

And the getter (**READ**):

```php
public function getTransactionId(): string
{
    // #10914 add account ID to transaction ID to make it unique.
    $accountId     = substr(trim(preg_replace('/\s+/', ' ', $this->accountIdentifier)), 0, 125);
    $transactionId = substr(trim(preg_replace('/\s+/', ' ', $this->transactionId)), 0, 125);
    return trim(sprintf('%s-%s', $accountId, $transactionId));
}
```

The referenced issue is worth reading as the whole argument compressed into one paragraph.

**READ**: `https://github.com/firefly-iii/firefly-iii/issues/10914`, titled _"GoCardless
importer: external_id dedupe should be per account"_:

> "While importing via GoCardless under a single requisition that contains two different bank
> accounts, I received two distinct transactions that share the same GoCardless
> internalTransactionId. GoCardless indicates this ID is unique within an account, not
> globally across accounts. The Firefly Data Importer appears to use this value as a global
> external identifier for duplicate detection; consequently, the second transaction (from a
> different account) is treated as a duplicate and skipped. In short, identifier-based
> deduplication is not scoped by account."

That is a **silent false-positive dedup**, a real transaction dropped, no error surfaced,
caused by taking a provider id at wider scope than the provider claims for it.

#### Does it work across sources?

**INFERRED, from the mechanism.** The content hash covers the entire submitted row including
`external_id` and `internal_reference`, so a CSV import and a bank-sync import of the same
transaction produce different JSON and therefore different hashes: content-based detection
will **not** recognise them as the same. The identifier method could, but only if the user
mapped a CSV column to the same `external_id` value the sync path wrote, which for GoCardless
is `accountId-internalTransactionId` and appears in no CSV. The docs support the general
point without addressing cross-source directly (**READ**, the "how to handle duplicates" page):

> "You may find your transaction has a field called `external_id` or `internal_reference`.
> These fields will sometimes be different. Spectre is known to change these sometimes for no
> good reason. **Nordigen may give pending transactions a different ID from booked
> transactions.**"

#### camt in the Firefly importer

**READ**, `https://raw.githubusercontent.com/firefly-iii/data-importer/main/app/Services/Camt/Conversion/TransactionMapper.php`, has a `case 'external-id':` writing `$current['external_id']`, so camt fields _can_ be routed to the external id, chosen by the user's role mapping. Which camt element ends up there is a per-import configuration, not a fixed choice. (**READ** the switch; **UNVERIFIED** which camt roles the UI offers by default: I did not read `config/camt.php`.)

---

### Actual Budget: `imported_id` first, then a three-pass fuzzy fallback

All of the following is **READ** from
`https://raw.githubusercontent.com/actualbudget/actual/master/packages/loot-core/src/server/accounts/sync.ts`
unless otherwise marked.

#### Where `imported_id` comes from

In `normalizeBankSyncTransactions`:

```js
trans.cleared = Boolean(trans.booked);
...
let imported_id = trans.transactionId;
if (trans.cleared && !trans.transactionId && trans.internalTransactionId) {
  imported_id = `${trans.account}-${trans.internalTransactionId}`;
}
```

So: the institution's `transactionId` is preferred; GoCardless's `internalTransactionId` is
the fallback, **only for booked transactions**, and **only prefixed with the account**: the
same account-scoping fix Firefly reached independently.

For **SimpleFIN**, the id is the provider's row id: `newTrans.transactionId = trans.id;`
(**READ**: `https://raw.githubusercontent.com/actualbudget/actual/master/packages/sync-server/src/app-simplefin/app-simplefin.js`).

For **camt file import**, the id is `AcctSvcrRef` and nothing else (**READ**:
`https://raw.githubusercontent.com/actualbudget/actual/master/packages/loot-core/src/server/transactions/import/xmlcamt2json.ts`):

```js
const id = entry.AcctSvcrRef;
const date = getDtOrDtTm(entry.ValDt) || getDtOrDtTm(entry.BookgDt);
...
if (id) { transaction.imported_id = id; }
```

Two things worth noting from that file: the camt importer **prefers `ValDt` over `BookgDt`**
for the transaction date, and where an entry has an array of `TxDtls` it emits each as a
separate transaction **with no `imported_id` at all** (the `imported_id` assignment sits only
on the single-detail branch). (**READ**.)

#### The matching algorithm

`matchTransactions()` runs in ordered passes:

**Pass 0: exact id, scoped to the account.**

```sql
SELECT * FROM v_transactions_internal WHERE imported_id = ? AND account = ?
```

with the comment _"First, match with an existing transaction's imported_id. This is the
highest fidelity match and should always be attempted first."_

**Pass 1: build a fuzzy candidate set: ±7 days, exact amount, same account.**

```sql
SELECT ... FROM v_transactions
WHERE date >= ? AND date <= ? AND amount = ? AND account = ?
```

with `sevenDaysBefore` / `sevenDaysAfter` computed from the incoming date, and the set sorted
by absolute date distance from the incoming transaction.

Under `strictIdChecking` (the default, `strictIdChecking = true` in both
`reconcileTransactions` and `matchTransactions`), an extra clause is added:

```sql
-- If both ids are set, and we didn't match earlier then skip dedup
(imported_id IS NULL OR ? IS NULL)
```

described in the comment as _"strictIdChecking has the added behaviour of only matching on
transactions with no import ID if the transaction being imported has an import ID."_

**Pass 2: among the candidate set, first unmatched row with the same payee.**

**Pass 3: among the candidate set, first unmatched row, full stop.** Comment: _"This is the
lowest fidelity matching: it just find the first transaction that hasn't been matched yet.
Remember the dataset only contains transactions around the same date with the same amount."_

`hasMatched` is a `Set` guarding against two incoming rows claiming the same existing row.

#### The bank-sync exception, which is the most quotable line in the file

```js
// If syncing an account from sync source it must not use strictIdChecking. This allows
// the fuzzy search to match transactions where the import IDs are different. It is a known quirk
// that account sync sources can give two different transaction IDs even though it's the same transaction.
const useStrictIdChecking = !acctRow.account_sync_source;
```

**READ.** So Actual deliberately **weakens** id checking on the path where an id is most
likely to exist, because it has observed that provider ids are not stable.

Corroborating that provider data needs per-institution repair at all: the sync server carries
a directory of bank-specific normalisers, e.g.
`packages/sync-server/src/app-gocardless/banks/ing_ingddeff.ts`, which sorts on
`b.valueDate || b.bookingDate` and then on a numerically-parsed `transactionId`. (**READ**.)

#### Does it work across sources?

**Yes, by construction, and this is the difference from Firefly III.** File import and bank
sync go through the _same_ function: `importTransactions` in
`packages/loot-core/src/server/accounts/app.ts` calls
`bankSync.reconcileTransactions(accountId, transactions, false, true, isPreview, ...)`
(**READ**: `https://raw.githubusercontent.com/actualbudget/actual/master/packages/loot-core/src/server/accounts/app.ts`).

**INFERRED** from that plus the passes above: a CSV row that carries no `imported_id` will be
matched against a bank-sync transaction by pass 1+2+3, same account, exact amount, within
±7 days, payee preferred, and will **update** rather than insert. But a camt file whose
`imported_id` is `AcctSvcrRef` and a GoCardless sync whose `imported_id` is
`account-internalTransactionId` both carry ids that do not match each other; under the default
`strictIdChecking = true` for file imports, the `(imported_id IS NULL OR ? IS NULL)` clause
**excludes** the sync-created row from the candidate set, and the camt row is inserted as new.
That is a cross-source duplicate, and it is a direct consequence of the strict clause.

### The two systems side by side

|                                  | Firefly III                                                                         | Actual Budget                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Primary key                      | SHA-256 over the whole submitted row                                                | provider id in `imported_id`                                                 |
| Provider id used when available? | Yes, as `external_id` (identifier method), or folded into the hash (content method) | Yes, it _is_ the key                                                         |
| Fallback when no id              | (the hash is the whole mechanism)                                                   | ±7 days + exact amount + same account, then payee, then first-unmatched      |
| Scope of the uniqueness check    | user (content hash) / whole instance (identifier search)                            | **account**, in every pass                                                   |
| Account-scoping of provider ids  | added retroactively, after a collision (#10914)                                     | built in: `${trans.account}-${internalTransactionId}`                        |
| Deleted rows                     | still match (deliberate)                                                            | `v_transactions_internal` vs `v_transactions`, selected by `reimportDeleted` |
| Cross-source                     | **INFERRED** no, for the content hash                                               | **INFERRED** yes via fuzzy, no via id                                        |

---

## (d) Provider statements on transaction-id stability

### GoCardless Bank Account Data (formerly Nordigen)

**READ**: Wayback capture 2026-06-02 of
`https://bankaccountdata.zendesk.com/hc/en-gb/articles/11529646897820-internalTransactionId-a-unique-transaction-ID-now-generated-by-GoCardless`
(via `https://web.archive.org/web/20260602125405/https://bankaccountdata.zendesk.com/hc/en-gb/articles/11529646897820-internalTransactionId-a-unique-transaction-ID-now-generated-by-GoCardless`).
Live URL 403s behind Cloudflare; see the preamble.

Verbatim:

> "These IDs are unique within the scope of one bank account (based on GoCardless
> `account_id`), meaning that they are **not globally unique** across the many bank accounts
> you might be accessing via GoCardless."

> "Note the difference between `transactionId`, which is provided by **most (but not all)**
> banks and **can vary wildly between institutions**, and `internalTransactionId`, which is
> consistent across all of GoCardless Open Banking coverage"

> "Be aware that `internalTransactionId` is **generated only for booked transactions and not
> for the pending ones**."

> "If you need unique identifiers across all connected accounts please use:
> `account_id+internalTransactionId`"

**So GoCardless guarantees scope (per account) and coverage (all institutions, booked only).
It does not, on this page, make a statement about stability across polls.** (**READ**: an
observation about what the page does not say. I read the full article text.)

The API reference is thinner still: **READ**:
`https://developer.gocardless.com/bank-account-data/transactions` describes `transactionId` as
_"Transaction identifier provided by the financial institution"_ and `internalTransactionId` as
_"Transaction identifier given by Gocardless"_, marks only `transactionAmount` as mandatory,
and carries **no warning about ids changing between polls or across the pending→booked
transition**.

**The pending→booked warning exists, but it comes from a consumer, not the provider.**

**READ**: `https://raw.githubusercontent.com/firefly-iii/docs/main/docs/docs/how-to/data-importer/import/duplicates.md`:

> "**Nordigen may give pending transactions a different ID from booked transactions.**"

**READ**: the dated code comment in the Firefly importer quoted in §(c):
_"2025-09-07: switch to using internal transaction ID, never `transactionId`."_

**READ**: the Actual comment quoted in §(c): _"It is a known quirk that account sync sources
can give two different transaction IDs even though it's the same transaction."_

**UNVERIFIED**: the body of the GoCardless incident titled _"UNICREDIT_BACXROBU
internalTransactionId will change"_
(`https://statuspage.incident.io/nordigen/incidents/01JPWCZHH9MPWV4XXSC63TZ1WB`). The title is
READ; the page renders client-side and curl returns only chrome, so I have not read what it
says. It is cited here only as evidence that _an incident with that title exists_, which is
itself a statement that `internalTransactionId` has changed for at least one institution.

### Enable Banking

**READ**: `https://enablebanking.com/docs/faq/`, section _"Are there unique identifiers for
transactions?"_. This is the most explicit provider statement I found, and it is worth quoting
at length:

> "Yes, unique transaction IDs are provided for the majority of ASPSPs in the
> `entry_reference` field. However, this is unfortunately not the case for all ASPSPs. Some do
> not provide transaction entry references at all, and some **provide duplicate values even
> though they should not**."

> "In most cases, `entry_reference` values are provided **only for booked transactions** (with
> the value `BOOK` in the status field). This is because, before an ASPSP has fully settled
> (or 'booked') a transaction, **its properties may still change or the transaction may even
> be cancelled**."

> "If an ASPSP provides a unique identifier for pending transactions (with the value `PDNG` …)
> and that identifier **remains unchanged** after the transaction becomes booked …, the API
> will also return `entry_reference` values for pending transactions. **Otherwise, pending
> transactions should be excluded when matching transactions.**"

> "Please note that the `entry_reference` value **is not globally unique**, and the same entry
> references may occur for transactions belonging to completely different accounts. However,
> for accounts with the same identification hashes, **the value is immutable**. Therefore, it
> can reliably be used to match transactions across different sessions when they refer to the
> same account at the ASPSP side."

And on the neighbouring field, section _"What is the difference between entry_reference and
transaction_id"_:

> "The `transaction_id` is used specifically for fetching additional transaction details via
> the `GET /accounts/{account_id}/transactions/{transaction_id}` endpoint. **It should not be
> used as a unique reference to identify transactions, because the value may change if the
> list of transactions is retrieved again.**"

That last sentence is the direct answer to the question as asked: **one provider states in so
many words that one of its two id-shaped fields is not stable across polls.**

One claim in the Enable Banking blog post is worth flagging because it **contradicts the ISO
material in §(a)**:

**READ**: `https://enablebanking.com/blog/2024/10/29/how-to-sync-account-transactions-from-open-banking-apis-without-unique-transaction-ids`:

> "Unlike data formats such as camt.053 or MT940, **which mandate unique identifiers**, PSD2
> and the associated regulatory technical standards do not require ASPSPs … to provide them."

The ISO MDR says `AcctSvcrRef` is `[0..1]` and `Refs` is `[0..1]` (**READ**, §(a)). camt.053
mandates no identifier. I am recording the disagreement rather than picking a side, but the
schema multiplicity is checkable and the blog sentence is not.

Their recommended algorithm, for completeness (**READ**, same article): match on
`entry_reference` if present; else match on `booking_date` + `credit_debit_indicator` +
`transaction_amount`; on multiple matches, add fields until one remains. And explicitly:

> "For instance, you can't just take a hash of the transaction data and use it as an
> identifier."

, which is, precisely, what Firefly III does.

---

## What this means for a deduplication key

Only observations that follow from what is above. Each names the source it rests on.

1. **There is no field in camt.053 that is both mandatory and identifying.** `Refs` is
   `[0..1]`, every child of it is `[0..1]`, and `AcctSvcrRef` at entry level is `[0..1]`.
   A key that _requires_ any single identifier will fail on conforming input. (**READ**, ISO
   MDR.)

2. **"Unique" in an ISO definition is unscoped almost everywhere.** The only two scope
   statements in the whole set are `GrpHdr/MsgId`, _"unique per account owner for a
   pre-agreed period"_, and `TxId`, _"unique for a pre-agreed period"_ / _"unique over
   time"_, meaningful to the originator's PSP. Both are bounded by a window nobody outside the
   two banks knows. Nothing in the material licenses treating any of these as globally unique.
   (**READ**, ISO MDR and EPC115-06.)

3. **`EndToEndId` is mandatory upstream and empty-by-convention.** EPC115-06: _"In the event
   that no reference was given, 'NOTPROVIDED' must be used."_ Any key including `EndToEndId`
   must treat the literal `NOTPROVIDED` as absence, or every unreferenced payment in a
   statement collapses into one identity. (**READ**, EPC115-06.)

4. **Provider ids are account-scoped, and both systems I read learned this the same way.**
   GoCardless states it outright, _"not globally unique across the many bank accounts"_, use
   `account_id+internalTransactionId`. Enable Banking states it outright: _"the
   `entry_reference` value is not globally unique"_. Firefly III learned it from a user
   report (#10914) after silently dropping a real transaction, and now prefixes the account.
   Actual prefixes the account in code. **An external id is a value within an account, not a
   value.** (**READ**, all four.)

5. **Booked and pending are not the same identity regime.** GoCardless generates
   `internalTransactionId` _"only for booked transactions and not for the pending ones"_.
   Enable Banking: entry references exist for pending transactions only if the ASPSP's own id
   survives the transition, _"otherwise, pending transactions should be excluded when matching
   transactions"_. Firefly's docs: _"Nordigen may give pending transactions a different ID
   from booked transactions."_ Actual only accepts the `internalTransactionId` fallback when
   `trans.cleared` is true. (**READ**, all four.) The convergence across four independent
   sources is the strongest single signal in this note.

6. **A content hash over the whole row is maximally brittle in exactly the way that matters.**
   Firefly III's own documentation names the failure: _"If your bank uses new transaction IDs
   or changes the CapItaliZAtiON, the hash changes"_, and _"If you change the mapping, or the
   roles of the data before it gets send to Firefly III, the hash changes."_ A column-mapping
   change is a user action with no visible relation to identity, and it silently re-imports
   everything. (**READ**, Firefly docs.)

7. **A content hash is also the thing one vendor explicitly warns against.** Enable Banking:
   _"you can't just take a hash of the transaction data and use it as an identifier"_, on the
   grounds that some properties change after first fetch. (**READ**.)

8. **The fallback that both non-hash designs converge on is the same triple.** Actual: same
   account + exact amount + date within ±7 days, then payee, then first-unmatched. Enable
   Banking: `booking_date` + `credit_debit_indicator` + `transaction_amount`, then add fields
   until unique. Neither uses description as a primary discriminator. Both put **account**
   and **exact amount** in the key and let the **date** be approximate. (**READ**, both.)

9. **Amount is treated as exact and date as fuzzy, never the reverse.** In Actual's SQL the
   amount is `amount = ?` while the date is a 15-day window. Enable Banking asserts amount and
   direction _"should never change"_. **INFERRED** from the pair: the date is the field
   expected to move; the amount is the field expected not to.

10. **Choosing `ValDt` or `BookgDt` is a decision, and the two systems chose differently.**
    Actual's camt importer takes `getDtOrDtTm(entry.ValDt) || getDtOrDtTm(entry.BookgDt)`:
    value date first. Enable Banking's algorithm keys on `booking_date` and calls it a
    fundamental value that should never change. **INFERRED** from §(b): for camt.053, which
    _"contains information on booked entries only"_, `BookgDt` is the actual posting date of a
    past event and `ValDt` is the one carrying business adjustment, so a key built on `ValDt`
    is built on the more mutable of the two. I did not find a source that measures this.

11. **Deleted-row policy is part of the key, not separate from it.** Firefly matches
    soft-deleted journals on purpose, so a deletion does not permit a re-import; Actual selects
    between `v_transactions_internal` and `v_transactions` on a `reimportDeleted` flag. Either
    is defensible; leaving it undecided means the answer is whatever the query happens to do.
    (**READ**, both.)

12. **Two identifiers with the same shape can have opposite guarantees, and the names do not
    tell you which.** Enable Banking's `entry_reference` is _"immutable"_ per account;
    its `transaction_id` _"should not be used as a unique reference … because the value may
    change if the list of transactions is retrieved again."_ Both are strings on the same
    object. (**READ**.) The check is to find the provider's sentence about the specific field,
    not to reason from its name.
