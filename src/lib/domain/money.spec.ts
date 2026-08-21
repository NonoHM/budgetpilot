import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
	DEFAULT_CURRENCY,
	DEFAULT_EXPONENT,
	formatMoney,
	formatMoneyToParts,
	formatMoneyWithoutSymbol,
	money,
	parseMoney,
	toDecimalString,
	toInputValue,
	toMajorUnitNumber,
	currencySymbol
} from './money';

/**
 * The money module's four doors, tested THROUGH the doors and never past them.
 *
 * Every case at an exponent other than 2 is a case the code this module replaces could not
 * express: sixteen sites divided by a literal 100 and four regexes accepted a literal one-or-two
 * fraction digits. Those are the tests that say the exponent actually moved, rather than that a
 * function was renamed.
 */

describe('money, the value', () => {
	it('defaults to the currency and exponent every stored row carries today', () => {
		expect.assertions(2);

		expect(money(1234)).toEqual({ minorUnits: 1234, currency: 'EUR', exponent: 2 });
		expect([DEFAULT_CURRENCY, DEFAULT_EXPONENT]).toEqual(['EUR', 2]);
	});
});

describe('parseMoney, the inbound door', () => {
	it('reads a comma or a dot as the decimal separator', () => {
		expect.assertions(2);

		expect(parseMoney('12,34')).toEqual({ minorUnits: 1234, currency: 'EUR', exponent: 2 });
		expect(parseMoney('12.34')).toEqual({ minorUnits: 1234, currency: 'EUR', exponent: 2 });
	});

	it('pads a short fraction to the exponent rather than reading it as minor units', () => {
		expect.assertions(1);

		// "12.3" is twelve euros thirty, not twelve euros three cents.
		expect(parseMoney('12.3')?.minorUnits).toBe(1230);
	});

	it('refuses more fraction digits than the exponent allows, rather than rounding', () => {
		expect.assertions(1);

		expect(parseMoney('12.345')).toBeNull();
	});

	it('accepts three fraction digits at exponent 3, which the literal grammar could not', () => {
		expect.assertions(2);

		expect(parseMoney('12.345', { currency: 'KWD', exponent: 3 })).toEqual({
			minorUnits: 12345,
			currency: 'KWD',
			exponent: 3
		});
		expect(parseMoney('12.3456', { currency: 'KWD', exponent: 3 })).toBeNull();
	});

	it('refuses any fraction at exponent 0, where a minor unit does not exist', () => {
		expect.assertions(2);

		expect(parseMoney('1234', { currency: 'JPY', exponent: 0 })).toEqual({
			minorUnits: 1234,
			currency: 'JPY',
			exponent: 0
		});
		expect(parseMoney('12.3', { currency: 'JPY', exponent: 0 })).toBeNull();
	});

	it('returns null and never throws, so policy stays with the caller', () => {
		expect.assertions(4);

		expect(parseMoney('abc')).toBeNull();
		expect(parseMoney('')).toBeNull();
		expect(parseMoney('   ')).toBeNull();
		expect(parseMoney('12,34,56')).toBeNull();
	});
});

describe('toDecimalString, the machine door', () => {
	it('writes exactly as many fraction digits as the exponent, with a dot and no grouping', () => {
		expect.assertions(3);

		expect(toDecimalString(money(123456))).toBe('1234.56');
		expect(toDecimalString(money(12345, 'KWD', 3))).toBe('12.345');
		expect(toDecimalString(money(1234, 'JPY', 0))).toBe('1234');
	});

	it('carries the sign and pads a magnitude smaller than one major unit', () => {
		expect.assertions(2);

		expect(toDecimalString(money(-1))).toBe('-0.01');
		expect(toDecimalString(money(5, 'KWD', 3))).toBe('0.005');
	});

	it('renders negative zero as zero, which is what the CSV export already promises', () => {
		expect.assertions(1);

		expect(toDecimalString(money(-0))).toBe('0.00');
	});
});

describe('formatMoney, the human door', () => {
	it('scales by the amount own exponent, not by a literal hundred', () => {
		expect.assertions(1);

		// The separator between the thousands is a narrow no-break space in French. Matched as \s
		// rather than typed, because a literal U+202F in a source file is invisible and the repository
		// refuses irregular whitespace for exactly that reason.
		expect(formatMoney(money(123456), { locale: 'fr' }).replace(/\s/g, ' ')).toBe('1 234,56 €');
	});

	it('does not multiply an exponent-0 amount by a hundred', () => {
		expect.assertions(1);

		// The defect this module removes: the old formatter divided by 100 unconditionally, so a
		// JPY amount of 123456 minor units displayed as 1 235 yen.
		// The digits carry the claim; which glyph a locale picks for the currency is ICU's decision
		// and not this test's.
		const formatted = formatMoney(money(123456, 'JPY', 0), { locale: 'fr' });
		expect(formatted.replace(/\D/g, '')).toBe('123456');
	});

	it('shows every digit the amount was stored with, overriding the locale data', () => {
		expect.assertions(2);

		// CLDR, which is what `Intl` formats from, disagrees with ISO on fifteen current codes and is
		// lower every time. HUF is ISO 2 and CLDR 0, so the locale would round 123,45 away to 123 and
		// put a number on screen that is not the number stored. IQD is the widest: ISO 3, CLDR 0.
		expect(formatMoney(money(12345, 'HUF', 2), { locale: 'fr' }).replace(/\s/g, ' ')).toContain(
			'123,45'
		);
		expect(formatMoney(money(12345, 'IQD', 3), { locale: 'fr' }).replace(/\s/g, ' ')).toContain(
			'12,345'
		);
	});

	it('still lets a caller round to the whole unit, without asking Intl for the impossible', () => {
		expect.assertions(1);

		// An explicit override has to win, and it has to travel alone: a minimum of 2 beside a maximum
		// of 0 is a RangeError rather than a rounded number.
		expect(
			formatMoney(money(7400), { locale: 'fr', maximumFractionDigits: 0 }).replace(/\s/g, ' ')
		).toBe('74 €');
	});

	it('passes signDisplay through for the screens that show both directions signed', () => {
		expect.assertions(1);

		expect(formatMoney(money(4260_00), { locale: 'fr', signDisplay: 'exceptZero' })).toContain('+');
	});
});

