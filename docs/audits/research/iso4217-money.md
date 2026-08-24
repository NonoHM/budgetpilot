# ISO 4217 and money representation: primary-source research

Research performed 2026-08-21 for a BudgetPilot design note. Every claim below is tagged
**READ** (fetched, with the URL), **INFERRED** (derived, from what), or **UNVERIFIED**
(what was tried and why it failed).

The two published XML files were downloaded and parsed mechanically rather than read by eye;
the parsing commands and their output are reproduced where a count is asserted.

**One typographic note, because it touches quoted material.** This repository's prose rule
(`AGENTS.md`, gated by `src/lib/prose/emDashesInProse.spec.ts`) allows no em dash in a tracked
Markdown file. Where a quoted source used one, it is rendered here as a comma or a colon. No
quoted wording is altered, only that character.

---

## Headline

**The ten-code claim in (a) is REFUTED**, and it is refuted at the root rather than
code-by-code: **the published List Three XML carries no minor-unit field at all**, for any of
its 169 entries. There is no "List Three exponent" for any code to disagree with. Separately,
within List One the mapping `currency code → exponent` **is** a function: no code carries two
different `CcyMnrUnts` values.

Two independent corroborations arrived from other directions. ISO 20022 attaches a normative
textual rule to its amount datatypes, _"The number of fractional digits (or minor unit of
currency) must comply with ISO 4217"_, which presumes exactly one minor-unit value per code and
could not be stated in that form otherwise (see (d) and (e)). And the ten codes' presence in both
lists has a mundane explanation that the data itself supplies: List Three is keyed on the
**(entity, currency-name) pairing**, so a country rename, a country split, or a revision of the
currency's _name_ puts a still-current code in the historic list. Not one of the ten involves a
change of subdivision (see (a)).

The claim's actual source was located: it is a **Wikipedia template**, `Template:ISO 4217/code-minor-unit`,
whose ten-code list is correct and whose "These have different exponents" sentence describes its
own internal data rather than anything ISO publishes.

The design consequence is _not_ that exponents must be stored per amount. It is that the exponent
must be stored per **currency**, sourced deliberately, because the sources disagree with each
other (CLDR diverges from ISO on 15 current codes), because the set of current codes changes over
time (ANG existed in 2024 and does not now), and because 13 codes have no exponent at all.

---

## (a) The central claim: does a code have two different exponents across List One and List Three?

### What was fetched

**READ**: `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml`
(HTTP 200, 47 463 bytes).

**READ**: `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-three.xml`
(HTTP 200, 30 638 bytes).

Both carry the same publication attribute on the root element:

```xml
<ISO_4217 Pblshd="2026-01-01">
```

**READ**, both URLs are the ones linked from the SIX data-standards page itself (see (c)), so
these are the maintenance agency's own files, not a mirror.

### The structural finding that settles the question

**READ**: element-tag census of each file:

```
list-three.xml            list-one.xml
  169 <HstrcCcyNtry>        280 <CcyNtry>
  169 <CtryNm>              280 <CtryNm>
  169 <Ccy>                 277 <Ccy>
  169 <WthdrwlDt>           277 <CcyNbr>
  167 <CcyNm>               277 <CcyMnrUnts>
  166 <CcyNbr>              272 <CcyNm>
    0 <CcyMnrUnts>   <==
```

> `grep -c "CcyMnrUnts" list-three.xml` → **0**

**READ**: the historic list has **zero** `CcyMnrUnts` elements. A List Three entry consists of
entity, currency name, alphabetic code, numeric code and withdrawal date. It carries no minor
unit, no exponent, and no decimal information of any kind.

**INFERRED** (from the above): the premise of the claim, that each code has "an exponent in
List Three", does not correspond to anything in the published data. The claim cannot hold for
any code, because the quantity it compares does not exist in the source it names.

**READ**: this is not a recent removal. The predecessor file at the old maintenance-agency
domain, fetched via the Wayback Machine
(`https://web.archive.org/web/2017/https://www.currency-iso.org/dam/downloads/dl_iso_table_a3.xml`,
HTTP 200, 39 555 bytes), uses a different schema entirely
(`<ISO_CCY_CODES_HISTORIC>` / `<ISO_CURRENCY_HISTORIC>` with `ENTITY`, `CURRENCY`,
`ALPHABETIC_CODE`, `NUMERIC_CODE`, `WITHDRAWAL_DATE`, `REMARK`) and likewise contains **0**
occurrences of any minor-unit field.

### Is the mapping a function _within_ List One?

**READ**: grouping all 280 List One entries by `Ccy` and collecting the distinct
`CcyMnrUnts` per code: **no code has more than one distinct value.** The set of codes with

> 1 distinct exponent inside List One is empty. EUR, which appears on 37 country rows, carries
> `2` on all 37.

**READ**: List One has 280 `<CcyNtry>` elements but only **178 distinct alphabetic codes**; the
excess is one row per country/territory. Three rows have no `<Ccy>` at all: ANTARCTICA,
PALESTINE (STATE OF), and SOUTH GEORGIA AND THE SOUTH SANDWICH ISLANDS, each with currency name
"No universal currency".

**READ**: List Three has 169 entries and **137 distinct alphabetic codes**.

### Per-code table

Exponents are `CcyMnrUnts` values. "n/a: field does not exist" means the List Three schema has
no such element, not that the element is present and empty.

| Code    | List One exponent                    | List Three exponent(s)                | Verdict on the claim                                                                                                   |
| ------- | ------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **ANG** | **absent**, no List One entry at all | n/a, field does not exist (3 entries) | **REFUTED.** Not in both lists. ANG is fully withdrawn; List One's replacement is XCG (Caribbean Guilder, exponent 2). |
| **EUR** | **2** (all 37 country rows)          | n/a: field does not exist (1 entry)   | **REFUTED.** No List Three exponent exists to differ.                                                                  |
| **HRK** | **absent**, no List One entry at all | n/a, field does not exist (2 entries) | **REFUTED.** Not in both lists. Croatia adopted the euro; HRK is fully withdrawn.                                      |
| **IDR** | **2**                                | n/a, field does not exist (1 entry)   | **REFUTED.**                                                                                                           |
| **MWK** | **2**                                | n/a, field does not exist (1 entry)   | **REFUTED.**                                                                                                           |
| **PEN** | **2**                                | n/a, field does not exist (1 entry)   | **REFUTED.**                                                                                                           |
| **RON** | **2**                                | n/a, field does not exist (1 entry)   | **REFUTED.**                                                                                                           |
| **SDG** | **2**                                | n/a, field does not exist (1 entry)   | **REFUTED.**                                                                                                           |
| **SZL** | **2**                                | n/a, field does not exist (1 entry)   | **REFUTED.**                                                                                                           |
| **TRY** | **2**                                | n/a, field does not exist (1 entry)   | **REFUTED.**                                                                                                           |

**Verdict: 0 of 10 hold. Two of the ten (ANG, HRK) are not even in both lists.**

### Why these ten codes _do_ appear twice: the real mechanism

**READ**: the full entity/name pairing for each code, extracted from both files:

| Code | List One (entity \| name)     | List Three (entity \| name \| withdrawn)                                                                                                 | What actually changed                                |
| ---- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| ANG  | ,                             | CURAÇAO \| Netherlands Antillean Guilder \| 2025-03<br>NETHERLANDS ANTILLES \| … \| 2010-10<br>SINT MAARTEN (DUTCH PART) \| … \| 2025-03 | Code withdrawn outright (→ XCG)                      |
| EUR  | 37 euro-area entities \| Euro | SERBIA AND MONTENEGRO \| Euro \| 2006-10                                                                                                 | **Entity dissolved**; the euro is unchanged          |
| HRK  | ,                             | CROATIA \| Croatian Kuna \| 2015-06<br>CROATIA \| Kuna \| 2023-01                                                                        | Name revision, then code withdrawn (→ EUR)           |
| IDR  | INDONESIA \| Rupiah           | TIMOR-LESTE \| Rupiah \| 2002-07                                                                                                         | **Entity stopped using it**; the rupiah is unchanged |
| MWK  | MALAWI \| Malawi Kwacha       | MALAWI \| Kwacha \| 2016-02                                                                                                              | **Currency-name revision only**                      |
| PEN  | PERU \| Sol                   | PERU \| Nuevo Sol \| 2015-12                                                                                                             | **Currency-name revision only**                      |
| RON  | ROMANIA \| Romanian Leu       | ROMANIA \| New Romanian Leu \| 2015-06                                                                                                   | **Currency-name revision only**                      |
| SDG  | SUDAN (THE) \| Sudanese Pound | SOUTH SUDAN \| Sudanese Pound \| 2012-09                                                                                                 | **Entity split**; the pound is unchanged             |
| SZL  | ESWATINI \| Lilangeni         | SWAZILAND \| Lilangeni \| 2018-08                                                                                                        | **Entity-name revision only**                        |
| TRY  | TÜRKİYE \| Turkish Lira       | TURKEY \| New Turkish Lira \| 2009-01                                                                                                    | **Entity- and currency-name revision**               |

