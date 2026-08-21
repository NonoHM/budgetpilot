# Prior art for a money module: Actual Budget, Firefly III, dinero.js

Primary-source research note, compiled 2026-08-21, for the design of a module whose interface has
three doors: parse (text plus currency to Money), display (Money plus locale to a human string), and
export (Money to a stable machine decimal string), over amounts stored as integer minor units with a
per-row exponent.

**How to read the tags.** Every claim carries one of:

- **READ**: fetched or checked out in this session, at the named path and pinned revision, and the
  statement comes from that text.
- **INFERRED**: derived from something READ, with the derivation stated.
- **MEASURED**: produced by running a command in this session, with the command shown.
- **UNVERIFIED**: attempted and not established. Named as such rather than filled in.

**Typographic note.** This repository allows no em dash in a tracked Markdown file (`AGENTS.md`,
gated by `src/lib/prose/emDashesInProse.spec.ts`). Where a quoted source used one, it is rendered
here as a comma or a colon. No quoted wording is otherwise altered. Every fenced block below carries
a `prettier-ignore` marker so that the quoted source keeps its own formatting rather than this
repository's.

**Overlap with an existing note.** `docs/audits/research/iso4217-money.md` already covers ISO 4217
minor units, the ISO 20022 amount datatype, Fowler's `allocate()` and Foemmel's Conundrum, in more
depth than this note would. Sections 3b and 3c below give only the delta and cite that note for the
rest rather than restating it.

## What was fetched, and at which revision

**READ**, all four cloned with `git clone --depth 1` in this session:

| Source                      | Revision                                   | Commit date |
| --------------------------- | ------------------------------------------ | ----------- |
| `actualbudget/actual`       | `543622a5bb8e13d44d230c4e12243df54022979a` | 2026-08-21  |
| `firefly-iii/firefly-iii`   | `46728cb71e55fbd137ee7edfdee2c217dfadcc34` | 2026-08-20  |
| `firefly-iii/data-importer` | `398705f8150f313a3c447a31c1c2726e6b9e5d4d` | 2026-08-09  |
| `dinerojs/dinero.js`        | `76b969e519dc44675d4af898d25629995d0b16f2` | 2026-07-06  |

**READ**: `packages/dinero.js/package.json` gives `"version": "2.0.2"`, so the dinero source quoted
below is v2, not the v1 line.

Also fetched: `https://tc39.es/ecma402/` (the living ECMA-402 draft), the MDN `Intl.NumberFormat`
constructor page, `https://martinfowler.com/eaaCatalog/money.html`,
`https://martinfowler.com/eaaDev/Quantity.html`, the ISO 20022 Payments Initiation Message
Definition Report Part 2 from `iso20022.org`, and the ISO 4217 List One XML from the maintenance
agency.

---

## Question 1: Actual Budget

### 1a. The integer conversion module

**READ**: everything money-shaped lives in one file, `packages/loot-core/src/shared/util.ts`, under
a comment `// Number utilities` at line 399. The three declared types are the interface, verbatim
(lines 402 to 417):

<!-- prettier-ignore -->
```ts
/**
 * The exact amount.
 */
export type Amount = number;
/**
 * The exact amount that is formatted based on the configured number format.
 * For example, 123.45 would be '123.45' or '123,45'.
 */
export type CurrencyAmount = string;
/**
 * The amount with the decimal point removed.
 * For example, 123.45 would be 12345.
 */
export type IntegerAmount = number;
```

**INFERRED**: this is a three-node graph, not three doors. `Amount` is a float in major units and it
sits between the stored integer and both string forms, so every conversion passes through a float.

**READ**, the scaling pair, verbatim (`util.ts:541` and `:549`):

<!-- prettier-ignore -->
```ts
export function amountToInteger(
  amount: Amount,
  decimalPlaces: number = 2,
): IntegerAmount {
  const multiplier = Math.pow(10, decimalPlaces);
  return Math.round(amount * multiplier);
}

export function integerToAmount(
  integerAmount: IntegerAmount,
  decimalPlaces: number = 2,
): Amount {
  const divisor = Math.pow(10, decimalPlaces);
  return integerAmount / divisor;
}
```

**READ**, the guard on the integer range (`util.ts:420` to `:441`), the one refusal in the module:

<!-- prettier-ignore -->
```ts
// We dont use `Number.MAX_SAFE_NUMBER` and such here because those
// numbers are so large that it's not safe to convert them to floats
// (i.e. N / 100). For example, `9007199254740987 / 100 ===
// 90071992547409.88`. While the internal arithemetic would be correct
// because we always do that on numbers, the app would potentially
// display wrong numbers. Instead of `2**53` we use `2**51` which
// gives division more room to be correct
export const MAX_SAFE_NUMBER = 2 ** 51 - 1;
const MIN_SAFE_NUMBER = -MAX_SAFE_NUMBER;

export function safeNumber(value: number) {
  if (!Number.isInteger(value)) {
    throw new Error(
      'safeNumber: number is not an integer: ' + JSON.stringify(value),
    );
  }
  if (value > MAX_SAFE_NUMBER || value < MIN_SAFE_NUMBER) {
    throw new Error(
      "safeNumber: can't safely perform arithmetic with number: " + value,
    );
  }
  return value;
}
```

**INFERRED**: `2**51` is a budget for the float round trip, not for the integer. The comment says so
explicitly. A design that never converts to a float does not pay this cost, and a design that stores
a larger exponent per row pays more of it, because the headroom is consumed by the exponent.

**READ**: `safeNumber` is called from exactly one place, `integerToCurrency` (`util.ts:452`). It is
not called on the write path.

### 1b. Where the exponent lives

**READ**: in a hardcoded table keyed by currency code, in
`packages/loot-core/src/shared/currencies.ts`:

<!-- prettier-ignore -->
```ts
export type Currency = {
  code: string;
  symbol: string;
  name: string;
  decimalPlaces: number;
  numberFormat: NumberFormats;
  symbolFirst: boolean;
};
```

with 50 entries (one of which is the empty-code `None` row), and this lookup at the foot of the
file:

<!-- prettier-ignore -->
```ts
export function getCurrency(code: string): Currency {
  return currencies.find(c => c.code === code) || currencies[0];
}

export function getDecimalPlaces(currencyCode: string): number {
  return getCurrency(currencyCode)?.decimalPlaces ?? 2;
}
```

**READ**: `currencies[0]` is `{ code: '', name: 'None', symbol: '', decimalPlaces: 2, ... }`, so an
unknown code silently resolves to exponent 2. **MEASURED**, by grepping the file for lines without
`decimalPlaces: 2`: only three entries carry a non-2 exponent, IRR, JPY and KRW, all at 0. No entry
sits at 3 or 4, so no dinar and neither CLF nor UYW is representable.

**READ**, the file's own maintenance note, first lines of `currencies.ts`:

<!-- prettier-ignore -->
```ts
// When adding a new currency with a higher decimal precision, make sure to update
// the MAX_SAFE_NUMBER in util.ts.
```

**INFERRED**: this is the coupling from 1a made explicit by the authors. Raising the exponent
shrinks the safe amount range, and they knew it.

**Which scope owns the currency**: a single budget-wide synced preference. **READ**,
`packages/loot-core/src/types/prefs.ts`:

- Line 6: `'currency'` is a member of `FeatureFlag`, so the whole facility is behind a flag.
- Line 30: `'defaultCurrencyCode'` is a member of `SyncedPrefs`, documented in that file as
  "Cross-device preferences. These sync across devices when they are changed."

**READ**: `packages/loot-core/src/server/aql/schema/index.ts` defines the transaction row as

<!-- prettier-ignore -->
```ts
  transactions: {
    id: f('id'),
    ...
    amount: f('integer', { default: 0, required: true }),
    ...
  },