describe('the human door, without its symbol', () => {
	it('drops the currency and the space that only exists for it', () => {
		expect.assertions(2);

		// The spoken form of a split remainder: 1p reads « 20,00 euros », so the glyph must go and
		// the digits must stay exactly as the locale writes them.
		expect(formatMoneyWithoutSymbol(money(2000), { locale: 'fr' })).toBe('20,00');
		expect(formatMoneyWithoutSymbol(money(2000), { locale: 'en' })).toBe('20.00');
	});

	it('keeps the exponent, so an exponent-0 amount is not divided by a hundred', () => {
		expect.assertions(1);

		expect(
			formatMoneyWithoutSymbol(money(123456, 'JPY', 0), { locale: 'fr' }).replace(/\D/g, '')
		).toBe('123456');
	});

	it('honours a fraction-digit override, for the range that rounds to the whole unit', () => {
		expect.assertions(1);

		expect(formatMoneyWithoutSymbol(money(7400), { locale: 'fr', maximumFractionDigits: 0 })).toBe(
			'74'
		);
	});

	it('reports which side the locale puts the symbol on, which is not ours to hardcode', () => {
		expect.assertions(2);

		const french = formatMoneyToParts(money(100), { locale: 'fr' });
		const english = formatMoneyToParts(money(100), { locale: 'en' });
		expect(french[french.length - 1].type).toBe('currency');
		expect(english[0].type).toBe('currency');
	});
});

describe('toInputValue, the editable door', () => {
	it('uses the locale decimal separator and no grouping, so the field can be re-parsed', () => {
		expect.assertions(2);

		expect(toInputValue(money(123456), 'fr')).toBe('1234,56');
		expect(toInputValue(money(123456), 'en')).toBe('1234.56');
	});

	it('writes the exponent number of digits, so a whole amount still shows its minor units', () => {
		expect.assertions(2);

		expect(toInputValue(money(1200), 'fr')).toBe('12,00');
		expect(toInputValue(money(12000, 'KWD', 3), 'fr')).toBe('12,000');
	});
});

describe('toMajorUnitNumber, the lossy exit', () => {
	it('converts to a major-unit number for the consumers that require one', () => {
		expect.assertions(2);

		expect(toMajorUnitNumber(money(123456))).toBe(1234.56);
		expect(toMajorUnitNumber(money(1234, 'JPY', 0))).toBe(1234);
	});
});

describe('the doors agree with each other', () => {
	const anyMoney = fc
		.record({
			minorUnits: fc.integer({ min: -999_999_999, max: 999_999_999 }),
			exponent: fc.integer({ min: 0, max: 4 })
		})
		.map(({ minorUnits, exponent }) => money(minorUnits, 'EUR', exponent));

	it('re-parses its own editable value, in either locale', () => {
		expect.assertions(1);

		// Collected rather than asserted inside the property, so the failing case is reported rather
		// than replaced by fast-check's own message (#458).
		const broken: string[] = [];
		fc.assert(
			fc.property(anyMoney, fc.constantFrom('fr', 'en'), (amount, locale) => {
				const written = toInputValue(amount, locale);
				const parsed = parseMoney(written, {
					currency: amount.currency,
					exponent: amount.exponent
				});
				// Negative zero and zero are one amount, and neither door writes a sign for it.
				if (
					parsed?.minorUnits !== (amount.minorUnits || 0) ||
					parsed.exponent !== amount.exponent
				) {
					broken.push(
						`${locale} ${JSON.stringify(amount)} -> ${written} -> ${JSON.stringify(parsed)}`
					);
				}
				return true;
			})
		);

		expect(broken).toEqual([]);
	});

	it('re-parses its own machine value', () => {
		expect.assertions(1);

		const broken: string[] = [];
		fc.assert(
			fc.property(anyMoney, (amount) => {
				const written = toDecimalString(amount);
				const parsed = parseMoney(written, {
					currency: amount.currency,
					exponent: amount.exponent
				});
				if (
					parsed?.minorUnits !== (amount.minorUnits || 0) ||
					parsed.exponent !== amount.exponent
				) {
					broken.push(`${JSON.stringify(amount)} -> ${written} -> ${JSON.stringify(parsed)}`);
				}
				return true;
			})
		);

		expect(broken).toEqual([]);
	});
});

describe('currencySymbol', () => {
	it('gives the locale\'s symbol for a currency, not the code', () => {
		expect.assertions(2);

		expect(currencySymbol('EUR', 'fr')).toBe('€');
		expect(currencySymbol('USD', 'en')).toBe('$');
	});

	// The suffix on an amount field is decoration, and decoration must not be able to throw the
	// form that carries it. `Intl` never rejects an unknown code (it renders the code itself), so
	// this pins the shape a caller can rely on rather than a value.
	it('falls back to the code itself rather than throwing on something Intl does not know', () => {
		expect.assertions(1);

		expect(currencySymbol('ZZZ', 'fr')).toBe('ZZZ');
	});
});