**INFERRED** (from the table above, which is read directly from both files): List Three is keyed
on the **(entity, currency-name) pairing**, not on the code. An entry lands there whenever a
pairing stops being current, because the country was renamed, split or dissolved, or because
the currency's _name_ was revised. In **not one** of the ten cases did the currency's
subdivision change. Seven of the ten are pure metadata revisions to the same living currency
(MWK, PEN, RON, SZL, TRY are renames; EUR, IDR, SDG are entity events). Two (ANG, HRK) are real
withdrawals where the code left List One entirely.

**READ**: the claim's actual origin is a Wikipedia template, not ISO. `Template:ISO 4217/code-minor-unit`
(`https://en.wikipedia.org/wiki/Template:ISO_4217/code-minor-unit`) states verbatim:

> "10 codes are ambiguous: they appear both obsolete and active: |ANG|EUR|HRK|IDR|MWK|PEN|RON|SDG|SZL|TRY"

and

> "These have different exponents"

with an `|is-obsolete=no/yes` parameter to disambiguate. **INFERRED**: the ten-code list is real
and correctly identifies codes present in both lists; the "different exponents" sentence
describes Wikipedia's own internal template data, which assigns values ISO does not publish.
The design brief's instruction to go to SIX rather than a Wikipedia template was exactly the
right instinct: the two sources disagree, and SIX is the one that owns the data.

### Consequence for the design

**INFERRED**: `currency code → exponent` **is** a total function over the current codes, as
published by the maintenance agency. ISO 4217 gives no basis for storing an exponent per amount.
There are still good reasons a ledger might store one anyway: see (b) and the CLDR divergence
in (c), and note that the _set_ of current codes changes over time (ANG existed and now does
not), so a historic amount's code may no longer be in List One. But "the same code has two
exponents" is not one of those reasons, and should not be cited as one.

### The full set of exponents in use

**READ**: distinct `CcyMnrUnts` values across all 277 List One entries carrying the element:

```
     31  0
    224  2
      7  3
      2  4
     13  N.A.
```

By distinct code:

| Exponent   | Distinct codes | Representative currencies                                                                                                                                                                                   |
| ---------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**      | 17             | JPY (Yen), KRW (Won), ISK (Iceland Krona), CLP (Chilean Peso), VND (Dong), PYG (Guarani), UGX (Uganda Shilling), XAF/XOF (CFA Franc BEAC/BCEAO), XPF (CFP Franc), VUV (Vatu), BIF, DJF, GNF, KMF, RWF, UYI  |
| **2**      | 139            | USD, EUR, GBP, CHF, CAD, AUD, CNY, INR, BRL, ZAR, and MRU and MGA (see (b))                                                                                                                                 |
| **3**      | 7              | BHD (Bahraini Dinar), IQD (Iraqi Dinar), JOD (Jordanian Dinar), KWD (Kuwaiti Dinar), LYD (Libyan Dinar), OMR (Rial Omani), TND (Tunisian Dinar), **the complete list**                                      |
| **4**      | 2              | CLF (Unidad de Fomento), UYW (Unidad Previsional), **the complete list**                                                                                                                                    |
| **`N.A.`** | 13             | XAU (Gold), XAG (Silver), XPT (Platinum), XPD (Palladium), XDR (SDR), XSU (Sucre), XUA (ADB Unit of Account), XBA/XBB/XBC/XBD (Bond Markets Units), XTS (testing), XXX (no currency), **the complete list** |

**READ**: the answer to "does any entry have no exponent": yes, thirteen. The element is
**present** and its text is the literal string `N.A.`: it is not an empty element and not an
absent element. Verbatim, for the two codes the brief named:

```xml
<CcyNtry>
    <CtryNm>ZZ08_Gold</CtryNm>
    <CcyNm>Gold</CcyNm>
    <Ccy>XAU</Ccy>
    <CcyNbr>959</CcyNbr>
    <CcyMnrUnts>N.A.</CcyMnrUnts>
</CcyNtry>

<CcyNtry>
    <CtryNm>INTERNATIONAL MONETARY FUND (IMF) </CtryNm>
    <CcyNm>SDR (Special Drawing Right)</CcyNm>
    <Ccy>XDR</Ccy>
    <CcyNbr>960</CcyNbr>
    <CcyMnrUnts>N.A.</CcyMnrUnts>
</CcyNtry>
```

Note two incidental traps visible in those lines. The "entity" for gold is the pseudo-code
`ZZ08_Gold` rather than a country, so anything joining List One on `CtryNm` must expect
non-countries (the metals and the bond units all use `ZZnn_` pseudo-entities).

And the IMF's entity name ends in a **U+00A0 NO-BREAK SPACE**, not a plain space. **READ**: the
full census of untrimmed text nodes across both files, by exact character:

| File       | Field    | Count | Values                                                 |
| ---------- | -------- | ----- | ------------------------------------------------------ |
| list-one   | `CcyNm`  | 1     | `Comorian Franc ` (trailing U+0020)                    |
| list-one   | `CtryNm` | 1     | `INTERNATIONAL MONETARY FUND (IMF)` + **U+00A0**       |
| list-three | `CcyNm`  | 2     | `Nuevo Sol `, `New Romanian Leu ` (trailing U+0020)    |
| list-three | `CtryNm` | 2     | `BURMA` + **U+00A0**, `SOUTHERN RHODESIA` + **U+00A0** |

**INFERRED**: six values across the two files need trimming, and two distinct whitespace
characters are involved. JavaScript's `String.prototype.trim()` and Python's `str.strip()` both
remove U+00A0, so an explicit trim is sufficient, but an equality comparison, a `split(' ')`, or
a regex `\s` in an engine where `\s` is ASCII-only will not see it, and the failure is invisible
in any rendering. Two of the six are `Nuevo Sol ` and `New Romanian Leu `, which are precisely
two of the ten codes in (a), so a naive name-based dedupe between the lists would already
stumble here. Any parser expecting an integer must handle the string `N.A.`, and any schema
typing this field as an integer will fail on 13 of 178 codes. XAU, XAG and XDR are exactly the
codes the brief asked about, and all three are `N.A.`

**INFERRED**: `N.A.` is confined to the metals, the composite/bond units, the test code and the
no-currency code. Every entry naming a currency a person can hold has a numeric exponent.

---

## (b) Non-decimal currencies: MRU and MGA

### What ISO actually assigns

**READ**, from `list-one.xml`, verbatim:

```xml
<CcyNtry>
    <CtryNm>MADAGASCAR</CtryNm>
    <CcyNm>Malagasy Ariary</CcyNm>
    <Ccy>MGA</Ccy>
    <CcyNbr>969</CcyNbr>
    <CcyMnrUnts>2</CcyMnrUnts>
</CcyNtry>
```

```xml
<CcyNtry>
    <CtryNm>MAURITANIA</CtryNm>
    <CcyNm>Ouguiya</CcyNm>
    <Ccy>MRU</Ccy>
    <CcyNbr>929</CcyNbr>
    <CcyMnrUnts>2</CcyMnrUnts>
</CcyNtry>
```

**READ**: **ISO 4217 assigns both MRU and MGA a minor unit of `2`.** Not `0`, not a fractional
or base-5 value, and not `N.A.` The published list does not model the real 1:5 subdivision at
all.

**READ**: the predecessor codes MRO and MGF are both present in List Three (and, per (a), carry
no minor unit there).

**INFERRED**: the folklore that ISO 4217 encodes "0.699 decimal digits" or similar for these
currencies is wrong about the published data. ISO's minor unit is a count of decimal places for
representing the amount, and for MRU/MGA it is simply set to 2, which means one ouguiya is
represented as `1.00`, and the khoum, which is one fifth, is `0.20`. The exponent is a
_representation_ decision, and ISO's choice makes the real subdivision expressible as an exact
2-decimal value (0.20, 0.40, 0.60, 0.80) rather than trying to encode base 5.

### How systems handle the mismatch

**READ**: Unicode CLDR `supplementalData.xml`
(`https://raw.githubusercontent.com/unicode-org/cldr/main/common/supplemental/supplementalData.xml`),
the `<currencyData><fractions>` block, verbatim:

```xml
<info iso4217="MGA" digits="0" rounding="0"/>
<info iso4217="MRU" digits="2" rounding="0" cashDigits="2" cashRounding="20"/>
<info iso4217="MRO" digits="0" rounding="0"/>
<info iso4217="MGF" digits="0" rounding="0"/>
```

**READ**: CLDR's own definitions of these attributes, from UTS #35 Part 3
(`https://unicode.org/reports/tr35/tr35-numbers.html#Supplemental_Currency_Data`), verbatim:

