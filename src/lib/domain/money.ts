/**
 * The one place in this application that knows an amount is scaled by a power of ten.
 *
 * ## Why this is a module and not a helper
 *
 * Before it, sixteen sites across thirteen files divided or multiplied by a literal `100`, four
 * regexes accepted a literal one-or-two fraction digits, and two of those refused a third digit in
 * OPPOSITE directions (one threw and aborted a whole account fetch, the other filtered the row out
 * silently). None of that is wrong today, because every stored amount is a euro at exponent 2. All
 * of it becomes wrong on the day an amount carries its own exponent, and it becomes wrong twenty
 * three times, in twenty three places, each of which has to be found first.
 *
 * The deletion test says the same thing from the other side: delete this module and the exponent
 * reappears at every call site rather than the complexity vanishing.
 *
 * ## What it owns
 *
 * The exponent, every power-of-ten scaling, the grammar of an accepted amount, the fraction digits
 * handed to `Intl`, and the decimal separator of an editable field. Nothing else.
 *
 * ## What it does not own, deliberately
 *
 * **Aggregation.** Adding two integers of one currency is exact and needs no exponent, so sums stay
 * where they are rather than moving behind an interface that would add nothing.
 *
 * **Policy.** Nothing here throws. A malformed amount comes back as `null` and the caller decides
 * whether that is a refusal, a filtered row or an abort, which is how two callers can keep two
 * different reactions to one grammar.
 *
 * **Conversion between currencies.** Refused by omission and by design: a budget counts only its
 * own currency. That single refusal is what removes the rounding-mode question from this file.
 *
 * **The locale.** It belongs to the request, so every door that needs one takes it as an argument
 * and this file imports nothing. That is not tidiness: `server/naming/report.ts` runs under Node's
 * type stripping from `scripts/normalize-names.mjs`, outside Vite, where a `$lib` specifier does
 * not resolve. A default of `getLocale()` here cost a container build to find, because no local
 * gate runs that script. A module with no imports can be used by anything that can read a file.
 *
 * See `docs/audits/2026-08-21-stored-forms-design.md`, Part B, for the stored form this interface
 * is shaped around, and for why the exponent is stored per amount rather than derived from the
 * currency code.
 */

/**
 * An amount, in the shape it is stored in: an integer of minor units, the currency that integer is
 * denominated in, and the exponent that says what the integer means.
 *
 * The exponent is a property OF THE AMOUNT AS WRITTEN, not of the currency as it stands today. It
 * records how to read this integer, which is what keeps an old row readable when a published list
 * changes or a code is withdrawn.
 */
export interface Money {
	readonly minorUnits: number;
	readonly currency: string;
	readonly exponent: number;
}

/**
 * What every amount in the database is today, and the only two constants a future migration has to
 * replace with a column read.
 *
 * They are exported so a call site that constructs a `Money` from a bare integer says which
 * assumption it is making, greppably, instead of the assumption being invisible.
 */
export const DEFAULT_CURRENCY = 'EUR';
export const DEFAULT_EXPONENT = 2;

/**
 * Builds an amount from an integer of minor units.
 *
 * The two defaults are the whole of the euro assumption in this application. When a row carries its
 * own currency and exponent, a call site becomes `money(row.amountCents, row.currency, row.exponent)`
 * and nothing else about it changes.
 */
export function money(
	minorUnits: number,
	currency: string = DEFAULT_CURRENCY,
	exponent: number = DEFAULT_EXPONENT
): Money {
	return { minorUnits, currency, exponent };
}

