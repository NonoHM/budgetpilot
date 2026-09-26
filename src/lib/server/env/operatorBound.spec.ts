import { describe, expect, it } from 'vitest';
import { readOperatorBound } from './operatorBound';

// The reading itself, one spelling per test so a red names the spelling. That every REGISTERED bound
// goes through it is asserted in `assertConfigured.spec.ts`, by enumerating `ENVIRONMENT_CHECKS`.
//
// Break-checked on 2026-09-26, one clause each, separately, each red here:
// - digit test widened to hex (refused versus read): `0x10` read as 16, `0b11` as 3, `1e2` as 100;
// - digit test widened to an exponent: `1e2` read as 100;
// - blank guard removed (unset versus a value): `''` and `'   '` refused instead of the fallback;
//   and with the digit test also accepting nothing, read as 0;
// - minimum lowered to 0 (`>= 1` versus `>= 0`): `0` and `00` read as 0;
// - untrimmed string tested (trimmed versus not): `' 12 '` and `'\t12\n'` refused;
// - `isSafeInteger` replaced by `isFinite` (exact versus approximate): 2^53 read as 9007199254740992.
const BOUND = {
	name: 'PLANTED_BOUND',
	fallback: 7,
	purpose: 'It bounds nothing, in a test.'
};

// The whole sentence, compared for equality: a refusal is read by a person, and a substring match
// passes over a malformed join between correct parts.
function outcomeOf(raw: string | undefined): string {
	try {
		return `read as ${readOperatorBound(BOUND, raw === undefined ? {} : { PLANTED_BOUND: raw })}`;
	} catch (caught) {
		return (caught as Error).message;
	}
}
const notDigits = (raw: string) =>
	`PLANTED_BOUND must be a whole number of at least 1, written in the digits 0 to 9 only (got ${JSON.stringify(raw)}). It bounds nothing, in a test. The default is 7.`;

describe('readOperatorBound', () => {
	it.each([
		['12', 'read as 12'],
		['1', 'read as 1'],
		// Leading zeros are decimal: `010` is 10, never octal 8.
		['010', 'read as 10'],
		// Surrounding whitespace is trimmed: blank already means « unset », and the two are decided on
		// one view of the string. Whitespace cannot change which number is read.
		[' 12 ', 'read as 12'],
		['\t12\n', 'read as 12'],
		// 2^53 - 1: the largest digits that still read exactly (the pair with 2^53 below).
		['9007199254740991', 'read as 9007199254740991']
	])('reads %j', (raw, expected) => {
		expect(outcomeOf(raw)).toBe(expected);
	});

	// Unset and blank are one case: `KEY=` in a .env, and a compose `${KEY}` whose source is unset,
	// both arrive as an empty string. Neither is a value, so neither is read as 0 nor refused.
	it.each([undefined, '', '   '])('returns the fallback for %j', (raw) => {
		expect(outcomeOf(raw)).toBe('read as 7');
	});

	// Each is a spelling `Number()` accepted (#745): 0x10 read as 16, 1e2 as 100, 0b11 as 3.
	it.each(['0x10', '0b11', '0o7', '1e2', '12.0', '+5', 'Infinity'])(
		'refuses %j, which Number() would have read, naming the variable and the reason',
		(raw) => {
			expect(outcomeOf(raw)).toBe(notDigits(raw));
		}
	);

	// Whitespace INSIDE the digits is not trimmed, and digits outside 0 to 9 are not digits here.
	it.each(['-1', '0', '00', '1 2', '1_000', '1,000', '１２', '٣', 'abc'])(
		'refuses %j, naming the variable and the reason',
		(raw) => {
			expect(outcomeOf(raw)).toBe(notDigits(raw));
		}
	);

	// Past 2^53 a digit string no longer reads as the number it spells, and a ceiling message would
	// then quote a value the operator did not write (`1e+21`).
	it('refuses digits too large to be read exactly, rather than reading them approximately', () => {
		expect(outcomeOf('9007199254740992')).toBe(
			'PLANTED_BOUND is too large to be read exactly as a whole number (got "9007199254740992"). It bounds nothing, in a test. The default is 7.'
		);
	});
});
