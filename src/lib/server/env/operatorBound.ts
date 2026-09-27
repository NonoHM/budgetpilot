/**
 * THE ONE READING OF A NUMBER AN OPERATOR SETS IN THE ENVIRONMENT (#745).
 *
 * Every operator bound registered in `ENVIRONMENT_CHECKS` reads its variable here, and
 * `assertConfigured.spec.ts` enumerates that registry to hold every one of them to it, so a new
 * bound inherits this reading rather than a sixth copy of it.
 *
 * **Positive validation against a closed set of spellings.** Each bound used to read its value with
 * `Number(raw)`, which accepts far more than a decimal integer: `0x10` read as 16, `1e1` as 10,
 * `0b11` as 3, `12.0` as 12 and `+5` as 5, on every bound. The table is what the probe in
 * `assertConfigured.spec.ts` prints when a bound bypasses this function. The range checks after it
 * still held, so no value got past a ceiling; what got through was a typo that happens to be valid
 * hex or exponent notation, booting silently with a number the operator did not write, or, above a
 * ceiling, refused with a number they did not write (`1e2` on the .xlsx bound was refused as
 * `=100`). The only accepted spelling is now the digits 0 to 9, and anything else is refused at boot
 * with the variable's name, never read and never clamped.
 *
 * **Decided here, so every bound decides it the same way:**
 * - Unset and blank are one case, the fallback. `KEY=` in a .env and a compose `${KEY}` whose source
 *   is unset both arrive as an empty string, and neither is a value. `Number('')` is 0, which is why
 *   the blank case is settled before any digit is looked at.
 * - Surrounding whitespace is trimmed, because blank is already decided on the trimmed string and
 *   the two must read one view of it. Whitespace cannot change which number is read, which is the
 *   property the spellings above lacked. Whitespace INSIDE the digits (`1 2`) is refused.
 * - Leading zeros are decimal: `010` is 10, never octal.
 * - Digits past `Number.MAX_SAFE_INTEGER` are refused rather than read approximately, so no message
 *   downstream quotes a value the operator did not write.
 * - At least 1. No bound in this tree means anything at 0.
 *
 * The ceiling is NOT here: each bound's ceiling carries its own measured reason, which is the part
 * of its refusal an operator acts on, and it stays beside the measurement that chose it.
 */
const DECIMAL_DIGITS = /^[0-9]+$/;

export type OperatorBound = {
	/** The environment variable. Every refusal names it. */
	name: string;
	/** Returned when the variable is unset or blank. */
	fallback: number;
	/** One sentence saying what the bound limits, quoted in every refusal. */
	purpose: string;
};

export function readOperatorBound(
	{ name, fallback, purpose }: OperatorBound,
	source: NodeJS.ProcessEnv = process.env
): number {
	const raw = source[name];
	if (raw === undefined) return fallback;
	const written = raw.trim();
	if (written === '') return fallback;

	const value = DECIMAL_DIGITS.test(written) ? Number(written) : Number.NaN;
	if (!(value >= 1)) {
		throw new Error(
			`${name} must be a whole number of at least 1, written in the digits 0 to 9 only (got ${JSON.stringify(raw)}). ${purpose} The default is ${fallback}.`
		);
	}
	if (!Number.isSafeInteger(value)) {
		throw new Error(
			`${name} is too large to be read exactly as a whole number (got ${JSON.stringify(raw)}). ${purpose} The default is ${fallback}.`
		);
	}
	return value;
}