export interface ParseMoneyOptions {
	/** The currency the resulting amount is denominated in. Defaults to the stored default. */
	currency?: string;
	/** How many fraction digits the text may carry, and the scale of the result. Default 2. */
	exponent?: number;
	/** Whether "0" is a valid amount. Default true (the loosest historical behaviour). */
	allowZero?: boolean;
	/** Whether a leading "+" sign is accepted (e.g. "+42.90"). Default false. */
	allowPlusSign?: boolean;
	/** Lower bound (inclusive) on the resulting signed value. Undefined = no lower bound. */
	minMinorUnits?: number;
	/** Upper bound (inclusive) on the absolute value. Undefined = no upper bound. */
	maxAbsMinorUnits?: number;
	/**
	 * Enables thousands-separator normalization ("1.234,56", "1,234.56", or "1.234" meaning one
	 * thousand two hundred thirty-four) ahead of the decimal-separator normalization. Default
	 * false: the plain "replace a single comma with a dot" behaviour of the simpler callers is
	 * preserved unless a caller opts in.
	 *
	 * **The ambiguity this option carries is exponent-dependent, which is why it is opt-in.** A lone
	 * separator followed by exactly `exponent` digits reads as the decimal point, and anything else
	 * reads as grouping. At exponent 2 that makes "1.234" one thousand two hundred thirty-four. At
	 * exponent 3 the same string is one and 234 thousandths. Both readings are defensible and no
	 * rule can satisfy both, so the module states which one it takes rather than leaving four
	 * regexes to disagree about it.
	 */
	allowThousandsSeparator?: boolean;
	/**
	 * Rejects a result outside `Number.isSafeInteger`. Only the manual-entry and net-worth callers
	 * checked this historically; the import parser never did (it has no upper bound at all, by
	 * design, for bank statement amounts), so it stays opt-in rather than becoming a shared default.
	 */
	requireSafeInteger?: boolean;
}

/**
 * Normalizes both European conventions ("1.234,56" dot-thousands/comma-decimal and "1,234.56"
 * comma-thousands/dot-decimal) plus a lone grouping separator with no decimal part down to a single
 * '.' decimal separator.
 *
 * `exponent` decides where the line falls: a lone separator followed by at most that many digits is
 * the decimal point, and anything else is grouping. See `allowThousandsSeparator`.
 */
function normalizeThousands(trimmed: string, exponent: number): string {
	const hasComma = trimmed.includes(',');
	const hasDot = trimmed.includes('.');

	if (hasComma && hasDot) {
		const decimalIsComma = trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.');
		return decimalIsComma
			? trimmed.replace(/\./g, '').replace(',', '.')
			: trimmed.replace(/,/g, '');
	}
	if (hasComma || hasDot) {
		const separator = hasComma ? ',' : '.';
		const parts = trimmed.split(separator);
		const isDecimal = exponent > 0 && parts.length === 2 && parts[1].length <= exponent;
		return isDecimal ? trimmed.replace(separator, '.') : trimmed.split(separator).join('');
	}
	return trimmed;
}

/**
 * The shape of an amount, with the fraction captured but NOT counted.
 *
 * Two literals rather than one pattern built per exponent, because
 * `src/lib/server/security/injection-sinks.spec.ts` holds this repository to zero `new RegExp` in
 * production code: a pattern assembled from a string is the only place an unescaped metacharacter
 * has to be misread, and an invariant with no exceptions is worth more than the one saved line.
 *
 * Counting the fraction digits in code rather than in the pattern is also the clearer half. The
 * literal `\d{1,2}` that used to sit in four separate files said "two" four times without ever
 * saying why; `fraction.length > exponent` says the rule.
 */
const AMOUNT_PATTERN = /^[+-]?\d+(?:\.(\d+))?$/;
const NO_PLUS_AMOUNT_PATTERN = /^-?\d+(?:\.(\d+))?$/;

/**
 * The inbound door: free text plus a currency and an exponent becomes an amount, or nothing.
 *
 * Returns null on any malformed or out-of-bounds input and never throws. More fraction digits than
 * the exponent allows is a refusal rather than a rounding: rounding at the door would decide, in
 * this file, a question that belongs to whoever owns the data.
 */