> **digits**: "the minimum and maximum number of decimal digits normally formatted. The default is 2."
>
> **rounding**: "the rounding increment, in units of 10⁻digits. The default is 0, which means no rounding is to be done."
>
> **cashDigits**: "the number of decimal digits to be used when formatting quantities used in cash transactions (as opposed to a quantity that would appear in a more formal setting, such as on a bank statement)."
>
> **cashRounding**: "the cash rounding increment, in units of 10⁻cashDigits. The default is 0, which means no rounding is to be done."

And, decisively for the relationship to ISO:

> "This value of this field is based on the 'minor unit' value from ISO 4217, but may deviate from ISO 4217 where there is compelling evidence for different customary practice."

**INFERRED** from the CLDR values plus those definitions: this is the actual answer to "how do
systems handle the mismatch", and the two currencies are handled _differently_:

- **MRU**: CLDR keeps ISO's `digits="2"` but adds `cashRounding="20"` at `cashDigits="2"`: i.e.
  cash amounts are rounded to the nearest **0.20 MRU**, which is exactly one khoum. The real
  base-5 subdivision is modelled as a **rounding increment on a decimal representation**, not as
  a non-decimal exponent. This is the technique that generalises: keep the amount decimal, and
  express the physical subdivision as an increment.
- **MGA**: CLDR **overrides ISO entirely**, setting `digits="0"`: the iraimbilanja is treated as
  no longer circulating, so ariary amounts are formatted with no decimals at all.

**READ**: a third strategy, from the Ruby `money` gem's currency table
(`https://raw.githubusercontent.com/RubyMoney/money/main/config/currency_iso.json`), which stores
a _subunit ratio_ rather than an exponent:

```
MRU  subunit "Khoums"        subunit_to_unit 5
MGA  subunit "Iraimbilanja"  subunit_to_unit 1
KWD  subunit "Fils"          subunit_to_unit 1000
USD  subunit "Cent"          subunit_to_unit 100
CLF  subunit "Peso"          subunit_to_unit 10000
```

**INFERRED**: `subunit_to_unit` is a ratio, not a power of ten, so it can represent MRU's real
1:5 division exactly, and that library does, diverging from ISO's `2`. For MGA it uses `1`,
agreeing with CLDR that the subdivision is defunct and disagreeing with ISO's `2`. So of the
three sources checked, **all three disagree with each other on MGA**, and two of three disagree
with ISO on MRU.

**INFERRED, and this is the design-relevant point**: an integer-minor-units store with a
power-of-ten exponent per currency cannot represent one khoum as an integer if the exponent is
0, but _can_ if the exponent is 2 (one khoum = 20 minor units). ISO's choice of `2` is therefore
the one that keeps integer-minor-unit storage lossless for MRU. The mismatch shows up not in
storage but in **display and in cash rounding**, which is precisely where CLDR puts it.

---

## (c) Where a machine-readable list lives, cadence, licence, and packages

### Exact URLs

**READ**: enumerated from the anchors on the SIX data-standards page itself
(`https://www.six-group.com/en/products-services/financial-information/data-standards.html`,
which 301s to `.../market-reference-data/data-standards.html`), fetched with a real browser
because the page is JS-rendered:

| List                               | Format  | URL                                                                                                                                   |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| List One, Current Currency & Funds | XML     | `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml`                           |
| List One                           | XLS     | `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xls`                           |
| List Two, Current Funds Codes      | **DOC** | `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-two.doc`                           |
| List Three, Historical             | XML     | `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-three.xml`                         |
| List Three                         | XLS     | `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-three.xls`                         |
| All past amendments                | XLSX    | `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/amendments/lists/overview-amendments.xlsx`    |
| Latest amendment (no. 180)         | PDF     | `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/amendments/dl-currency-iso-amendment-180.pdf` |

Note the URL path contains the typo `iso-currrency` (three r's). That is the real path.

**READ**: there is **no `list-two.xml`**. `.../lists/list-two.xml` returns HTTP 404. List Two is
published only as a Word document. **INFERRED**: a machine-readable pipeline can consume List
One and List Three but not List Two.

**READ**: the legacy domain `currency-iso.org` still resolves through the Wayback Machine with
the old filenames `dl_iso_table_a1.xml` / `dl_iso_table_a3.xml` and a _different_ element schema.
**INFERRED**: any code written against the old `<ISO_CURRENCY_HISTORIC>` / `ALPHABETIC_CODE`
element names will not parse today's files, which use `<HstrcCcyNtry>` / `<Ccy>`.

### Cadence

**READ**: the SIX page states, verbatim:

> "Changes to the currency codes lists occur if a currency is created, withdrawn or parts thereof altered."

**READ**: there is **no fixed republication schedule stated anywhere on the page.** Publication
is event-driven and announced as numbered amendments (the current one is no. 180). The XML root
attribute `Pblshd="2026-01-01"` is the publication date of the file currently served.

**READ**: the page also offers a newsletter subscription "for ISO 4217 Currency codes" so that
users are notified of changes. **INFERRED**: the amendment feed / newsletter, not a polling
schedule, is the intended change-detection mechanism.

**READ**: an instructive detail from the amendment notice currently on the page, verbatim:

> "Effective from 01.01.2026, the following change will be made to "List Three: Historical (Currencies & Funds)":
> Entity | Currency | Alphabetic Code | Numeric Code | Minor Unit
> Bulgaria | Bulgarian Lev | BGN | 975 | 2"

**INFERRED, and worth flagging**: the _amendment table_ has a "Minor Unit" column for the List
Three row, even though the published `list-three.xml` has no such element. So the maintenance
agency does know a minor unit for a historic entry: it simply does not carry it into the
machine-readable historic file. This is the most charitable reading available of where a claim
like (a)'s could have come from; it still does not produce two different exponents for one code.

**READ**: the page also links a "Maintenance Agency Guidelines" PDF at
`.../iso-currrency/maintenance-agency-guidelines.pdf`. It was fetched and its text extracted
(9 pages): **it is the guidelines for ISO 10962 (CFI codes), not ISO 4217**: its title is
"Guidelines for the maintenance of ISO 10962 Classification of Financial Instruments" and it
contains no occurrence of "minor unit", "exponent" or "decimal". Either the link is misfiled or
the same document serves both. **UNVERIFIED**: no ISO 4217 maintenance-agency guidelines document
was located; this is the only such link on the page and it points at the wrong standard.

### Licence and terms of use: what it actually says

**READ**: the SIX data-standards page states, verbatim:

> "SIX is the official Maintenance Agency of these currency codes under ISO 4217 and as such the only recognized, authoritative source on currency code designations."

> "SIX provides these currency code service on behalf of the International Organization for Standardization (ISO) and its Swiss member SNV (Swiss Association for Standardization). We maintain the code lists, update them and make them available online and free of charge."

**READ**: "free of charge" is the _only_ permission-flavoured statement on the data-standards
page. The page carries **no licence, no copyright notice on the data, and no redistribution
grant.**

**READ**: the site-wide Terms of Use (`https://www.six-group.com/en/services/legal/terms-of-use.html`),
verbatim:

> "The entire content of the SIX website is protected by copyright law."

and the site states its information is provided

> "exclusively for personal use as well as information purposes"

with presentations, brochures, flyers, graphics, texts, designs and charts not to be
"reproduced or reused in any way or used for commercial purposes", and

> "SIX reserves the right to take legal action in the event of any breach or violation of this provision."

**INFERRED, and stated as a caution rather than a conclusion**: "available online and free of
charge" (data-standards page) and "the entire content of the SIX website is protected by
copyright law … exclusively for personal use" (site-wide terms) point in different directions,
and **no explicit redistribution grant for the code lists was found anywhere.** This is a real
ambiguity, not a gap in the search. Vendoring the list into a public repository is a decision
that should be made with that ambiguity acknowledged rather than assumed away.

**UNVERIFIED**: no ISO-4217-specific licence page, data licence, or "terms of use for the code
lists" document was found. What was tried: the data-standards page (browser-rendered, all anchors
enumerated), the linked Terms and Conditions hub, the Terms of Use page, and the Maintenance
Agency Guidelines PDF. None contains a data-redistribution clause.

### Packages that vendor the list

**READ**: **`datasets/currency-codes`** (`https://github.com/datasets/currency-codes`):

- Sources "ISO Tables A.1 - Current Currencies and Funds" and "ISO Tables A.3 - List of codes for
  historic denominations of currencies & funds" from the SIX data-standards portal: i.e. exactly
  the two XML files fetched above.
- Update mechanism is a checked-in script, `./scripts/runall.sh`, which "download[s] and
  convert[s] the data from XML to CSV" using `xmllint`. Raw XML is archived under `./archive/`,
  cleaned output at `./data/codes-all.csv`.