```

with no currency and no exponent column. **MEASURED**:
`grep -rln currency packages/loot-core/migrations` returns nothing, so no migration in the tree has
ever added a currency column to any table.

**INFERRED**, and this is the finding for the design: **Actual has no per-row exponent and no
per-account currency.** The exponent is a property of one budget-wide setting, and the default at
every call site is the literal 2.

### 1c. One module, or scattered

Both, and the split is the informative part.

**MEASURED**, over `packages/**/*.{ts,tsx}` excluding `node_modules`, with test files counted
separately:

| Symbol                         | total refs | in `*.test.*` |
| ------------------------------ | ---------- | ------------- |
| `amountToInteger`              | 147        | 11            |
| `currencyToAmount`             | 73         | 56            |
| `integerToAmount`              | 55         | 0             |
| `looselyParseAmount`           | 48         | 43            |
| `integerToCurrency`            | 38         | 3             |
| `amountToCurrency`             | 23         | 4             |
| `integerToCurrencyWithDecimal` | 15         | 11            |
| `getDecimalPlaces`             | 14         | 10            |
| `amountToCurrencyInteger`      | 9          | 8             |
| `currencyToInteger`            | 4          | 0             |
| `toRelaxedNumber`              | 3          | 0             |

**MEASURED**: raw `* 100` or `/ 100` outside tests matches **56 lines**. I read all 56. The great
majority are percentages (report charts, tax rates, growth rates) and are not money scaling. The
ones that are money scaling, and therefore the real answer to "is scaling centralised":

- `packages/sync-server/src/app-gocardless/utils.ts:46`, a **second, independent definition of the
  same function**, hardcoded to 2 and with no exponent parameter:

  <!-- prettier-ignore -->
  ```ts
  export const amountToInteger = (n: string | number): number =>
    Math.round(Number(n) * 100);
  ```

- `packages/sync-server/src/app-enablebanking/services/enablebanking-service.ts:290`:
  `const amount = Math.round(parseFloat(bal.balance_amount.amount) * 100);`
- `packages/sync-server/src/app-akahu/app-akahu.ts:320` and `:364`, the same shape.
- `packages/cli/src/output.ts:23`, a **third** formatter, hardcoded to 2:

  <!-- prettier-ignore -->
  ```ts
  function formatCellValue(key: string, value: unknown): string {
    if (isAmountValue(key, value)) {
      return (value / 100).toFixed(2);
    }
    return String(value ?? '');
  }
  ```

- `packages/desktop-client/src/components/formula/formulaCatalog.ts:1339`, where the exponent leaks
  into the user-facing formula language as documentation. The string reads, in part, "Transaction
  amount in cents. Use for calculations and comparisons." followed by the example
  `=amount / 100 to get dollar value`.

**MEASURED**, the currency-aware entry points, production call sites only:

- `amountToCurrencyInteger`, the currency-aware write door: **zero production call sites.** It is
  defined at `util.ts:485`, exercised by 8 test lines, and called by nothing else in the tree.
- `integerToCurrencyWithDecimal`: 2 production call sites, both in
  `packages/desktop-client/src/components/transactions/table/utils.ts:64-65`, and **both omit the
  currency code**, which selects the `integerAmount % 100 !== 0` fallback branch.
- `getDecimalPlaces`: 4 references, all inside `util.ts` and `currencies.ts` themselves.

**INFERRED**: **the currency-aware exponent path in Actual is almost entirely unexercised.** Writes
scale by 10^2 whatever `defaultCurrencyCode` says. The newer, correct seam exists but has not
displaced the old one.

**READ**, that newer seam, `packages/desktop-client/src/hooks/useFormat.ts`, which is the closest
thing in either codebase to the three-door interface being designed:

<!-- prettier-ignore -->
```ts
export type UseFormatResult = {
  (value: unknown, type?: FormatType): string;
  forEdit: (value: IntegerAmount) => string;
  fromEdit: (
    value: string,
    defaultValue?: number | null,
  ) => IntegerAmount | null;
  currency: Currency;
};
```

**INFERRED**: three doors, but they are display, edit-round-trip and parse. **There is no machine
door.** `forEdit` is locale-formatted (it calls `getNumberFormat(...).formatter.format`), so it is
not a stable export form.

**READ**, the hook's own comment on the module boundary it has not finished moving
(`useFormat.ts:132`):

<!-- prettier-ignore -->
```ts
  // Hack: keep the global number format in sync - update the settings when
  // the underlying configuration changes.
  // This should be patched by moving all number-formatting utilities away from
  // the global `getNumberFormat()` and to using the reactive `useFormat` hook.
```

**INFERRED**: the global mutable `numberFormatConfig` set by `setNumberFormat` is why the older
functions cannot take a locale argument. A module whose formatting depends on process-global state
cannot be called from two locales in one process, and the authors have written down that they
regret it. That is a direct argument for passing the locale through the display door.

### 1d. The parse grammar, and the format

Actual has **two** parsers with **deliberately different** grammars, and the split is by provenance
of the text.

**READ**, `currencyToAmount` (`util.ts:500`), for text the user typed, which reads the user's
configured number format:

<!-- prettier-ignore -->
```ts
export function currencyToAmount(currencyAmount: string): Amount | null {
  currencyAmount = currencyAmount.replace(/−/g, '-');

  let integer, fraction;

  // match the last dot or comma in the string
  const match = currencyAmount.match(/[,.](?=[^.,]*$)/);

  if (
    !match ||
    (match[0] === getNumberFormat().thousandsSeparator &&
      match.index + 4 <= currencyAmount.length)
  ) {
    fraction = null;
    integer = currencyAmount.replace(/[^\d-]/g, '');
  } else {
    integer = currencyAmount.slice(0, match.index).replace(/[^\d-]/g, '');
    fraction = currencyAmount.slice(match.index + 1);
  }

  const amount = parseFloat(integer + '.' + fraction);
  return isNaN(amount) ? null : amount;
}
```

**READ**, `looselyParseAmount` (`util.ts:555`), for text that came out of a file, with the reason
given in the comment above it:

<!-- prettier-ignore -->
```ts
// This is used when the input format could be anything (from
// financial files and we don't want to parse based on the user's
// number format, because the user could be importing from many
// currencies. We extract out the numbers and just ignore separators.
```

and its discriminating line:

<!-- prettier-ignore -->
```ts
  // Look for a decimal marker, then look for either 1-2 or 4-9 decimal places.
  // This avoids matching against 3 places which may not actually be decimal
  const m = amount.match(/[.,]([^.,]{4,9}|[^.,]{1,2})$/);
```

**READ**, the accepted and refused shapes, from `packages/loot-core/src/shared/util.test.ts`, which
is where the grammar is actually pinned:

<!-- prettier-ignore -->
```ts
    // Parsing is currently limited to 1,2 decimal places or 5-9.
    // Ignoring 3 places removes the possibility of improper parse
    //  of amounts without decimal amounts included.
    expect(looselyParseAmount('3.45')).toBe(3.45);
    // cant tell if this next case should be decimal or different format
    // so we set as full numbers
    expect(looselyParseAmount('3.456')).toBe(3456); // the expected failing case
    expect(looselyParseAmount('3.4500')).toBe(3.45);
```

and

<!-- prettier-ignore -->
```ts
    expect(looselyParseAmount('(3.45)')).toBe(-3.45);
    expect(looselyParseAmount('(−3.45)')).toBe(-3.45);
    expect(looselyParseAmount('3_45_23.10')).toBe(34523.1);
    expect(looselyParseAmount('(1 500.99)')).toBe(-1500.99);
    expect(looselyParseAmount('$1,055.00 ')).toBe(1055);