export function parseMoney(value: string, options: ParseMoneyOptions = {}): Money | null {
	const {
		currency = DEFAULT_CURRENCY,
		exponent = DEFAULT_EXPONENT,
		allowZero = true,
		allowPlusSign = false,
		minMinorUnits,
		maxAbsMinorUnits,
		allowThousandsSeparator = false,
		requireSafeInteger = false
	} = options;

	const trimmed = value.trim().replace(/\s/g, '');
	if (!trimmed) return null;

	const normalized = allowThousandsSeparator
		? normalizeThousands(trimmed, exponent)
		: trimmed.replace(',', '.');

	const match = (allowPlusSign ? AMOUNT_PATTERN : NO_PLUS_AMOUNT_PATTERN).exec(normalized);
	if (!match) return null;

	// More fraction digits than the exponent is a REFUSAL, never a rounding. At exponent 0 that
	// refuses any fraction at all, which is right: a currency with no minor unit has no place to
	// put one, and silently dropping it would invent a precision the amount never had.
	const fraction = match[1] ?? '';
	if (fraction.length > exponent) return null;

	const sign = normalized.startsWith('-') ? -1 : 1;
	const major = normalized.replace(/^[+-]/, '').split('.')[0];
	const scale = 10 ** exponent;
	const minorUnits = sign * (Number(major) * scale + Number(fraction.padEnd(exponent, '0') || '0'));

	if (requireSafeInteger && !Number.isSafeInteger(minorUnits)) return null;
	if (!allowZero && minorUnits === 0) return null;
	if (minMinorUnits !== undefined && minorUnits < minMinorUnits) return null;
	if (maxAbsMinorUnits !== undefined && Math.abs(minorUnits) > maxAbsMinorUnits) return null;

	return money(minorUnits, currency, exponent);
}

export interface FormatMoneyOptions {
	/** Required, never defaulted: the locale belongs to the request, not to this module. */
	locale: string;
	/** Passed straight to `Intl.NumberFormat`. Default 'auto': a minus on negatives, nothing else. */
	signDisplay?: Intl.NumberFormatOptions['signDisplay'];
	/**
	 * Overrides the fraction digits `Intl` would take from the currency. The one caller that needs
	 * it rounds a forecast range to the whole unit, where a trailing ",00" would assert a precision
	 * the observation does not have.
	 */
	maximumFractionDigits?: number;
}

function humanFormatter(amount: Money, options: FormatMoneyOptions): Intl.NumberFormat {
	const { locale, signDisplay = 'auto', maximumFractionDigits } = options;
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: amount.currency,
		signDisplay,
		...(maximumFractionDigits === undefined ? {} : { maximumFractionDigits })
	});
}

/**
 * The outbound human door: an amount and a locale become the string a reader sees.
 *
 * **The display digits are the currency's own, and the storage exponent is the row's. They are
 * allowed to differ and that is the design**, not an oversight: CLDR and ISO disagree on fifteen
 * current codes, and an amount written at one precision can be shown at another without either
 * being wrong. What is NOT allowed is the scaling disagreeing, which is what this door fixes: the
 * formatter it replaces divided by a literal 100 whatever the currency, so an exponent-0 amount
 * displayed a hundred times too small.
 */
export function formatMoney(amount: Money, options: FormatMoneyOptions): string {
	return humanFormatter(amount, options).format(toMajorUnitNumber(amount));
}

/**
 * The same door, in parts, for the one caller that has to take the currency symbol out of one
 * bound of a range. Filtering the parts is that caller's presentation rule; knowing the scale is
 * this module's.
 */
export function formatMoneyToParts(
	amount: Money,
	options: FormatMoneyOptions
): Intl.NumberFormatPart[] {
	return humanFormatter(amount, options).formatToParts(toMajorUnitNumber(amount));
}

/**
 * The human door with the currency symbol taken out, and the digits left exactly as the locale
 * writes them.
 *
 * Two callers need this and they need it for different reasons, which is what makes it a door
 * rather than one caller's helper: a split remainder is SPOKEN ("Reste a repartir, 20,00 euros"),
 * where screen-reader pronunciation of the glyph is not reliable enough to carry the unit, and a
 * forecast range shows the symbol once for two bounds ("-74 a -96 EUR").
 *
 * Built by dropping parts rather than by formatting a plain decimal, because the fraction digits
 * belong to the currency and a plain decimal would need them restated as a literal, which is the
 * assumption this module exists to hold once. The `literal` part goes with the currency: it is the
 * separating space that only exists because the symbol does.
 */
export function formatMoneyWithoutSymbol(amount: Money, options: FormatMoneyOptions): string {
	return formatMoneyToParts(amount, options)
		.filter((part) => part.type !== 'currency' && part.type !== 'literal')
		.map((part) => part.value)
		.join('');
}