- **No stated update schedule**: the script exists but nothing runs it on a cadence.
- Licence: the data is placed "in the Public Domain under the Public Domain Dedication and
  License", justified on the grounds that the original source "states no restriction on use and
  the data is small and completely factual". **INFERRED**: that justification is the maintainers'
  own reading of the SIX position, and it sits alongside the site-wide terms quoted above; it is
  an assertion, not a grant from SIX.

**READ**: **Unicode CLDR** (`common/supplemental/supplementalData.xml`, fetched from
`unicode-org/cldr` main). Not a vendoring of ISO 4217 but a deliberately _divergent_ derivative:
per (b), UTS #35 says the digits value is "based on the 'minor unit' value from ISO 4217, but may
deviate … where there is compelling evidence for different customary practice." CLDR ships on a
published release cadence and adds `cashDigits`/`cashRounding`, which ISO does not have. **This
is the better-maintained source of the two if the goal is correct display**, and the worse one if
the goal is agreeing with a bank's ISO-conformant file.

**READ**: the extent of the divergence was measured, not estimated: joining CLDR's `digits`
(falling back to its declared `DEFAULT` of 2 where a code has no `<info>` row) against ISO's
`CcyMnrUnts` over all 178 current codes, and excluding the 13 `N.A.` codes as not comparable,
**CLDR disagrees with ISO on exactly 15 current codes**, and in every case CLDR is _lower_:

| Code                                                                 | ISO `CcyMnrUnts` | CLDR `digits` |
| -------------------------------------------------------------------- | ---------------- | ------------- |
| AFN, ALL, COP, HUF, IDR, IRR, KPW, LAK, LBP, MGA, MMK, SOS, SYP, YER | **2**            | **0**         |
| **IQD**                                                              | **3**            | **0**         |

IQD is the widest gap: ISO publishes three decimal places for the Iraqi dinar, CLDR formats it
with none: a factor of 1000.

**READ**: CLDR also carries cash-rounding conventions that ISO has no field for at all:
`cashRounding="5"` for CHF and CAD (the Swiss 5-rappen and Canadian nickel), `cashRounding="50"`
for DKK (the Danish 50-øre), and `cashDigits="0" cashRounding="0"` for AMD, CRC, CZK, GYD, MNT,
MUR, NOK, PKR, RSD, SEK, TWD, TZS and UZS.

**INFERRED**: a system that formats from CLDR and validates against ISO will disagree with
itself on 15 currencies, IDR and IQD among them. The two sources are answering different
questions, ISO says how many decimals the _standard_ assigns, CLDR says how many a _person in
that locale expects to see_, and neither is wrong. The design consequence is that the exponent
used for storage and the digit count used for display must be allowed to differ, and must be
sourced deliberately rather than from whichever table happened to be at hand.

**READ**: **`RubyMoney/money`** (MIT licence): ships `config/currency_iso.json` with 173
currencies keyed by lowercased code, storing `subunit`, `subunit_to_unit` and
`smallest_denomination` rather than an exponent (the `exponent` field is `null` in the data and
derived at runtime). Per (b) it disagrees with ISO on both MRU and MGA. **UNVERIFIED**: the
repository README does not document where `currency_iso.json` is sourced from or how it is
refreshed; no automated sync was found.

**READ**: **`currency-codes`** on npm (v2.2.0, MIT). Its README's own reference link for the
standard is `http://en.wikipedia.org/wiki/ISO_4217`: **it cites Wikipedia, not SIX.** **INFERRED**:
given (a), a package sourced from the Wikipedia templates is a package that can inherit the
Wikipedia templates' claims. Not recommended as an authority.

---

## (d) ISO 20022: how an amount is represented

**UNVERIFIED at source**: `iso20022.org` schema downloads for the message sets tried returned
HTTP 404, and no XSD was obtained directly from iso20022.org. **READ** as a fallback: two
independent third-party repositories of the _generated_ official schemas, whose headers identify
them as machine-generated by the ISO 20022 Standards Editor. They agree exactly with each other,
which is the cross-check.

- `https://raw.githubusercontent.com/kedder/ofxstatement-iso20022/master/doc/camt.053.001.05.xsd`:
  header: `<!--Generated by Standards Editor (build:R1.6.5.2_DEV) on 2015 Feb 24 14:06:12, ISO 20022 version : 2013-->`,
  target namespace `urn:iso:std:iso:20022:tech:xsd:camt.053.001.05`.
- `https://raw.githubusercontent.com/yudhik/example-iso-20022/master/src/main/java/id/brainmaster/iso20022/model/pacs.008.001.07.xsd`:
  target namespace `urn:iso:std:iso:20022:tech:xsd:pacs.008.001.07`.

**INFERRED**: these are faithful copies (generator stamp, ISO namespace URN, byte-identical
definitions across two unrelated repos), so the facets below deserve high confidence; but they
are copies, and the definitive statement would come from iso20022.org itself.

### The datatypes, verbatim

From `pacs.008.001.07.xsd`:

```xml
<xs:complexType name="ActiveCurrencyAndAmount">
    <xs:simpleContent>
        <xs:extension base="ActiveCurrencyAndAmount_SimpleType">
            <xs:attribute name="Ccy" type="ActiveCurrencyCode" use="required"/>
        </xs:extension>
    </xs:simpleContent>
</xs:complexType>

<xs:simpleType name="ActiveCurrencyAndAmount_SimpleType">
    <xs:restriction base="xs:decimal">
        <xs:fractionDigits value="5"/>
        <xs:totalDigits value="18"/>
        <xs:minInclusive value="0"/>
    </xs:restriction>
</xs:simpleType>

<xs:simpleType name="ActiveCurrencyCode">
    <xs:restriction base="xs:string">
        <xs:pattern value="[A-Z]{3,3}"/>
    </xs:restriction>
</xs:simpleType>
```

And the historic-tolerant variant, identical in its facets (present in both files):

```xml
<xs:complexType name="ActiveOrHistoricCurrencyAndAmount">
    <xs:simpleContent>
        <xs:extension base="ActiveOrHistoricCurrencyAndAmount_SimpleType">
            <xs:attribute name="Ccy" type="ActiveOrHistoricCurrencyCode" use="required"/>
        </xs:extension>
    </xs:simpleContent>
</xs:complexType>

<xs:simpleType name="ActiveOrHistoricCurrencyAndAmount_SimpleType">
    <xs:restriction base="xs:decimal">
        <xs:fractionDigits value="5"/>
        <xs:totalDigits value="18"/>
        <xs:minInclusive value="0"/>
    </xs:restriction>
</xs:simpleType>

<xs:simpleType name="ActiveOrHistoricCurrencyCode">
    <xs:restriction base="xs:string">
        <xs:pattern value="[A-Z]{3,3}"/>
    </xs:restriction>
</xs:simpleType>
```

### Answers to the three questions asked

1. **How many fraction digits does the XSD allow?** **READ**: `fractionDigits value="5"`, with
   `totalDigits value="18"`. So at most 5 decimal places and at most 18 significant digits in
   total. Also `minInclusive value="0"`: **the amount type cannot be negative**; direction is
   carried elsewhere (a credit/debit indicator), never by the sign of the amount.

2. **Is the currency an attribute of the amount?** **READ**: yes, literally: `Ccy` is an XML
   _attribute_ on the amount element, and `use="required"`. The amount and its currency are one
   value, and an amount cannot be serialised without a currency. The wire form is
   `<Amt Ccy="EUR">1234.56</Amt>`.

3. **Per-amount decimals, or implied by the currency code?** **Implied by the currency code,
   normatively, by a named rule, but the rule lives outside the XSD.**

   **READ from the schema**: the XSD alone expresses neither. It permits up to 5 fraction digits
   for _every_ currency and does not vary the facet by code; the `Ccy` attribute is only
   pattern-checked as three uppercase letters, with no cross-check against ISO 4217 at all.
   `ActiveCurrencyCode` and `ActiveOrHistoricCurrencyCode` have identical patterns and differ only
   in name.

   **READ from the Message Definition Report** (see (e) for the full quotation and URL): ISO 20022
   attaches a textual constraint named **`CurrencyAmount`** to both datatypes:
   _"The number of fractional digits (or minor unit of currency) must comply with ISO 4217."_

   **INFERRED**, and this gap is the practically important part: the schema's `fractionDigits 5`
   is a ceiling generous enough to cover the exponent-4 currencies (CLF, UYW) plus headroom; the
   `CurrencyAmount` rule is what actually narrows it per currency; and **the rule is not
   expressible as an XSD facet, so schema validation does not enforce it.**
   `<Amt Ccy="JPY">100.50</Amt>` is schema-valid and rule-invalid. Nothing in the XSD records
   "this amount has N decimals", and a trailing-zero difference (`100.00` vs `100.0`) is not
   distinguished by `xs:decimal` and carries no meaning.

   **Note for (a)**: this is independent confirmation of (a)'s conclusion. The `CurrencyAmount`
   rule presumes **exactly one minor-unit value per currency code**: it could not be stated in
   that form otherwise. And `ActiveOrHistoricCurrencyAndAmount` is ISO 20022's own answer to the
   historic-currency problem: its answer is to widen the accepted _code set_, not to attach an
   exponent to the amount. If two exponents per code were a real phenomenon, this is the datatype
   that would have to model it, and it does not.

