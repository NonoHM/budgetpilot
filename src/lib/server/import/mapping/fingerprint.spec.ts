import { describe, expect, it } from 'vitest';
import { candidateFingerprints, fingerprintFor } from './fingerprint';

/**
 * The header cells below are FILE CONTENT, not identifiers, which is why several are French.
 * `Libelle` and `Montant` are the literal bytes a French bank writes in its header row, and a
 * Revolut statement really does export as `Date de début` in one locale and `Started Date` in
 * another. Translating them would make these fixtures describe files nobody receives.
 */
const REVOLUT_EN = [
	'Type',
	'Product',
	'Started Date',
	'Completed Date',
	'Description',
	'Amount',
	'Fee',
	'Currency',
	'State',
	'Balance'
];
const REVOLUT_FR = [
	'Type',
	'Produit',
	'Date de début',
	'Date de fin',
	'Description',
	'Montant',
	'Frais',
	'Devise',
	'État',
	'Solde'
];

describe('fingerprintFor, name matching', () => {
	it('ignores the order the bank writes its columns in', () => {
		expect(fingerprintFor(['Date', 'Libelle', 'Montant'], 'name')).toBe(
			fingerprintFor(['Montant', 'Date', 'Libelle'], 'name')
		);
	});

	it('ignores case and surrounding spaces', () => {
		expect(fingerprintFor(['  DATE ', 'Libelle'], 'name')).toBe(
			fingerprintFor(['date', 'LIBELLE'], 'name')
		);
	});

	it('separates two genuinely different shapes', () => {
		// The presence half. Without it, a function returning a constant satisfies both tests
		// above perfectly.
		expect(fingerprintFor(['date', 'libelle'], 'name')).not.toBe(
			fingerprintFor(['date', 'libelle', 'montant'], 'name')
		);
	});

	it('gives the same account two fingerprints when its export changes language', () => {
		// Not a defect, and the reason #316 forbids the fingerprint keying a BUCKET. The same
		// Revolut account exported in English and in French is two shapes and must be, because
		// the column NAMES are what a mapping resolves. Asserted here so nobody later "fixes" the
		// fingerprint to fold them together, which would silently reunify two histories under one
		// account and is the failure that measurement in #316 exists to prevent.
		expect(fingerprintFor(REVOLUT_EN, 'name')).not.toBe(fingerprintFor(REVOLUT_FR, 'name'));
	});
});

describe('fingerprintFor, position matching', () => {
	it('does NOT ignore the order, which is the whole point of the second space', () => {
		// A positional mapping stores indices. If a reordered file carried the same fingerprint,
		// the mapping would be found and its indices would point at different columns: amounts
		// read out of the date column, on a file that looks fine.
		expect(fingerprintFor(['Date', 'Libelle', 'Montant'], 'position')).not.toBe(
			fingerprintFor(['Montant', 'Date', 'Libelle'], 'position')
		);
	});

	it('still ignores case and surrounding spaces', () => {
		expect(fingerprintFor(['  DATE ', 'Libelle'], 'position')).toBe(
			fingerprintFor(['date', 'LIBELLE'], 'position')
		);
	});

	it('never equals the name fingerprint, even for already-sorted headers', () => {
		// Domain separation. Sorted input is the one case where the two canonical strings would
		// otherwise be identical, so it is the case worth asserting.
		const sorted = ['a', 'b', 'c'];
		expect(fingerprintFor(sorted, 'position')).not.toBe(fingerprintFor(sorted, 'name'));
	});
});

describe('the canonical encoding is injective, whatever the cells contain', () => {
	// A separator CHARACTER can appear inside a header cell, and then two genuinely different
	// files encode to the same string. The fix is to need no reserved character at all rather
	// than to pick a rarer one: every candidate separator is a bet about what a file will never
	// contain, and a length prefix is not a bet.
	it('separates two files whose cells differ only in where a space falls', () => {
		const split = ['date operation', 'montant'];
		const joined = ['date', 'operation montant'];

		expect(fingerprintFor(split, 'position')).not.toBe(fingerprintFor(joined, 'position'));
		expect(fingerprintFor(split, 'name')).not.toBe(fingerprintFor(joined, 'name'));
	});

	it('separates a cell that CONTAINS the separator from the two cells it imitates', () => {
		// The measurement that decided the encoding. The first shipped version separated the cells
		// with a literal NUL byte, and a header cell may contain one, so these two files produced
		// the IDENTICAL digest:
		//
		//   ['a\u0000b']  and  ['a', 'b']
		//
		// A length prefix has no reserved character, so there is nothing for a cell to imitate.
		// Written as an escape rather than as the byte itself: a literal NUL in a source file makes
		// that file invisible to every text search, which is how this defect shipped in the first
		// place. See the comment in fingerprint.ts.
		const imitator = ['a\u0000b'];
		const genuine = ['a', 'b'];

		expect(fingerprintFor(imitator, 'position')).not.toBe(fingerprintFor(genuine, 'position'));
		expect(fingerprintFor(imitator, 'name')).not.toBe(fingerprintFor(genuine, 'name'));
	});

	it('separates cells that contain the length prefix delimiter itself', () => {
		// The encoding reads a length and then that many characters, so a colon inside a cell is
		// data rather than a delimiter. Asserted because a length prefix is only injective if the
		// length is read first, and a reader who "improves" it into a delimiter split breaks that.
		expect(fingerprintFor(['a', 'b'], 'position')).not.toBe(fingerprintFor(['a1:b'], 'position'));
		expect(fingerprintFor(['1:a'], 'position')).not.toBe(fingerprintFor(['a'], 'position'));
	});

	it('separates a file with an empty cell from one with fewer columns', () => {
		// The degenerate case a separator handles by accident and a length prefix handles by
		// construction. Three columns one of which is empty is not two columns.
		expect(fingerprintFor(['date', '', 'montant'], 'position')).not.toBe(
			fingerprintFor(['date', 'montant'], 'position')
		);
	});

	it('still collides for the cells that genuinely ARE the same shape', () => {
		// The presence half, and it is what stops the fix from being "hash something unique". A
		// name fingerprint that separated everything would never recognise a bank twice.
		expect(fingerprintFor(['Date', 'Montant'], 'name')).toBe(
			fingerprintFor(['  montant ', 'DATE'], 'name')
		);
	});
});

describe('the digest itself', () => {
	it('is a full 64 character hex digest, never truncated', () => {
		// #316 shows twelve hex characters in a measurement. That is a display. Truncating the
		// stored key to twelve would take the collision bound from about 10^-74 to about 10^-12
		// for no benefit, and a collision applies one bank's mapping to another bank's file.
		const fingerprint = fingerprintFor(['date'], 'name');
		expect(fingerprint).toHaveLength(64);
		expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('candidateFingerprints', () => {
	it('returns the name form first and the position form second, and they differ', () => {
		const headers = ['date', 'libelle', 'montant'];
		const [byName, byPosition] = candidateFingerprints(headers);

		expect(byName).toBe(fingerprintFor(headers, 'name'));
		expect(byPosition).toBe(fingerprintFor(headers, 'position'));
		expect(byName).not.toBe(byPosition);
	});
});