/**
 * The outbound machine door: a stable decimal string, for the CSV export and the naming report.
 *
 * A dot, exactly `exponent` fraction digits, no grouping and no symbol, whatever the locale.
 * **This is a frozen format** (see the interface audit, Part 3), which is why it is a separate door
 * from the human one: changing how a reader sees an amount must not be able to change what a
 * downstream tool parses.
 *
 * Built by string arithmetic on the integer rather than by dividing and calling `toFixed`, so the
 * result is exact at every magnitude instead of exact at the magnitudes anyone happened to test.
 */
export function toDecimalString(amount: Money): string {
	const { minorUnits, exponent } = amount;
	const negative = minorUnits < 0;
	const digits = Math.abs(minorUnits).toString();
	if (exponent <= 0) return `${negative ? '-' : ''}${digits}`;

	const padded = digits.padStart(exponent + 1, '0');
	const major = padded.slice(0, padded.length - exponent);
	const fraction = padded.slice(padded.length - exponent);
	return `${negative ? '-' : ''}${major}.${fraction}`;
}

/**
 * The editable door: the value that goes INTO a text field the user can retype.
 *
 * It differs from the machine door in exactly one way and for exactly one reason: it uses the
 * decimal separator the reader types, because the field is theirs. It carries no grouping and no
 * symbol, so that whatever it writes, `parseMoney` reads back. That round trip is the door's whole
 * contract and it is asserted as a property rather than on examples.
 *
 * The four sites this replaces hardcoded a French comma, so an English reader editing a budget was
 * handed "1234,50" to correct.
 */
export function toInputValue(amount: Money, locale: string): string {
	const decimal = toDecimalString(amount);
	if (amount.exponent <= 0) return decimal;
	return decimal.replace('.', decimalSeparator(locale));
}

function decimalSeparator(locale: string): string {
	return (
		new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')
			?.value ?? '.'
	);
}

/**
 * The lossy exit: an amount as a major-unit number.
 *
 * It exists for the two consumers that require a number rather than text (the model prompt, which
 * misread raw minor units as dollars, and `Intl`, which takes one). It is a `number`, so it is
 * subject to binary floating point and is not a storage or an interchange format. Anything written
 * to a file or read by another tool goes through `toDecimalString`.
 *
 * ## Why the display door still goes through here, which looks like a mistake and is not
 *
 * `Intl.NumberFormat.prototype.format` accepts a decimal STRING and keeps precision past the float
 * range (measured on Node 24.18, and in the spec since ES2023), so the human door could consume
 * `toDecimalString` and have no float on its path at all. Two measurements say not to.
 *
 * The float only diverges from the exact decimal above roughly 9e13 MAJOR units, swept
 * deterministically over exponents 2 to 4; this application's own caps are 1e6 for a manual entry
 * and 1e7 for a net worth balance, so no reachable amount differs. And the string path is NOT
 * behaviour-preserving: `format(-0)` renders "-0,00" while `format('0.00')` renders "0,00", and
 * `domain/netWorth.ts` carries a guard that exists precisely because of the first. Swapping them
 * would quietly retire that guard's reason while the guard stayed in the tree.
 *
 * So the exactness belongs where a wrong digit is read by a machine, which is `toDecimalString`,
 * and it is already there.
 */
export function toMajorUnitNumber(amount: Money): number {
	return amount.minorUnits / 10 ** amount.exponent;
}

/** Manual transaction/budget amount upper bound: 1M in major units, in minor units. */
export const MAX_MANUAL_AMOUNT_CENTS = 100_000_000;

/**
 * Manual transaction amount (dashboard "add transaction" form): comma or dot decimal, no thousands
 * separator, no explicit "+" sign, zero rejected (a transaction always has a direction), bounded to
 * one million major units.
 */
export function parseManualAmountCents(value: string): number | null {
	return (
		parseMoney(value, {
			allowZero: false,
			maxAbsMinorUnits: MAX_MANUAL_AMOUNT_CENTS,
			requireSafeInteger: true
		})?.minorUnits ?? null
	);
}