**Whether ISO 20022 says anything about rounding**: see (e).

---

## (e) Rounding: what is actually specified

### EU Council Regulation (EC) No 1103/97, Articles 4 and 5

**READ**: `https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:31997R1103`.
(EUR-Lex serves HTTP 202 with a JavaScript bot-check to `curl` and to plain fetching; the text
below was extracted by rendering the page in a real browser. The content is the official
EUR-Lex HTML of the regulation.)

**Article 5, verbatim and in full:**

> "Monetary amounts to be paid or accounted for when a rounding takes place after a conversion into the euro unit pursuant to Article 4 shall be rounded up or down to the nearest cent. Monetary amounts to be paid or accounted for which are converted into a national currency unit shall be rounded up or down to the nearest sub-unit or in the absence of a sub-unit to the nearest unit, or according to national law or practice to a multiple or fraction of the sub-unit or unit of the national currency unit. If the application of the conversion rate gives a result which is exactly half-way, the sum shall be rounded up."

**Article 4, verbatim and in full** (it is Article 4 that constrains the _intermediate_ value,
and it is the more design-relevant of the two):

> "1. The conversion rates shall be adopted as one euro expressed in terms of each of the national currencies of the participating Member States. They shall be adopted with six significant figures.
>
> 2. The conversion rates shall not be rounded or truncated when making conversions.
>
> 3. The conversion rates shall be used for conversions either way between the euro unit and the national currency units. Inverse rates derived from the conversion rates shall not be used.
>
> 4. Monetary amounts to be converted from one national currency unit into another shall first be converted into a monetary amount expressed in the euro unit, which amount may be rounded to not less than three decimals and shall then be converted into the other national currency unit. No alternative method of calculation may be used unless it produces the same results."

**READ**: recital (11), which states the scope of the rule:

> "Whereas the introduction of the euro requires the rounding of monetary amounts; whereas an early indication of rules for rounding is necessary in the course of the operation of the common market and to allow a timely preparation and a smooth transition to Economic and Monetary Union; whereas these rules do not affect any rounding practice, convention or national provisions providing a higher degree of accuracy for intermediate computations;"

**READ**: recital (10), on why inverse rates are banned:

> "whereas the use of inverse rates for conversion would imply rounding of rates and could result in significant inaccuracies, notably if large amounts are involved;"

**INFERRED**, four things this text actually specifies, as opposed to recommends:

1. **A rounding mode is mandated, and it is half-up, not half-even.** "If the application of the
   conversion rate gives a result which is exactly half-way, the sum shall be rounded up." This
   is one of the very few places in this whole research where a mode is _legally binding_. It is
   flatly incompatible with banker's rounding.
2. **The mode applies only at the point of payment or accounting**: "monetary amounts to be paid
   or accounted for". Recital (11) explicitly leaves intermediate computations alone, and even
   invites higher accuracy there.
3. **Rates are not rounded and inverse rates are forbidden** (Art. 4(2), 4(3)). Dividing by a
   rate is not the same operation as multiplying by its inverse, and the regulation cares about
   the difference.
4. **Triangulation is mandatory with a stated minimum precision**: national→euro→national, with
   the euro intermediate "rounded to not less than three decimals" (Art. 4(4)): i.e. an
   intermediate that is _more_ precise than the stored 2-decimal amount, which is the whole
   reason the rule exists. And the escape hatch is results-based, not method-based: "No
   alternative method of calculation may be used unless it produces the same results."

**Relevance caveat**: this regulation governs conversion _into and between euro-legacy national
currency units_. **INFERRED**: it is not a general-purpose FX rounding rule for arbitrary
currency pairs, and it is largely spent as live law now that the legacy units are gone. It is
cited here because it is the clearest example in existence of a rounding mode being _specified_
rather than recommended, and because Fowler's Money page (below) singles it out as the reason
naive multiplication by a rate is wrong.

### IFRS / IAS: no mode is specified anywhere

**READ**: IAS 1 ¶51 and ¶53, from the **consolidated** Commission Regulation (EC) No 1126/2008
as at 2023-01-01, `https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02008R1126-20230101`
(11 370 347 bytes; WebFetch refuses it for size, `curl` with a browser user-agent retrieves it
without a bot challenge). Verbatim:

> **51** An entity shall clearly identify each financial statement and the notes. In addition, an entity shall display the following information prominently, and repeat it when necessary for the information presented to be understandable: (a) the name of the reporting entity …; (b) whether the financial statements are of an individual entity or a group of entities; (c) the date of the end of the reporting period …; (d) the presentation currency, as defined in IAS 21; and **(e) the level of rounding used in presenting amounts in the financial statements.**

> **53** An entity often makes financial statements more understandable by presenting information in thousands or millions of units of the presentation currency. This is acceptable as long as the entity discloses the level of rounding and does not omit material information.

**READ**: independently confirmed against AASB 101 (`https://www.aasb.gov.au/admin/file/content105/c9/AASB101_07-15.pdf`),
which reproduces the IASB text verbatim; the sole difference is ¶51(d) citing "AASB 121" for
"IAS 21".

**READ: the negative, established by sweep rather than by assertion.** The full consolidated
Regulation 1126/2008 (all EU-endorsed IAS/IFRS, ~3.4 MB of extracted text) was searched. The
detector was calibrated first, `IAS 21` → 57 hits, `IFRS 15` → 128, `presentation currency` → 38,
so it demonstrably reads the corpus.

| Term                                                                                                                                      | Hits                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `rounding`                                                                                                                                | 7 → **only 2 real** (the other 5 are the substring inside "sur**rounding**") |
| `rounded`, `round up`, `round down`, `half-up`, `half up`, `half-even`, `banker`, `truncat`, `away from zero`, `nearest`, `decimal place` | **0 each**                                                                   |

The two real hits are IAS 1 ¶51(e) and ¶53, quoted above.

**READ**: IAS 21 (foreign exchange), checked separately via AASB 121
(`https://www.aasb.gov.au/admin/file/content105/c9/AASB121_08-15_COMPfeb16_01-19.pdf`):
`round|nearest|truncat|decimal|precision` → **zero hits**, against a calibration of
"exchange rate" 36, "functional currency" 60, "presentation currency" 21. **IAS 21 prescribes
which rate to use and says nothing whatever about how to round the product.**

**READ**: IFRS 18, which replaces IAS 1 from 1 January 2027, checked via AASB 18
(`https://aasb.gov.au/admin/file/content105/c9/AASB18_06-24.pdf`). The provision survives with
the same substance and still no mode, renumbered to ¶27(e) with the explanation moved to
Appendix B:

> **27** An entity shall clearly identify each primary financial statement and the notes. In addition, an entity shall disclose prominently, and repeat when necessary for the information provided to be understandable: … **(e) the level of rounding used for the amounts in the financial statements (see paragraph B11).**

> **B11** An entity often makes financial statements more understandable by providing information in thousands or millions of units of the presentation currency. This practice is acceptable as long as the entity discloses the level of rounding and does not omit material information.

A sweep of `round|nearest|truncat|decimal|precision` across all 158 pages returns only ¶27(e)
and B11, plus "a**round** the world" in ¶46 and the heading "Back**ground**".

**INFERRED**: **IFRS/IAS specifies no rounding mode at all, not half-up, not half-even, not
truncation.** What it mandates is _disclosure of the level of rounding_ (thousands, millions),
which is a presentation-scale question, not a tie-breaking question. It does not even address
what to do with a half. Anyone citing "IFRS requires banker's rounding" is citing something that
does not exist.

**Recorded trap (READ)**: fetching the **un-consolidated** `CELEX:32008R1126` returns the
_as-adopted 2008_ text, which predates the 2007 revision of IAS 1 and uses different paragraph
numbering: there ¶51 is about current/non-current classification and the rounding disclosure
sits at ¶46/48. The `02008R1126-<date>` consolidated form is the one to use.

**UNVERIFIED**: ifrs.org's own PDFs could not be used. The canonical URL returns HTTP 200 but
serves an Azure AD B2C sign-in page rather than a PDF, and the documented `?bypass=on` parameter
does not bypass it. EUR-Lex and the two AASB reproductions were substituted; the IFRS 18 evidence
rests on AASB 18 alone, since the EUR-Lex consolidation predates IFRS 18's endorsement.

### ISO 20022 on rounding: a fraction-digit rule, but no mode

