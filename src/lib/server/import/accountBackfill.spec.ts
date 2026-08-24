import { describe, expect, it } from 'vitest';
import { displayNameForSource, institutionForSource } from './accountBackfill';

describe('the display names the backfill writes', () => {
	it('writes proper nouns, which are not localised', () => {
		expect(institutionForSource('banque_populaire')).toBe('Banque Populaire');
		expect(institutionForSource('revolut')).toBe('Revolut');
	});

	// The rule with one expensive instance in this repository: a localised string does not live in
	// a database column. « Import CSV » is a phrase, not a proper noun, so it is RENDERED and never
	// stored. institution stays null and the renderer substitutes a message, which is exactly the
	// move importProfileLabel already makes.
	it('leaves the generic bucket without an institution, so no phrase is frozen into a column', () => {
		expect(institutionForSource('csv')).toBeNull();
		expect(displayNameForSource('csv', 'Compte import CSV')).toBe('Compte import CSV');
	});

	it('does not touch the manual bucket', () => {
		expect(institutionForSource('manual')).toBeNull();
	});

	// The exclusion-set asymmetry, one layer down from `isStatementAccount` and for the same
	// reason: a source this function has never heard of must not be RENAMED on a guess. Leaving
	// the stored name alone is visible and correctable; inventing an institution for it is not.
	it('leaves a source it has never heard of exactly as it found it', () => {
		expect(institutionForSource('a-connector-shipped-next-year')).toBeNull();
		expect(displayNameForSource('a-connector-shipped-next-year', 'Whatever it was called')).toBe(
			'Whatever it was called'
		);
	});
});