```

**INFERRED**, and this is the sharpest single lesson in the Actual reading: **a three-digit group
after a separator is structurally ambiguous, and Actual resolves it by refusing to treat it as a
fraction.** `3.456` becomes 3456, not 3.456. A currency with exponent 3 (BHD, KWD and five other
dinars) is therefore unparseable by the file-import path, and the comment says the choice was made
to avoid mis-parsing thousands separators. **A per-row exponent does not rescue this**: the
ambiguity is in the text, before any exponent is known, so the exponent has to be an INPUT to the
parse rather than an output of it.

**READ**: `currencyToAmount` never throws. It returns `null` on `NaN`. `looselyParseAmount` returns
`null` on `NaN` and on exceeding `MAX_SAFE_NUMBER`. Neither has an error type.

**READ**: the keypad grammar, for mobile amount entry, is separate again and hardcodes 2
(`util.ts:244`):

<!-- prettier-ignore -->
```ts
export function appendDecimals(
  amountText: string,
  hideDecimals = false,
): string {
  const { decimalSeparator: separator } = getNumberFormat();
  let result = amountText;
  if (result.slice(-1) === separator) {
    result = result.slice(0, -1);
  }
  if (!hideDecimals) {
    result = result.replaceAll(/[,.]/g, '');
    result = result.replace(/^0+(?!$)/, '');
    result = result.padStart(3, '0');
    result = result.slice(0, -2) + separator + result.slice(-2);
  }
  return amountToCurrency(currencyToAmount(result));
}
```

**INFERRED**: `padStart(3, '0')` and `slice(0, -2)` are the exponent written as two magic numbers. A
per-row-exponent design has to parameterise this, and it is the single place where the "type digits,
get cents" affordance meets the exponent.

**READ**, formatting: all display goes through `getNumberFormat` (`util.ts:320`), which picks a
locale purely from a five-value enum of separator styles, not from the user's actual locale:

<!-- prettier-ignore -->
```ts
  switch (format) {
    case 'space-comma':
      locale = 'fr-FR';
      ...
    case 'dot-comma':
      locale = 'de-DE';
      ...
    case 'apostrophe-dot':
      locale = 'de-CH';
      thousandsSeparator = '’'; // Intl may return U+0027 (Node <24.13.1/ICU 77)
      ...
    case 'comma-dot-in':
      locale = 'en-IN';
      ...
    case 'comma-dot':
    default:
      locale = 'en-US';
```

and then constructs `new Intl.NumberFormat(locale, fractionDigitsOptions)` with **style decimal, not
style currency**. The symbol is glued on afterwards, in `useFormat.ts`'s `applyCurrencyStyling`,
using the `currencySymbolPosition` and `currencySpaceBetweenAmountAndSymbol` preferences and a pair
of directional isolate characters.

**INFERRED**: Actual deliberately does not use `Intl.NumberFormat`'s `style: 'currency'`. It uses
Intl only as a digit grouper and owns symbol placement itself. That is a real design position, and
its cost is visible: `applyCurrencyStyling` has to strip and re-attach the minus sign by hand, and
the apostrophe case needs a post-hoc `replace(/'/g, '’')` to paper over an ICU version
difference.

---

## Question 2: Firefly III

### 2a. Storage type and per-currency precision

**READ**: the amount column is a fixed-point decimal, 32 digits total and **12 fractional**, in
every table that holds money. From
`database/migrations/2016_06_16_000002_create_main_tables.php:590`:

<!-- prettier-ignore -->
```php
                Schema::create('transactions', static function (Blueprint $table): void {
                    $table->increments('id');
                    $table->timestamps();
                    $table->softDeletes();
                    $table->integer('account_id', false, true);
                    $table->integer('transaction_journal_id', false, true);
                    $table->string('description', 1024)->nullable();
                    $table->decimal('amount', 32, 12);
```

**MEASURED**: `grep -rn "decimal('amount', 32, 12)" database/migrations` matches `budget_limits`,
`transactions`, `piggy_bank_events`, `period_statistics` and others; the foreign amount added later
is the same shape, `$table->decimal('foreign_amount', 32, 12)->nullable()`
(`2017_06_02_105232_changes_for_v450.php:86`).

**READ**: in PHP the column is handled as a **string**, never a float.
`app/Models/Transaction.php:175`:

<!-- prettier-ignore -->
```php
    protected function casts(): array
    {
        return [
            ...
            'amount'                => 'string',
            'foreign_amount'        => 'string',
            'native_amount'         => 'string',
            'native_foreign_amount' => 'string',
        ];
    }
```

**INFERRED**: decimal(32,12) plus a string cast plus `bcmath` throughout is a different answer to
the same problem. Instead of scaling to an integer, keep the decimal string exact and never let a
float near it. There is no minor-unit integer anywhere in Firefly.

**READ**, the per-currency precision, added in
`database/migrations/2016_12_28_203205_changes_for_v431.php:108`:

<!-- prettier-ignore -->
```php
                    $table->smallInteger('decimal_places', false, true)->default(2);
```

on `transaction_currencies`, a table whose original definition
(`2016_06_16_000000_create_support_tables.php:115`) carries only `code`, `name` and `symbol`. So
`decimal_places` was added later, per currency.

**MEASURED**, from `database/seeders/TransactionCurrencySeeder.php`, the only seeded currencies
whose `decimal_places` is not 2 are `JPY` and `TWD`, both 0. **INFERRED**: the seeder is a starting
set and the column is user-editable, so this is not a claim about what a live instance holds.

### 2b. Where scaling and formatting live

**There is no scaling.** **INFERRED** from 2a: the stored value is already in major units, so
nothing multiplies or divides by a power of ten anywhere on the money path.

**Formatting is a funnel of one function.** **READ**, `app/Support/Amount.php:151`, `:156` and
`:169`:

<!-- prettier-ignore -->
```php
    public function formatAnything(TransactionCurrency $format, string $amount, ?bool $coloured = null): string
    {
        return $this->formatFlat($format->symbol, $format->decimal_places, $amount, $coloured);
    }

    public function formatByCurrencyId(int $currencyId, string $amount, ?bool $coloured = null): string
    {
        $format = $this->getTransactionCurrencyById($currencyId);

        return $this->formatFlat($format->symbol, $format->decimal_places, $amount, $coloured);
    }

    public function formatFlat(string $symbol, int $decimalPlaces, string $amount, ?bool $coloured = null): string
    {
        $amount  = Steam::anonymous() ? '0' : $amount;
        $locale  = Steam::getLocale();
        $rounded = Steam::bcround($amount, $decimalPlaces);
        $coloured ??= true;

        $fmt     = new NumberFormatter($locale, NumberFormatter::CURRENCY);
        $fmt->setSymbol(NumberFormatter::CURRENCY_SYMBOL, $symbol);
        $fmt->setAttribute(NumberFormatter::MIN_FRACTION_DIGITS, $decimalPlaces);
        $fmt->setAttribute(NumberFormatter::MAX_FRACTION_DIGITS, $decimalPlaces);
        $result  = (string) $fmt->format((float) $rounded); // intentional float
```

**INFERRED**, four things worth taking:

1. The signature of the human door is exactly `(symbol, decimalPlaces, amountString, locale)`. The
   currency object is destructured at the boundary and never travels further in.
2. `MIN_FRACTION_DIGITS` and `MAX_FRACTION_DIGITS` are **both** set to the same value. Firefly
   overrides ICU's own currency digits with the database's `decimal_places` rather than trusting the
   locale data. The `Intl.NumberFormat` equivalent is setting `minimumFractionDigits` equal to
   `maximumFractionDigits` equal to the row's exponent, which is section 4a below.
3. `(float) $rounded` with the comment `// intentional float` is the only float on the path, and it
   sits **after** rounding to `decimalPlaces`, so the float only ever carries a value already at the
   target precision. That is the correct place for the float if one is unavoidable.
4. The sign is decided by `bccomp($rounded, '0')` on the rounded **string**, not on the float.

**READ**, the rounding primitive, `app/Support/Steam.php:176`:

<!-- prettier-ignore -->
```php
    public function bcround(?string $number, int $precision = 0): string
    {
        if (null === $number) {
            return '0';
        }
        if ('' === trim($number)) {
            return '0';
        }
        // if the number contains "E", it's in scientific notation, so we need to convert it to a normal number first.
        if (false !== stripos($number, 'e')) {
            $number = sprintf('%.12f', $number);
        }

        if (str_contains($number, '.')) {
            if ('-' !== $number[0]) {
                return bcadd($number, '0.'.str_repeat('0', $precision).'5', $precision);
            }

            return bcsub($number, '0.'.str_repeat('0', $precision).'5', $precision);
        }

        return $number;
    }
```

**INFERRED**: this is half-away-from-zero, implemented by adding a half-unit and letting `bcadd`'s
truncation do the rest. The mode is a property of this one function, so changing it is a one-line
change. That is the payoff of the funnel.

**MEASURED**, call-site counts across `app/` and `resources/`: `formatAnything` 52, `formatFlat` 22,
`formatByCurrencyId` 1. **READ**: the Twig layer routes through `app/Support/Twig/AmountFormat.php`,
six thin wrappers all calling `Amount::formatAnything`.

**MEASURED, and this is the counter-fact to "one abstraction"**:
`grep -rn "decimal_places" app --include='*.php'` matches **395 lines**, distributed `app/Http` 108,
`app/Support` 100, `app/Repositories` 55, `app/Api` 55, `app/Transformers` 39, rest below 15.
**INFERRED**: formatting is centralised, but **the precision value itself is not.** It is read from
the currency and then carried by hand through collectors, repositories, transformers and view models
as a plain integer field named `currency_decimal_places`. The abstraction covers the last step only.

### 2c. A currency whose decimal_places is not 2

**Looked up from the currency, never stored on the transaction.** **READ**,
`app/Helpers/Collector/GroupCollector.php:145`, the join that produces it:

<!-- prettier-ignore -->
```php
            'currency.decimal_places as currency_decimal_places',
```

and line 154 the same for `foreign_currency.decimal_places as foreign_currency_decimal_places`. The
transaction row carries `transaction_currency_id` (`2016_12_22_150431_changes_for_v430.php:57`) and
the precision is joined from the currency at read time.

**INFERRED**, and this is the important consequence: because the column is `decimal(32,12)` for
every currency, and `decimal_places` is applied only at display and export, **a JPY amount of
`100.55` is storable.** Nothing rounds it on write.

**MEASURED**: `grep -rn "decimal_places" app/Rules app/Validation app/Support/Validation` returns
**nothing**. **READ**, what validation there actually is,
`app/Support/Validation/ValidatesAmountsTrait.php`:

<!-- prettier-ignore -->
```php
    // 19-09-2020: my wedding day
    protected const string BIG_AMOUNT = '10019092020';

    final protected function isValidNumber(string $value): bool
    {
        return is_numeric($value);
    }

    final protected function scientificNumber(string $value): bool
    {
        return str_contains(strtoupper($value), 'E');
    }
```

driven by `app/Rules/IsValidAmount.php`, which fails on empty, on non-numeric, on scientific
notation, and on magnitude at or beyond `BIG_AMOUNT`. **INFERRED**: the API's parse door accepts a
machine decimal string with a dot, refuses scientific notation, refuses very large magnitudes, and
**does not check precision against the currency at all.** The currency's exponent is a rendering
concern in Firefly, not an invariant of the stored value.

**READ**, the API response shape, `app/Transformers/TransactionGroupTransformer.php:300` and `:307`:

<!-- prettier-ignore -->
```php
            'currency_decimal_places'         => $currency->decimal_places,
            ...
            'amount'                          => Steam::bcround($amount, $currency->decimal_places),
```

**INFERRED**: the API ships **both** the machine decimal string and the precision, side by side, and
leaves formatting to the client. That is the same seam dinero draws (section 3a), arrived at
independently.

**Where the locale parse actually lives**: not in Firefly III at all. **READ**, in
`firefly-iii/data-importer`, `app/Services/CSV/Converter/Amount.php`, a 300-line heuristic whose
class docblock is the Zawinski regex joke and whose comments include:

<!-- prettier-ignore -->
```php
        // have to strip the € because apparently the Postbank (DE) thinks "1.000,00 €" is a normal way to format a number.
        // 2020-12-01 added "EUR" because another German bank doesn't know what a data format is.
        // This way of stripping exceptions is unsustainable.
```

and, on the three-digit ambiguity that Actual refuses outright:

<!-- prettier-ignore -->
```php
            // #11032
            // a more terrible bank from Switzerland has decided that three decimals is normal behavior.
            // this makes "14.000" either 14 or 14000. With zero indication as to which one it may be.
            // so here we use the fallback locale to pick which one it probably is.
            // still zero indication at this point so we will use the decimal from the default locale.
            // and hope for the best.
            if (null !== config('csv.fallback_locale')) {
                $temp    = new NumberFormatter(config('csv.fallback_locale'), NumberFormatter::CURRENCY);
                $decimal = $temp->getSymbol(NumberFormatter::DECIMAL_SEPARATOR_SYMBOL);
```

**INFERRED**: two independent projects hit the same three-digit ambiguity and chose opposite
defaults. Actual refuses (treats it as thousands); Firefly guesses from a configured fallback
locale. Neither can resolve it from the text. **The design conclusion is the same either way: the
decision has to be a declared input to the parse door, not an inference inside it.**

---

## Question 3: state of the art for a money type in TypeScript

### 3a. dinero.js v2

**READ**, the whole domain type, from `src/core/types/DineroOptions.ts`,
`src/core/types/DineroSnapshot.ts` and `src/currencies/types/DineroCurrency.ts`:

<!-- prettier-ignore -->
```ts
export type DineroOptions<TAmount, TCurrency extends string = string> = {
  readonly amount: TAmount;
  readonly currency: DineroCurrency<TAmount, TCurrency>;
  readonly scale?: TAmount;
};

export type DineroSnapshot<TAmount, TCurrency extends string = string> = {
  readonly amount: TAmount;
  readonly currency: DineroCurrency<TAmount, TCurrency>;
  readonly scale: TAmount;
};

export type DineroCurrency<TAmount, TCurrency extends string = string> = {
  /**
   * The unique code of the currency.
   */
  readonly code: TCurrency;
  /**
   * The base, or radix of the currency.
   */
  readonly base: TAmount | readonly TAmount[];
  /**
   * The exponent of the currency.
   */
  readonly exponent: TAmount;
};
```

**The answer to "per-amount or per-currency" is: both, explicitly and by name.** **READ**,
`src/core/helpers/createDinero.ts`, where the defaulting is one line in the destructuring:

<!-- prettier-ignore -->
```ts
  return function dinero<TCurrency extends string>({
    amount,
    currency: { code, base, exponent },
    scale = exponent,
  }: DineroOptions<TAmount, TCurrency>): Dinero<TAmount, TCurrency> {
```

so `exponent` belongs to the currency and is the default, while `scale` belongs to the amount, is
optional on input, and is **always present in the snapshot**. **READ**,
`docs/core-concepts/scale.md`:

> The scale is one of the three pieces of domain data necessary to create a Dinero object. It's
> conceptually close to the currency exponent but serves the purpose of expressing precision as
> accurately as possible.
>
> Most of the time, you don't need to specify the scale. It defaults to the currency exponent.

and the motivating case, verbatim (the source's em dash rendered here as a comma):

> While you may think of money as its value in major or minor currency units, value that one can
> actually _pay_, it often needs a more precise representation. A good example is when you factor in
> tax rates, which are often fractional values. For example, let's say you have an item that costs
> EUR 19.95 with a VAT rate of 5.5%: you end up with a final price of EUR 21.04725. This gets
> rounded when it's time to pay, but **it's crucial to preserve the precision until the end of
> calculations**, especially if you're performing many of them.

**INFERRED**: dinero's per-amount scale exists for **intermediate precision**, not for "this
currency has three decimals". The currency exponent already covers the latter. That distinction is
worth being explicit about in any design that stores an exponent per row: the two motivations are
different and they imply different invariants.

**What it refuses.** **READ**, `src/core/checks/messages.ts`, the complete list:

<!-- prettier-ignore -->
```ts
export const INVALID_AMOUNT_MESSAGE = 'Amount is invalid.';
export const INVALID_SCALE_MESSAGE = 'Scale is invalid.';
export const INVALID_RATIOS_MESSAGE = 'Ratios are invalid.';
export const UNEQUAL_SCALES_MESSAGE = 'Objects must have the same scale.';
export const UNEQUAL_CURRENCIES_MESSAGE =
  'Objects must have the same currency.';
export const NON_DECIMAL_CURRENCY_MESSAGE = 'Currency is not decimal.';
export const MISMATCHED_BASES_MESSAGE =
  'Objects must have the same currency base.';
```

**READ**, where each fires:

- `src/dinero.ts`, at construction: `assert(Number.isInteger(amount), INVALID_AMOUNT_MESSAGE)` and
  `assert(Number.isInteger(scale), INVALID_SCALE_MESSAGE)`. **A non-integer amount is a throw, not a
  rounding.**
- `src/core/api/add.ts` and the six comparison operations each assert `haveSameCurrency` and throw
  `UNEQUAL_CURRENCIES_MESSAGE`. Adding across currencies throws; there is no implicit conversion.
- `src/core/api/toDecimal.ts`: `assert(isDecimal, NON_DECIMAL_CURRENCY_MESSAGE)` where `isDecimal`
  is `!isMultiBase && isBaseTen`. **A non-decimal currency has no decimal string form, and the
  library says so rather than approximating one.**
- `src/core/api/allocate.ts`: ratios must be non-empty, all non-negative, and at least one non-zero,
  or `INVALID_RATIOS_MESSAGE`.

**Unequal scales are NOT refused.** **READ**, `src/core/api/normalizeScale.ts`, which every binary
operation calls first:

<!-- prettier-ignore -->
```ts
    const highestScale = dineroObjects.reduce((highest, current) => {
      const { scale } = current.toJSON();

      return maximumFn([highest, scale]);
    }, calculator.zero());

    return dineroObjects.map((d) => {
      const { scale } = d.toJSON();

      return !equalFn(scale, highestScale)
        ? convertScaleFn(d, highestScale)
        : d;
    });
```

**INFERRED**: the rule is "normalise **up** to the highest scale, never down", so no operation can
lose precision. `UNEQUAL_SCALES_MESSAGE` exists for the unsafe primitives only. This is the single
most transferable mechanic for a per-row-exponent design: **mixing exponents is legal, and the merge
rule is max, applied before the arithmetic.** The inverse is offered separately and named for what
it costs, `trimScale`, documented as trimming "down to the currency exponent at most".

**Allocation.** **READ**, `src/core/utils/distribute.ts`, the core:

<!-- prettier-ignore -->
```ts
    let remainder = value;

    const shares = ratios.map((ratio) => {
      const share =
        calculator.integerDivide(calculator.multiply(value, ratio), total) ||
        zero;

      remainder = calculator.subtract(remainder, share);

      return share;
    });

    const isPositive = greaterThanOrEqualFn(value, zero);
    const compare = isPositive ? greaterThanFn : lessThanFn;
    const amount = isPositive ? one : calculator.decrement(zero);

    // Create indices sorted by descending ratio for remainder distribution
    // Indices with larger ratios receive remainder first
    const sortedIndices = ratios
      .map((ratio, index) => ({ ratio, index }))
      .filter(({ ratio }) => !equalFn(ratio, zero))
      .sort((a, b) => (greaterThanFn(a.ratio, b.ratio) ? -1 : 1))
      .map(({ index }) => index);
```

**INFERRED**, the delta against Fowler's `allocate` (quoted in full in
`docs/audits/research/iso4217-money.md`): the shape is the same largest-remainder construction, with
`remainder` defined as what is left of the total, so conservation is a theorem rather than an
assertion. **Three differences worth noting.**

1. Fowler hands the surviving units out in **index order**; dinero sorts by **descending ratio**
   first, so the largest party gets the extra unit. That is a strictly better default, and it is a
   design decision rather than an implementation detail.
2. dinero handles a **negative** total: `compare` and the increment flip sign together. Fowler's
   version does not.
3. dinero carries a loop guard that Fowler's does not need, and its comment names the reason: it
   guards against an infinite loop from floating-point precision loss, because with the number
   calculator and amounts larger than `Number.MAX_SAFE_INTEGER` a subtraction may have no effect.

**READ**, `src/core/api/allocate.ts`, the scale interaction: fractional ratios are themselves
`{ amount, scale }` pairs, and `newScale = scale + highestRatioScale`, so allocating by 50.5 / 49.5
returns objects at a **higher scale than the input**. `docs/api/mutations/allocate.md` states it:

> If you need to use fractional ratios, you shouldn't use floats, but scaled amounts instead. For
> example, instead of passing `[50.5, 49.5]`, you should pass
> `[{ amount: 505, scale: 1 }, { amount: 495, scale: 1 }]`. When using scaled amounts, the function
> converts the returned objects to the safest scale.

### 3b. Fowler's Money pattern

**READ**: `https://martinfowler.com/eaaCatalog/money.html` is a one-screen catalogue stub. It names
the two problems ("the most obvious surrounding currencies ... The more subtle problem is with
rounding") and then says "for more details go to Chapter 18 of the online ebook at oreilly.com".
**The canonical interface and `allocate()` are not on that page.**

**Already covered, not restated**: `docs/audits/research/iso4217-money.md` section (e) quotes
Foemmel's Conundrum, Fowler's four candidate approaches, and both `allocate` overloads verbatim,
from the pre-publication draft mirror, and analyses them. Read that rather than this.

**New here**, **READ**, `https://martinfowler.com/eaaDev/Quantity.html` (dated 10 May 2004, and
self-described as draft), the other authoritative Fowler text, which carries two things the Money
stub does not.

On the parse and format doors being part of the type:

> One of the most useful behaviors you can give to quantities is to provide printing and parsing
> methods that allow you easily produce strings and to produce a quantity from a string. This simple
> pattern can do much to simplify a lot of input and output behavior, either to files or in GUI
> interfaces.
>
> For simple printing you can have a default, such as first printing the amount and then the unit.
> That breaks down when in some cases you want to print the unit before the number and other cases
> afterwards. Usually this kind of variation will depend on the unit, so in these cases you can put
> the printing and parsing behavior on the unit and delegate to that.

On what arithmetic should refuse for money specifically:

> The upshot of all this is that you need to be much more careful about automatic conversion inside
> arithmetic or comparison operations with money. So often you'll find they are not allowed.

**INFERRED**: Fowler's own position is that parse and format belong **on the type**, and that the
locale-varying part is delegated to the **unit** (here, the currency). dinero takes the opposite
position on formatting and says why (section 4b). The disagreement is real and is worth deciding
deliberately rather than inheriting.

### 3c. Authoritative guidance on storing the exponent per row

**Fowler asks the question and explicitly declines to answer it.** **READ**,
`https://martinfowler.com/eaaDev/Quantity.html`, section "Relational Databases", verbatim:

> A common question with Quantity is how to use it for relational databases and other systems
> without the ability to create new lightweight types. Do you store an amount and a currency code
> with every monetary value?
>
> The issue here comes when there is a constraint in place that forces all monies to be of the same
> currency in a certain context. So consider the case where you have an account with many entries.
> Each entry has a money attribute to show the amount of the entry, yet all the entries on an
> account have the same currency. Is it reasonable to store the currency once on the account and not
> duplicate the currency across the entries?
>
> I'm inclined to punt on this question, and leave it to the specifics of your database design. I
> would still urge you to use money objects in your code: it's up to you whether how you store those
> in the database.

**INFERRED**: this is about the **currency**, not the exponent, and Fowler declines even on that.
**There is no Fowler-derived support for storing an exponent per row, in either direction.** Anyone
citing PoEAA for it is citing something that is not there.

**ISO 20022 stores the currency per amount and derives the exponent from it.** Established at length
in `docs/audits/research/iso4217-money.md` sections (d) and (e). This session independently
re-verified it against the official PDF, Payments Initiation Message Definition Report Part 2,
Maintenance 2020-2021, downloaded from `iso20022.org` (path
`/sites/default/files/2020-12/ISO20022_MDRPart2_PaymentsInitiation_2020_2021_v1_ForSEGReview.pdf`).
**READ**, section 6.2.1.1, the facets and the constraint:

> **6.2.1.1 ActiveCurrencyAndAmount**
> Definition: A number of monetary units specified in an active currency where the unit of currency
> is explicit and compliant with ISO 4217.
> Type: Amount
>
> **Format**: minInclusive 0, totalDigits 18, fractionDigits 5
>
> **Constraints** ... **CurrencyAmount**: The number of fractional digits (or minor unit of
> currency) must comply with ISO 4217.
>
> Note: The decimal separator is a dot.

**INFERRED**: the wire form is `<Amt Ccy="EUR">1234.56</Amt>`. The currency is a required attribute
**of the amount**; the exponent is not carried at all and is derived from the code. **ISO 20022 is
therefore evidence AGAINST a per-row exponent**, and it is the strongest formal evidence in this
note, since it is the interchange format the banks actually use.

**MEASURED**, why the derivation is even tractable: the ISO 4217 List One XML published by the
maintenance agency (six-group.com, path
`/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml`,
`Pblshd="2026-01-01"`) contains exactly five distinct `CcyMnrUnts` values: 0 (17 distinct codes), 2
(the bulk), 3 (BHD, IQD, JOD, KWD, LYD, OMR, TND), 4 (CLF, UYW) and `N.A.` (13 codes, all metals,
bond-market units, XDR, XSU, XTS, XUA and XXX).

**The one place a per-row exponent is recommended is a library's own guidance, not a standard.**
**READ**, dinero.js `docs/guides/storing-in-a-database.md`, verbatim:

> The safest and most portable approach is to **store the amount as an integer in minor units, along
> with the currency code and exponent.** This works with any database and gives you full control
> over how data is stored and retrieved.

with the schema it recommends, verbatim:

<!-- prettier-ignore -->
```sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  price_amount BIGINT NOT NULL,
  price_currency VARCHAR(3) NOT NULL,
  price_exponent INTEGER NOT NULL DEFAULT 2
);
```

and the qualification immediately below it:

> If you're working with amounts that have a custom scale different from the currency's exponent,
> you'll need to store the scale as well and pass it when restoring.

and, from `docs/core-concepts/scale.md`:

> When storing Dinero objects in a database, you typically only need to store the currency exponent.
> If you're working with custom scales, make sure to store the scale as well so you can accurately
> restore the object later.

**INFERRED**, and this is the honest reading: dinero recommends a per-row exponent column, but the
column it draws holds **the currency's exponent** (`DEFAULT 2`), and a **separate** stored scale is
described as the thing you add only "if you're working with custom scales". Even the one source that
recommends the column distinguishes the two, and treats the per-amount scale as the exceptional
case.

**READ**, dinero's own case against `PostgreSQL money`, the closest thing to an argument for the
column:

> - **No currency information**: it only stores the amount, not which currency it represents.
> - **Locale-dependent**: formatting depends on the `lc_monetary` setting, which can cause issues
>   when moving data between systems.
> - **Fixed precision**: always uses 2 decimal places, which doesn't work for currencies like JPY (0
>   decimals) or BHD (3 decimals).

**UNVERIFIED**: I found **no accounting-software architecture guidance, no standard, and no
peer-reviewed or vendor-authoritative source that recommends storing the exponent per row** as
distinct from storing the currency per row. Searched: ISO 20022 MDR text, ISO 4217 List One,
Fowler's two published pages, dinero's docs, and the two open-source ledgers read above. Actual
stores neither currency nor exponent per row; Firefly stores currency per row and derives the
exponent; ISO 20022 stores currency per amount and derives the exponent; dinero recommends storing
all three but says the third is normally just a copy of the second. **If a per-row exponent is
chosen for BudgetPilot, the supporting argument has to be made locally rather than cited.**

**INFERRED**, the one genuine argument the sources do support: a stored exponent is what makes an
imported amount **reconstructible** when the currency's exponent later changes, or when the currency
is unknown or non-ISO. That is a fact-about-the-past argument, not a precision argument, and it is
the same shape as this repository's existing rule about facts versus verdicts.

---

## Question 4: parsing and formatting seams

### 4a. Intl.NumberFormat, currency style, and the fraction-digit options

**READ**, ECMA-402 (living draft, `https://tc39.es/ecma402/`), the currency branch of
`InitializeNumberFormat`, verbatim from the algorithm steps:

> If style is "currency" and notation is "standard", then Let currency be
> numberFormat.[[Currency]]. Let cDigits be CurrencyDigits(currency). Let mnfdDefault be cDigits.
> Let mxfdDefault be cDigits. Else, Let mnfdDefault be 0. If style is "percent", then Let
> mxfdDefault be 0. Else, Let mxfdDefault be 3.
>
> Perform ? SetNumberFormatDigitOptions(numberFormat, options, mnfdDefault, mxfdDefault, notation).

**READ**, section 16.5.1 `CurrencyDigits ( currency )`, verbatim:

> The implementation-defined abstract operation CurrencyDigits takes argument currency (a String)
> and returns a non-negative integer. It performs the following steps when called:
>
> Assert: IsWellFormedCurrencyCode(currency) is true. Return a non-negative integer indicating the
> number of fractional digits used when formatting quantities of the currency corresponding to
> currency. If there is no available information on the number of digits to be used, return 2.

**READ**, section 16.1.2 `SetNumberFormatDigitOptions`, the steps that answer the question,
verbatim:

> If needFd is true, then If hasFd is true, then Set mnfd to ? DefaultNumberOption(mnfd, 0, 100,
> undefined). Set mxfd to ? DefaultNumberOption(mxfd, 0, 100, undefined). **If mnfd is undefined,
> set mnfd to min(mnfdDefault, mxfd). Else if mxfd is undefined, set mxfd to max(mxfdDefault, mnfd).
> Else if mnfd is greater than mxfd, throw a RangeError exception.** Set
> intlObj.[[MinimumFractionDigits]] to mnfd. Set intlObj.[[MaximumFractionDigits]] to mxfd. Else,
> Set intlObj.[[MinimumFractionDigits]] to mnfdDefault. Set intlObj.[[MaximumFractionDigits]] to
> mxfdDefault.

**So the exact answer to "what happens when they disagree with the currency's own digits" is:**

1. The currency's digits supply **only the defaults**. An explicit value wins outright.
2. Supplying **only** `maximumFractionDigits` pulls the minimum **down** to it, via
   `min(mnfdDefault, mxfd)`.
3. Supplying **only** `minimumFractionDigits` pushes the maximum **up** to it, via
   `max(mxfdDefault, mnfd)`.
4. Supplying both, with min greater than max, is a `RangeError`.
5. The currency defaults apply **only when `notation` is `"standard"`**. Under compact notation the
   defaults revert to 0 and 3, ignoring the currency entirely.

**MEASURED**, on Node v24.18.0 with ICU 78.3, which agrees with the spec on every row. All rows use
locale `en-US` and `style: 'currency'`:

| options                                      | mnfd       | mxfd       | `format(1234.5678)` |
| -------------------------------------------- | ---------- | ---------- | ------------------- |
| `currency:'USD'`                             | 2          | 2          | `$1,234.57`         |
| `currency:'JPY'`                             | 0          | 0          | `¥1,235`            |
| `currency:'BHD'`                             | 3          | 3          | `BHD 1,234.568`     |
| `currency:'CLF'`                             | 4          | 4          | `CLF 1,234.5678`    |
| `currency:'XYZ'` (unassigned)                | 2          | 2          | `XYZ 1,234.57`      |
| `currency:'XXX'` (no currency involved)      | 2          | 2          | `¤1,234.57`         |
| `currency:'USD', maximumFractionDigits:0`    | **0**      | 0          | `$1,235`            |
| `currency:'USD', minimumFractionDigits:4`    | 4          | **4**      | `$1,234.5678`       |
| `currency:'JPY', minimumFractionDigits:2`    | 2          | **2**      | `¥1,234.57`         |
| `currency:'BHD', maximumFractionDigits:1`    | **1**      | 1          | `BHD 1,234.6`       |
| `currency:'USD', min:3, max:1`               | throws     | throws     | `RangeError`        |
| `currency:'USD', minimumSignificantDigits:2` | **absent** | **absent** | `$1,234.5678`       |
| `currency:'JPY', notation:'compact'`         | 0          | 0          | `¥1.2K`             |

The thrown message is `RangeError: maximumFractionDigits value is out of range.`

**What `resolvedOptions()` reports.** **READ**, ECMA-402 16.3.2: it walks Table 28 and, for each
row,

> Let value be the value of nf's internal slot whose name is the Internal Slot value of the current
> row. **If value is not undefined**, then ... Perform ! CreateDataPropertyOrThrow(options,
> propertyKey, value).

**INFERRED and MEASURED together**: `minimumFractionDigits` and `maximumFractionDigits` are **absent
from the result object entirely** whenever significant-digit options put the formatter into
significant-digits mode, because the slots were never set. The measured row above confirms it (it
reported `minimumSignificantDigits` 2 and `maximumSignificantDigits` 21 with both fraction
properties undefined). **Anything reading `resolvedOptions().maximumFractionDigits` to discover a
currency's exponent has to handle `undefined`, and must not pass significant-digit options.**

**READ**, MDN, `Intl/NumberFormat/NumberFormat` on developer.mozilla.org, verbatim:

> **minimumFractionDigits** The minimum number of fraction digits to use. Possible values are from 0
> to 100; the default for plain number and percent formatting is 0; the default for currency
> formatting is the number of minor unit digits provided by the ISO 4217 currency code list (2 if
> the list doesn't provide that information).
>
> **maximumFractionDigits** The maximum number of fraction digits to use. Possible values are from 0
> to 100; the default for plain number formatting is the larger of minimumFractionDigits and 3; the
> default for currency formatting is the larger of minimumFractionDigits and the number of minor
> unit digits provided by the ISO 4217 currency code list (2 if the list doesn't provide that
> information).

**INFERRED, and worth flagging**: MDN's `maximumFractionDigits` sentence encodes the
`max(mxfdDefault, mnfd)` step correctly, but its `minimumFractionDigits` sentence does **not**
mention the `min(mnfdDefault, mxfd)` clamp. Read literally, MDN implies that
`{currency:'USD', maximumFractionDigits:0}` should be a `RangeError` (min 2 greater than max 0). It
is not; it resolves to 0/0, as measured. This is the repository's own "documentation states intent,
code states behaviour" rule with a concrete instance: the spec and the measurement agree, and the
popular documentation is the outlier.

**A second measured fact that matters for the display door.** Since ES2023, `format` accepts a
**string**, and `ToIntlMathematicalValue` (ECMA-402 16.5.16) is defined so that

> a mathematical value can be returned instead of a Number or BigInt, so that exact decimal values
> can be represented.

**MEASURED**, `fr-FR` with `style: 'currency'`, `currency: 'EUR'`:

<!-- prettier-ignore -->
```
f.format("9007199254740993.45")  ->  9 007 199 254 740 993,45 €
f.format(9007199254740993.45)    ->  9 007 199 254 740 994,00 €
```

**INFERRED**: the display door can be fed the **machine decimal string** directly. There is no need
for a float anywhere on the path from stored integer to rendered string, which removes the whole
class of problem that forced Actual's `2**51` ceiling.

**MEASURED**, the matching hazard in the other direction: `Intl.NumberFormat` is not safe as a
machine formatter. With `en-US`, `style: 'decimal'`, `useGrouping: false` and two fraction digits,
`format(-0)` returns `"-0.00"`; and with locale `ar-EG` the same options return `١٢٣٤٫٥٠` for
1234.5, because the numbering system is not `latn`.

### 4b. Human format versus machine format

**The pattern is well attested, and every source here draws the seam in the same place: the machine
form is a plain decimal string assembled without Intl, and the human form is built on top of it.**

**dinero states it as a design position.** **READ**, `docs/faq/why-no-currency-formatting.md`:

> The `toDecimal` function returns a plain decimal string like `"10.50"`, not `"$10.50"` or
> `"10,50 €"`. **Dinero.js delegates locale-aware formatting to you** because there's no universal
> default that works for everyone.
>
> ... Even within the same locale, preferences vary: some users prefer `USD 10.50` over `$10.50`,
> some applications need `10.50 USD` for data exports. The library can't make these decisions for
> you.

and the recommended composition, verbatim:

<!-- prettier-ignore -->
```ts
toDecimal(d, ({ value, currency }) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.code,
  }).format(value);
}); // "$10.50"
```

**READ**, how `toDecimal` actually assembles the string (`src/core/api/toDecimal.ts`), worth copying
because it is short and has no locale in it:

<!-- prettier-ignore -->
```ts
  return (units: readonly TAmount[], scale: TAmount) => {
    const whole = formatter.toString(units[0]);
    const fractional = formatter.toString(absoluteFn(units[1]));

    const scaleNumber = formatter.toNumber(scale);
    const fractionalString =
      scaleNumber > 0 ? `.${fractional.padStart(scaleNumber, '0')}` : '';
    const decimal = `${whole}${fractionalString}`;

    const leadsWithZero = equalFn(units[0], zero);
    const isNegative = lessThanFn(units[1], zero);

    // A leading negative zero is a special case because the `toString`
    // formatter won't preserve its negative sign (since 0 === -0).
    return leadsWithZero && isNegative ? `-${decimal}` : decimal;
  };
```

**INFERRED**, three properties of this that are the actual specification of a machine door: exactly
`scale` fractional digits, zero-padded (so `-0.05` at scale 2 is `"-0.05"` and not `"-0.5"`); no
grouping separator; and an explicit negative-zero fix, because the sign is otherwise lost when the
whole part is 0. The last is a real bug source and it is the only comment in the function.

**Actual's CSV export is the counter-example, and it is a live defect.** **READ**,
`packages/loot-core/src/server/transactions/export/export-to-csv.ts`:

<!-- prettier-ignore -->
```ts
import { integerToAmount } from '#shared/util';
...
      Amount: amount == null ? 0 : integerToAmount(amount),
```

**READ**, the test that pins the output,
`packages/loot-core/src/server/transactions/export/export-to-csv.test.ts:56`:

<!-- prettier-ignore -->
```ts
  it('does not prefix negative numeric amounts', async () => {
    const { row } = await payeeCell('Acme', -2500);
    expect(row.Amount).toBe('-25');
  });
```

**INFERRED**, and this is the sharpest cautionary datum in the note: **`-2500` minor units exports
as `-25`, not `-25.00`.** `integerToAmount` is called with its default `decimalPlaces = 2`
regardless of the budget's currency, the result is a JS `number`, and `csv-stringify` serialises it
with `String(number)`, which drops trailing zeros. The export is therefore not a fixed-precision
decimal string; it is whatever `Number.prototype.toString` produces, and under a JPY or BHD budget
the scale would be wrong outright. **A machine door that returns a `number` is not a machine door.**

**READ**, the one thing Actual's CSV export does get right and is worth stealing, from the same
file:

<!-- prettier-ignore -->
```ts
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

const csvStringifyOptions = {
  header: true,
  cast: {
    string: (value: string) =>
      FORMULA_TRIGGERS.test(value) ? "'" + value : value,
  },
};
```

**INFERRED**: CSV injection hardening is applied to the `string` cast only, which is precisely why
the `Amount` column has to stay a number for the test above to pass. **A design that exports amounts
as strings must make sure a leading `-` does not then get quote-prefixed as a formula trigger.**
That is a concrete interaction between the two decisions, and it is easy to miss.

**Firefly draws the seam explicitly and correctly.** **READ**,
`app/Support/Export/ExportDataGenerator.php:1003`:

<!-- prettier-ignore -->
```php
            $amount          = Steam::bcround(Steam::negative($journal['amount']), $journal['currency_decimal_places']);
            $foreignAmount   = null === $journal['foreign_amount']
                ? null
                : Steam::bcround(Steam::negative($journal['foreign_amount']), $journal['foreign_currency_decimal_places']);
```

**INFERRED**: the CSV export uses `bcround` to a plain decimal string at the **row's own currency
precision**, and never touches `formatFlat`. Two doors, two functions, and the currency's precision
is threaded through the collector as `currency_decimal_places` so the export can reach it. This is
exactly the seam being designed, implemented, in production, in a system with per-currency
precision.

**And its API does the same, plus one thing neither of the others does.** From
`app/Transformers/TransactionGroupTransformer.php` (quoted in 2c): the API ships the machine string
**and the precision that produced it** as sibling fields, so a client can render without a currency
table of its own. That is a third door shape worth considering: not `Money -> string`, but
`Money -> { amount: string, exponent: number, currency: string }`, which is the snapshot form dinero
calls `toSnapshot` and the row form dinero's SQL guide recommends.

---

## What the evidence actually supports, for the three-door design

Stated as claims with their support, not as recommendations.

1. **The parse door needs the exponent as an INPUT, not as an output.** Support: Actual's
   `looselyParseAmount` comment and its `3.456 -> 3456` test; the data-importer's `#11032` comment
   and its fallback-locale guess. **READ**, both. Two independent projects, opposite defaults, same
   root cause: a three-digit group after a separator cannot be disambiguated from the text.

2. **Parse from a human and parse from a file are two functions, not one with a flag.** Support:
   Actual keeps `currencyToAmount` (reads the user's configured separators) and `looselyParseAmount`
   (deliberately ignores them) side by side, with the reason in a comment. **READ**. Firefly has the
   same split, across a repository boundary.

3. **Mixed exponents should normalise UP, before arithmetic, and the trim must be a separate named
   operation.** Support: dinero's `normalizeScale` and `trimScale`, plus
   `docs/core-concepts/scale.md`. **READ**.

4. **The display door should take a locale argument rather than read a global.** Support: Actual's
   own `useFormat.ts:132` comment calling the global `getNumberFormat()` a "Hack" that "should be
   patched". **READ**.

5. **The display door can be fed the machine string directly.** Support: ECMA-402 16.5.16 and the
   measured `format("9007199254740993.45")` round trip. **READ** plus **MEASURED**.

6. **Set `minimumFractionDigits` equal to `maximumFractionDigits` equal to the row's exponent,
   rather than letting Intl pick from the currency.** Support: Firefly does exactly this
   (`setAttribute(MIN_FRACTION_DIGITS, $decimalPlaces)` and the same for MAX). **READ**. It is also
   the only way to make a per-row exponent visible in the rendered string when it differs from ISO
   4217's value for that code, since `CurrencyDigits` is implementation-defined and ICU-driven.

7. **The machine door must return a string with exactly `exponent` fractional digits, zero-padded,
   ungrouped, with an explicit negative-zero case.** Support: dinero's `toDecimal` implementation
   and its comment; the counter-example of Actual's `-2500 -> "-25"` test; and the measured
   `ar-EG` and `-0` hazards in 4a. **READ** plus **MEASURED**.

8. **Refusals that at least two of the three systems make**: cross-currency addition (dinero throws;
   Firefly's data model makes it impossible by carrying a currency per transaction); a non-integer
   amount at construction (dinero throws; Actual's `safeNumber` throws, but only on the read path);
   scientific notation on input (Firefly's `IsValidAmount` fails it explicitly). **READ**, all four.

9. **No source read in this session supports storing an exponent per row for precision reasons.**
   ISO 20022 derives it from the currency; Fowler declines to answer the analogous question about
   currency; dinero recommends the column but describes it as holding the currency's exponent, with
   a separate scale for the exceptional case. See 3c. **The argument for a per-row exponent in
   BudgetPilot has to be made from reconstructibility (a fact about what was imported), not from
   precision.**

---

## Gaps, stated rather than filled

- **UNVERIFIED**: PoEAA chapter 18's canonical `Money` class signature, from the published book.
  Only the catalogue stub and the pre-publication draft mirror (cited in the sibling note) were
  read.
- **UNVERIFIED**: whether any live Firefly instance actually holds a currency with `decimal_places`
  other than 0 or 2. Only the seeder was read, and the column is user-editable.
- **UNVERIFIED**: Actual's official documentation site was not read. Every Actual claim comes from
  source at the pinned commit, so a documented intent that differs from the code would not have been
  noticed.
- **UNVERIFIED**: no measurement was made of what Actual's CSV export produces under a non-2
  currency. The `-2500 -> "-25"` behaviour is READ from a passing test; the JPY consequence is
  INFERRED from the default parameter and was not run.
- **UNVERIFIED**: `CurrencyDigits` is implementation-defined, so the measured table in 4a is a fact
  about Node 24.18 with ICU 78.3 and not about every runtime. The spec text above it is the part
  that is portable.
