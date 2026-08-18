import { describe, expect, it } from 'vitest';
import { importProfileLabel } from './importProfileLabel';

/**
 * The stored token is a KEY and the label is what a user reads. This separates the two.
 *
 * The defect: `/imports` rendered the token verbatim, so an import read through a memorised
 * correspondance displayed the word « mapped » in a badge, twelve pixels from the « Colonnes
 * reconnues » block that is what it means.
 */
describe('importProfileLabel', () => {
	// THE CASE THIS EXISTS FOR. Asserted against what it must NOT be as well as what it is: a
	// mapping that returned the token unchanged would satisfy « returns a string ».
	it('never shows the mapped token', () => {
		expect(importProfileLabel('mapped')).not.toBe('mapped');
		expect(importProfileLabel('mapped')).toBe('Colonnes désignées');
	});

	it('names the bank profiles as their banks', () => {
		expect(importProfileLabel('banque-populaire')).toBe('Banque Populaire');
		expect(importProfileLabel('revolut')).toBe('Revolut');
	});

	// The two generations of one export collapse, because the distinction is a fact about the parser
	// and not about the file the user recognises.
	it('collapses the two in-house generations into one label', () => {
		expect(importProfileLabel('maison')).toBe(importProfileLabel('maison-v2'));
	});

	// An unknown token is SHOWN rather than hidden behind a generic label. A value this function has
	// never heard of is a defect upstream, and printing « CSV » over it is how that defect survives.
	it('shows an unknown token rather than papering over it', () => {
		expect(importProfileLabel('a-profile-added-later')).toBe('a-profile-added-later');
	});
});