**READ**: ISO 20022 _does_ have a normative rule tying fraction digits to ISO 4217, and it has a
name. From the official Message Definition Report Part 2, Payments Initiation, §6.2.1.1,
`https://www.iso20022.org/sites/default/files/2020-12/ISO20022_MDRPart2_PaymentsInitiation_2020_2021_v1_ForSEGReview.pdf`,
verbatim:

> **6.2.1.1 ActiveCurrencyAndAmount**
> Definition: A number of monetary units specified in an active currency where the unit of currency is explicit and compliant with ISO 4217.
> Type: Amount
> …
> **Format**
> minInclusive 0
> totalDigits 18
> fractionDigits 5
>
> **Constraints**
> • ActiveCurrency: The currency code must be a valid active currency code, not yet withdrawn on the day the message containing the currency is exchanged. …
> • **CurrencyAmount**
> **The number of fractional digits (or minor unit of currency) must comply with ISO 4217.**
>
> **Note: The decimal separator is a dot.**

**READ**: `ActiveOrHistoricCurrencyAndAmount` (§6.2.1.2) carries the identical `CurrencyAmount`
constraint and identical facets. The rule is repository-wide rather than message-specific: the
same sentence appears **51 times** in the Bank-to-Customer Cash Management MDR
(`https://www.iso20022.org/sites/default/files/2020-12/ISO20022_MDRPart2_BankToCustomerCashManagement_2020_2021_v1_ForSEGReview.pdf`),
enumerated as constraints C8/C9/C18 and so on per message.

**This corrects and sharpens (d)'s third answer.** The schema and the standard say different
things, and the gap between them is the finding:

- The **XSD facet permits `fractionDigits 5` for every currency**, with no reference to the code.
- The **textual rule `CurrencyAmount` narrows it to the ISO 4217 minor unit** for that currency.
- **The textual rule is not expressible as an XSD facet, so schema validation does not enforce
  it.** `<Amt Ccy="JPY">100.50</Amt>` and `<Amt Ccy="USD">21.1234</Amt>` are both **schema-valid
  and rule-invalid**. Anything relying on XSD validation to reject a JPY amount with decimals
  will not catch it.

**INFERRED**: so the answer to "is the decimal count per-amount or implied by the currency code?"
is now unambiguous, **implied by the currency code, normatively, by a named rule**, and it is
a direct confirmation of (a)'s conclusion. ISO 20022 assumes exactly one minor-unit value per
currency code. A standard that had to cope with two exponents for one code could not state this
rule in this form.

**READ**: the EPC's SEPA Credit Transfer Customer-to-PSP Implementation Guidelines 2025 v1.0
(`https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2024-11/EPC132-08%20SCT%20C2PSP%20IG%202025%20V1.0.pdf`)
tightens this to a flat constant, stated seven times across the message elements, verbatim:

> "The fractional part has a maximum of two digits."

**INFERRED**: SEPA is euro-only, so the scheme hard-codes the exponent rather than deriving it.

**READ: no rounding mode, established negatively by sweep.**

| Source                                              | `round*`       | `truncat` | `half-*` | `nearest` | `banker` |
| --------------------------------------------------- | -------------- | --------- | -------- | --------- | -------- |
| Payments Initiation MDR (920 KB text)               | **0**          | 0         | 0        | 0         | 0        |
| Bank-to-Customer Cash Mgmt MDR (956 KB)             | 1 (incidental) | 0         | 0\*      | 0         | 0        |
| EPC SCT C2PSP IG 2025                               | 0              | 0         | 0\*      | 0         | :        |
| Official External Code Sets XLSX (664 KB cell text) | 2 (incidental) | 0         | 0        | 0         | 0        |

\* every `half` hit is "on be**half** of" or the frequency codes `HLF1 FirstHalf` / `HLF2 SecondHalf`.

The single `round` hit in the camt MDR is descriptive prose about securities pricing, not a rule:

> "If there is only one trade transaction for the execution of the trade, then the deal price could equal the executed trade price (unless, for example, the price includes commissions or **rounding**, or some other factor has been applied to the deal price or the executed trade price, or both)."

The External Code Sets hits are `ExternalPurpose1Code RRBN RoundRobin` and one central-bank
reserve-balance code definition reading "The approximation will be always made **rounding up**":
a single code's semantics, not a general rule.

**INFERRED**: **ISO 20022 constrains how many fraction digits an amount may carry and says
nothing about how to produce them.** It is a wire-format standard; the rounding decision is left
entirely to the sender.

**Recorded trap (READ), worth keeping**: the first sweep of the External Code Sets workbook
reported 0 round-hits **and was wrong**. That workbook stores strings inline, and the first pass
read `sharedStrings.xml`, which is 4 bytes and empty, so the sweep searched nothing and returned
a confident zero. The corrected run reads all four worksheet XMLs and calibrates on
`Currency` 51 / `SEPA` 103 / `ExternalPurpose` 327 before reporting. This is the same failure
mode as an empty probe reading like a clean result; the figures in the table above are from the
corrected run.

**UNVERIFIED**: whether ISO 20022's securities and investment-funds messages carry a
`RoundingDirection` element with codes such as `RDUP`/`RDWN`. Three searches, including
domain-restricted ones, returned only ISO **15022** field-dictionary pages and catalogue pages,
never a primary MDR containing the element; no securities/funds MDR was downloaded to settle it.
**INFERRED**: it would not change the conclusion if it exists: such a field would let a party
_state_ a direction as message data, which is not a normative rule about how amounts are
rounded.

### A national tax authority rule that specifies a mode: UK VAT

**READ**: HM Revenue & Customs, _VAT guide (VAT Notice 700)_,
`https://www.gov.uk/guidance/vat-guide-notice-700`, sections 17.5 and 17.6, verbatim
(extracted by rendering the page; the section is far down a very long document):

> **"17.5 Calculation of VAT on invoices: rounding of amounts**
>
> Note, the concession in this paragraph to round down amounts of VAT is designed for invoice traders and applies only where the VAT charged to customers and the VAT paid to HMRC is the same. As a general rule, the concession to round down is not appropriate to retailers, who should read paragraph 17.6.
>
> You may round down the total VAT payable on all goods and services shown on a VAT invoice to a whole penny. You can ignore any fraction of a penny.
>
> **17.5.1 Calculation based on lines of goods or services**
>
> If you want to work out the VAT separately for a line of goods or services, which are included with other goods or services in the same invoice, you should calculate the separate amounts of VAT by rounding in one of the following ways:
>
> - down to the nearest 0.1 pence, for example, 86.76 pence would be rounded down to 86.7 pence
> - to the nearest 1 pence or 0.5 pence, for example, 86.76 pence would be rounded up to 87 pence
>
> Whatever you decide, you must be consistent.
>
> The final total amount of VAT payable may be rounded down to the nearest whole penny.
>
> **17.5.2 Calculation based on tax per unit or per article**
>
> If you want to work out the VAT per unit or per article (for example, for use in price lists), you must work out the amounts in one of the following ways:
>
> - 4 digits after the decimal point and then round to 3 digits, for example, if the VAT is £0.0024, it should be rounded to £0.002 (0.2 pence)
> - the nearest 1 pence or 0.5 pence, if you decide to do this, you must not round the VAT down to 'nil' on any unit or article that is liable at the standard or reduced rate, for example, if the VAT is £0.0024 it should be rounded to £0.005 (0.5 pence)
>
> **17.6 Calculation of VAT at retailers**
>
> Most retailers account for VAT using a retail scheme. If that's the way you account for VAT, this paragraph does not affect you.
>
> If you calculate VAT at line level or invoice level, you must not round the VAT figure down. But, you may round (up and down) each VAT calculation."

**INFERRED**: what this specifies, and how differently it is shaped from the EU regulation:

- It mandates **truncation toward zero** ("round down", "ignore any fraction of a penny") for the
  invoice total: the _opposite_ direction from 1103/97's half-up, because it is a concession in
  the taxpayer's disfavour rather than a symmetry rule.
- It is **conditional on the trader's category**: the same calculation must be rounded down by an
  invoice trader and must _not_ be rounded down by a retailer (17.6). The correct rounding mode
  is not a property of the currency or of the amount; it is a property of **who is doing the
  accounting**.
- It mandates **consistency** ("Whatever you decide, you must be consistent"): the choice is
  free but must be stable, which is a policy constraint a codebase can actually encode.
- It rounds to **0.1p, 0.5p and 1p increments**: sub-minor-unit and non-power-of-ten. An
  integer-cents store cannot represent an intermediate line-level VAT figure of 86.7 pence; that
  intermediate is legitimately finer than the currency's minor unit.

