/**
 * The last two things done to a line before it is written, and the only code that decides what a
 * value looks like on the wire (`v5.0.0-16.4.1`).
 *
 * WHY JSON ALONE IS NOT ENOUGH. `JSON.stringify`, and pino on top of it, escape CR, LF and the rest
 * of C0, so no value can end a line. They leave U+2028 and U+2029 raw (measured with pino 10.3.1 on
 * #250), and a viewer that honours Unicode line breaks renders those as new lines, which is a
 * forged line by another route. They also leave DEL and the C1 controls raw, and C1 holds the
 * single-byte form of the escape that repaints a terminal. Every one of these can only occur inside
 * a JSON string, never in the structure, so replacing them in the finished line with their `\uXXXX`
 * form keeps it valid JSON that decodes to the same value.
 *
 * Imported by `boot.mjs` as TypeScript source: erasable syntax only.
 */

// Written with code point escapes on purpose: a tool that writes files from JSON turns the
// four-digit form of these two separators into the raw characters (CLAUDE.md, harness traps).
// eslint-disable-next-line no-control-regex -- matching control characters is this pattern's job
const UNSAFE = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}]/gu;

export function escapeLine(line: string): string {
	return line.replace(UNSAFE, (character) => {
		const code = character.codePointAt(0) ?? 0;
		return `\\u${code.toString(16).padStart(4, '0')}`;
	});
}

/** Longest string value written, in code points. Long enough for an error class or a URL. */
export const MAX_VALUE_LENGTH = 256;
/** The operator message is the one value that is a paragraph by design. */
export const MAX_OPERATOR_MESSAGE_LENGTH = 2048;
/**
 * A line longer than this is replaced by `budgetpilot.log.line_too_long`. Docker's json-file driver
 * splits at 16 KiB and the second half then reads as a line of its own; the cap leaves room for the
 * six-byte escape every character could need.
 */
export const MAX_LINE_BYTES = 8192;

/** Cut on a code point boundary, so a cap never leaves half a surrogate pair. */
export function capString(value: string, max = MAX_VALUE_LENGTH): string {
	if (value.length <= max) return value;
	return Array.from(value).slice(0, max).join('');
}

/**
 * Attribute values as written: strings capped, numbers only when finite, absent values dropped.
 * `longKeys` names the attributes allowed the operator-message length.
 */
export function capAttributes(
	attributes: object,
	longKeys: ReadonlySet<string>
): Record<string, string | number | boolean> {
	const written: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (typeof value === 'string') {
			written[key] = capString(value, longKeys.has(key) ? MAX_OPERATOR_MESSAGE_LENGTH : undefined);
		} else if (typeof value === 'number') {
			if (Number.isFinite(value)) written[key] = value;
		} else if (typeof value === 'boolean') {
			written[key] = value;
		}
	}
	return written;
}