**INFERRED**, and the general lesson: three of the sources here (1103/97 half-up, HMRC round-down,
CLDR's cash-rounding increments) specify **mutually incompatible** modes for the same currencies.
There is no single correct rounding mode to hard-code. What is common to all three is that the
mode is a **parameter of the operation**, chosen by the legal or business context.

### The allocation problem

**READ**: Martin Fowler's own Money page. `https://martinfowler.com/isa/money.html` now 404s;
the page was read from the well-known mirror
`http://thierryroussel.free.fr/java/books/martinfowler/www.martinfowler.com/isa/money.html`
("ISA: Money", carrying "© Copyright Martin Fowler, all rights reserved"), which is the
pre-publication draft of _Patterns of Enterprise Application Architecture_ chapter 18.
**INFERRED**: a mirror, so treat as high-confidence-but-not-canonical; the canonical text is the
book.

**Foemmel's Conundrum, verbatim**: the statement of the problem:

> "The awkward complication comes with rounding, particularly when allocating money between different places. Here's Matt Foemmel's simple conundrum. Suppose I have a business rule that says that I have to allocate the whole amount of a sum of money to two accounts: 70% to one and 30% to another. I have 5 cents to allocate. If I do the math I end up with 3.5 cents and 1.5 cents. Whichever way I round these I get into trouble. If I do the usual rounding to nearest then 1.5 becomes 2 and 3.5 becomes 4. So I end up gaining a penny. Rounding down gives me 4 cents and rounding up gives me six cents. **There's no general rounding scheme I can apply to both that will avoid losing or gaining a penny.**"

**This is the decisive sentence for the design**: no _rounding mode_ solves allocation. Half-even
does not solve it, half-up does not solve it, and choosing a better mode is the wrong axis of
attack entirely. Allocation is a different operation from rounding.

**The four approaches Fowler enumerates, verbatim:**

> "Perhaps the most common is to ignore the problem, after all it's only a penny here and there. However this tends to make accountants understandably nervous."
>
> "The simplest rule to follow is that when you are allocating you always do the last allocation by subtracting from what you've allocated so far. While this avoids losing pennies you can get a cumulative amount of pennies on the last allocation."
>
> "You can allow the users of a money class to declare the rounding scheme when they call the method. This would allow a programmer to say that the 70% case rounds up and the 30% rounds down. This can get more complicated when you are allocating across ten accounts instead of two. You also have to remember to do this."
>
> "My favorite solution is to have an allocator function on the Money. The parameter to the allocator is a list of numbers, representing the ratio to be allocated. (so it would look something like aMoney.allocate([7,3])). It then returns a list of monies. **The allocator guarantees no pennies get dropped by scattering pennies across the allocated monies** in a way that looks pseudo-random from the outside. The allocator is my favorite but has faults: you have to remember to use it and if you have precise rules about where the pennies go they are difficult to enforce."

**The invariant, stated as the distinction that matters, verbatim:**

> "The fundamental issue here is between using multiplication to determine proportional charge (such as a tax charge) and using multiplication to allocate a sum of money across multiple places. Multiplication works well for the former, but an allocator works better for the latter. The important thing is to consider your intent whenever you want to use multiplication or division on a monetary value."

**READ**: Fowler's actual `allocate` implementation from the same page, verbatim:

```java
public Money[] allocate(int n) {
    Money lowResult = newMoney(amount / n);
    Money highResult = newMoney(lowResult.amount + 1);

    Money[] results = new Money[n];
    int remainder = (int) amount % n;
    for (int i = 0; i < remainder; i++) results[i] = highResult;
    for (int i = remainder; i < n; i++) results[i] = lowResult;

    return results;
}

public Money[] allocate(long[] ratios) {
    long total = 0;
    for (int i = 0; i < ratios.length; i++) total += ratios[i];

    long remainder = amount;
    Money[] results = new Money[ratios.length];
    for (int i = 0; i < results.length; i++) {
        results[i] = newMoney(amount * ratios[i] / total);
        remainder -= results[i].amount;
    }

    for (int i = 0; i < remainder; i++) {
        results[i].amount++;
    }

    return results;
}
```

with the test that resolves the conundrum:

```java
public void testAllocate2() {
    long[] allocation = {3,7};
    Money[] result = Money.dollars(0.05).allocate(allocation);
    assertEquals(Money.dollars(0.02), result[0]);
    assertEquals(Money.dollars(0.03), result[1]);
}
```

**INFERRED**, three observations about this code that matter for implementation:

1. It operates entirely on `amount`, the **integer minor-unit field** (`amount / n`,
   `amount % n`, `results[i].amount++`). There is no decimal arithmetic and no rounding mode
   anywhere in it. Integer minor units are not incidental to the algorithm; they are what makes
   it exact.
2. `remainder = amount; remainder -= results[i].amount` for each part, then distributing the
   surviving remainder one unit at a time: **this is the largest-remainder / Hamilton method**,
   with the tie-break degenerated to "first parts win" (index order) rather than by fractional
   size. **The conservation invariant is a theorem of the construction**, not an assertion bolted
   on: the remainder is defined as what is left of the total, and every unit of it is handed out,
   so the parts sum to the total by definition.
3. Consequently the allocation is **order-dependent**: `allocate([7,3])` and `allocate([3,7])`
   put the extra penny on different parties. Any test of an allocator must fix the input order,
   and any business rule about _which_ party gets the extra unit has to be imposed on top; Fowler
   says as much ("if you have precise rules about where the pennies go they are difficult to
   enforce").

**READ**: Fowler's storage recommendation, from the same page, which bears directly on (f):

> "You can store the amount as either an integral type or a fixed decimal type. The decimal type is easier for some manipulations and the integral type for others. **You should absolutely avoid any kind of floating point type**, as that will introduce the kind of rounding problems that Money is intended to avoid."

**READ**: his default rounding mode for _multiplication_ (a different operation from allocation),
from the same page's Java example:

```java
public Money multiply(BigDecimal amount) {
    return multiply(amount, BigDecimal.ROUND_HALF_EVEN);
}
```

**INFERRED**: Fowler defaults multiplication to half-even but makes the mode an overridable
parameter: consistent with the VAT/1103-97 finding that the mode is context-determined.

**Named-method authority: largest remainder / Hamilton.** **READ** (secondary, and flagged as
such): the method's provenance as an apportionment rule is well documented: first proposed by
Alexander Hamilton in 1792 and used to apportion the U.S. House of Representatives between 1852
and 1900, allocating each party its floor quota and then distributing the leftover seats in
descending order of fractional remainder (electowiki, "Largest remainder method"; LibreTexts
"Apportionment: Hamilton's Method"). **UNVERIFIED**: no standards body or accounting authority
was found that _prescribes_ largest-remainder for money allocation. It is an engineering
convention with a mathematical pedigree, not a specified rule. **INFERRED**: the honest
statement for a design note is that the _invariant_ (parts sum exactly to the total) is what is
non-negotiable, and largest-remainder is the cheapest construction that makes it a theorem
rather than a check.

**Banker's rounding is specified, but by IEEE 754, and for a different purpose.** See (f); the
short version is that `roundTiesToEven` is IEEE 754's default rounding _direction_ for arithmetic
results, which is a statement about numeric operations, not a recommendation about money. Note
that it is directly contradicted for euro conversion by Article 5 of 1103/97 quoted above, which
requires half-**up**.

**READ**: the IBM/Cowlishaw decimal arithmetic specification (`https://speleotrove.com/decimal/damodel.html`)
states the distinction between the two modes and who uses which, verbatim:

> "round-half-up is the usual round-to-nearest algorithm used in European countries, in international financial dealings, and in the USA for tax calculations. round-half-even is often used for other applications in the USA, where it is usually called 'round to nearest' and is sometimes called 'banker's rounding'."

and sets its defaults accordingly: basic context "rounding – is set to round-half-up", extended
contexts "rounding – is set to round-half-even (IEEE 754 §4.3.3)".

**INFERRED**: even the primary source for decimal arithmetic does not claim banker's rounding is
_the_ money mode: it identifies half-up as the financial/tax norm and half-even as a different
convention. Choosing half-even because "it is the IEEE default" would be choosing it for a reason
that source does not support.

---

## (f) IEEE 754 decimal floating point: relevant, or a distraction?

### The standard's own scope and purpose

**READ**: IEEE Std 754-2019, clauses 1.1–1.4, verbatim. The text was extracted from a PDF of the
standard hosted at
`https://www-users.cse.umn.edu/~vinals/tspot_files/phys4041/2020/IEEE%20Standard%20754-2019.pdf`
(84 pages; the copy carries "Authorized licensed use limited to: University of Minnesota.
Downloaded on September 15,2020 … from IEEE Xplore"). **INFERRED**: this is a licensed copy of
the real standard rather than a paraphrase, so the wording is trustworthy; the canonical
paywalled source is IEEE Xplore document 8766229.

> **"1.1 Scope**
> This standard specifies formats and operations for floating-point arithmetic in computer systems. Exception conditions are defined and handling of these conditions is specified.
>
> **1.2 Purpose**
> This standard provides a method for computation with floating-point numbers that will yield the same result whether the processing is done in hardware, software, or a combination of the two. The results of the computation will be identical, independent of implementation, given the same input data. Errors, and error conditions, in the mathematical processing will be reported in a consistent manner regardless of implementation.
>
> **1.3 Inclusions**
> This standard specifies:
> ― Formats for binary and decimal floating-point data, for computation and data interchange.
> ― Addition, subtraction, multiplication, division, fused multiply add, square root, compare, and other operations.
> ― Conversions between integer and floating-point formats.
> ― Conversions between different floating-point formats.
> ― Conversions between floating-point formats and external representations as character sequences.
> ― Floating-point exceptions and their handling, including data that are not numbers (NaNs).
>
> **1.4 Exclusions**
> This standard does not specify:
> ― **Formats of integers.**
> ― Interpretation of the sign and significand fields of NaNs."

**READ**: clause 1.5: "This standard specifies floating-point arithmetic in two radices, 2 and 10. A programming environment may conform to this standard in one radix or in both."

**READ**: clause 4.3.3, on the default rounding direction, verbatim:

> "An implementation of this standard shall provide roundTiesToEven and the three directed rounding attributes. A decimal format implementation of this standard shall provide roundTiesToAway as a user-selectable rounding-direction attribute. The rounding attribute roundTiesToAway is not required for a binary format implementation.
>
> The roundTiesToEven rounding-direction attribute shall be the default rounding-direction attribute for results in binary formats. **The default rounding-direction attribute for results in decimal formats is language-defined, but should be roundTiesToEven.**"

**INFERRED, and this is the decisive observation for the assessment**: IEEE 754's own scope and
purpose statements **never mention money, commerce, finance, accounting or currency.** The
motivation clauses are about _reproducibility of floating-point computation across
implementations_. The financial motivation for decimal formats is real but it is **external to
the standard's own text**: it comes from the people who campaigned for decimal's inclusion.
Clause 1.4 is even more direct: "This standard does not specify: Formats of integers." A design
that stores integer minor units is, by the standard's own words, **outside its scope.**

Note also that even _within_ decimal formats, 754 does not fix the rounding default: it is
"language-defined". So decimal64/decimal128 do not hand you a rounding policy; you still have to
choose one, and per (e) the correct choice is context-dependent anyway.

### The external motivation, from the primary source for it

**READ**: the IBM decimal arithmetic pages by Mike Cowlishaw, `https://speleotrove.com/decimal/`
and `https://speleotrove.com/decimal/decifaq.html`, which are the primary source for the decimal
formats' rationale. Verbatim:

> "Most computers today support binary floating-point in hardware. While suitable for some purposes, such as mathematical analysis, this form of arithmetic is unsuitable for financial, commercial, and human-centric (such as Web) applications."

> "binary floating-point arithmetic should not be used for financial, commercial, and user-centric applications or web services because the decimal data used in these applications cannot be represented exactly using binary floating-point."

> "The problems of binary floating-point can be avoided by using base 10 (decimal) exponents and preserving those exponents where possible."

**READ**: the worked example, from `https://speleotrove.com/decimal/decifaq1.html`, verbatim:

> "Using double binary floating-point, the result of 0.70 x 1.05 is 0.73499999999999998667732370449812151491641998291015625; the result should have been 0.735 (which would be rounded up to $0.74) but instead the rounded result would be $0.73."

> "Taken over a million transactions of this kind, as in the 'telco' benchmark, these systematic errors add up to an overcharge of more than $20."

**READ**, and, critically for the assessment, what the same source says about the _scaled-integer_
alternative, verbatim:

> "those early instructions work with decimal integers only, which then require manually applied scaling. This is error-prone, difficult to use, and hard to maintain, and requires unnecessarily large precisions when both large and small values are used in a calculation."

### Assessment: relevant, or a distraction?

**INFERRED**, from the four READ blocks above. **For an application that stores integer minor
units, IEEE 754 decimal is a distraction, but the FAQ names the one real cost, and it should be
acknowledged rather than waved away.**

The argument that it is a distraction:

1. **The problem decimal floating point solves does not arise.** Every quotation above indicts
   _binary_ floating point for being unable to represent decimal fractions exactly. An integer
   count of minor units has no fractional part at all, so there is nothing to represent
   inexactly. `0.70 x 1.05` is not an operation that occurs; `70 * 105` is, and it is exact in
   any integer type.
2. **The standard says so itself.** Clause 1.4: "This standard does not specify: Formats of
   integers."
3. **It does not solve the operations that are actually hard.** Per (e), allocation is not a
   rounding problem: "There's no general rounding scheme I can apply to both that will avoid
   losing or gaining a penny." decimal128 does not fix Foemmel's Conundrum; Hamilton's method
   over integers does, and Fowler's implementation of it uses `/`, `%` and `++` on integers.
4. **It hands you no rounding policy.** 754's decimal default is "language-defined", and the
   modes that are legally binding (1103/97 half-up, HMRC round-down) are not 754's default.

The honest counter-argument, from the same primary source:

5. **Cowlishaw explicitly criticises the scaled-integer approach**: manual scaling is
   "error-prone, difficult to use, and hard to maintain, and requires unnecessarily large
   precisions when both large and small values are used in a calculation." **INFERRED**: that
   critique lands squarely on ad-hoc integer scaling scattered through application code. It lands
   much more lightly on a design that confines the scaling to a single Money type with one
   exponent per currency, which is exactly Fowler's prescription, and exactly why he says to
   store "an integral type or a fixed decimal type" and "absolutely avoid any kind of floating
   point type."

**The residual real issue, stated plainly**: integer minor units are exact for _storage,
addition, subtraction and allocation_. They are not by themselves sufficient for _multiplication
by a non-integer_ (a tax rate, an FX rate, an interest rate), where an intermediate of higher
precision is genuinely needed: HMRC 17.5.1's 0.1p line-level intermediate and 1103/97 Art. 4(4)'s
three-decimal euro intermediate are both legal requirements for exactly such an intermediate. The
right tool there is an exact decimal or rational type _for the intermediate_, with a
context-chosen rounding back to integer minor units at the point of payment or accounting. That
is a much narrower requirement than adopting decimal64/decimal128 as the storage type, and it
does not change the storage decision.

---

## Open gaps, stated rather than filled

- **UNVERIFIED**: no ISO 4217 licence or redistribution grant was found. See (c): this is a real
  ambiguity between "free of charge" on the data page and "protected by copyright law …
  exclusively for personal use" in the site-wide terms, not a search failure.
- **UNVERIFIED**: the ISO 20022 XSDs were read from third-party copies of the generated official
  schemas, not from iso20022.org, whose schema downloads 404'd for the message sets tried. Two
  unrelated copies agree exactly, which is the cross-check offered.
- **UNVERIFIED**: no ISO-4217-specific maintenance agency guidelines document exists at the link
  SIX provides for it; that link serves the ISO 10962 (CFI) guidelines instead.
- **UNVERIFIED**: Fowler's Money page was read from a mirror, `martinfowler.com/isa/money.html`
  having 404'd. The canonical text is _PoEAA_ chapter 18.
- **UNVERIFIED**: no standards or accounting body was found that _prescribes_ largest-remainder
  allocation for money. It is convention, and should be described as such.
- **UNVERIFIED**: ifrs.org's own standard PDFs are behind an Azure AD B2C sign-in that returns
  HTTP 200 with a login page rather than a PDF. IAS 1 was verified against EUR-Lex _and_ AASB 101;
  **IFRS 18 rests on AASB 18 alone**, because the EUR-Lex consolidation predates its endorsement.
- **UNVERIFIED**: whether ISO 20022's securities/investment-funds messages carry a
  `RoundingDirection` element (`RDUP`/`RDWN`). Searches returned only ISO 15022 material; no
  securities MDR was downloaded. It would not change the conclusion either way: see (e).

## Two recorded traps, kept because each produced a confident wrong answer

- **EUR-Lex serves HTTP 202 with an empty body and a JavaScript bot-check** to `curl` and to
  plain fetching. A naive pipeline reads that as "the regulation has no Article 5". Both
  Regulation 1103/97 and HMRC's Notice 700 §17.5 had to be read by rendering the page in a real
  browser. Separately, the _consolidated_ EUR-Lex form `02008R1126-<date>` and the _as-adopted_
  form `32008R1126` return **different paragraph numbering for the same standard**: IAS 1's
  rounding disclosure is ¶51(e) in one and ¶46/48 in the other.
- **An `.xlsx` that stores its strings inline has an empty `sharedStrings.xml`.** The first sweep
  of ISO 20022's External Code Sets read that 4-byte file, searched nothing, and returned a
  confident **zero** for every rounding term, which is exactly what a genuine absence looks
  like. It was caught only because the re-run calibrated on terms known to be present
  (`Currency` 51, `SEPA` 103, `ExternalPurpose` 327) before reporting any absence. Every
  negative finding in this document that rests on a text sweep carries such a calibration; the
  ones that do not are marked UNVERIFIED instead.
