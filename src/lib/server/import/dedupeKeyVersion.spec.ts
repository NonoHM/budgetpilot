import { describe, expect, it } from 'vitest';
import {
	DEDUPE_KEY_PREFIX,
	DEDUPE_KEY_VERSION,
	dedupeKeyVersionOf,
	isCurrentDedupeKeyVersion
} from './dedupeKeyVersion';

describe('dedupeKeyVersionOf', () => {
	it('reads the current version off a prefixed key', () => {
		expect(dedupeKeyVersionOf('v3|2026-06-24|carrefour|2490|expense|acc|EUR|2|0')).toBe(
			DEDUPE_KEY_VERSION
		);
	});

	it('calls an unprefixed key legacy rather than guessing which older version it is', () => {
		// v1 and v2 are not distinguishable from the string, and nothing needs them to be: the
		// only question anything asks is whether a row is on the version this build writes.
		expect(dedupeKeyVersionOf('2026-06-24|carrefour market|2490|expense|0|')).toBe('legacy');
		expect(dedupeKeyVersionOf('2026-06-24|carrefour|2490|expense|REF1|releve.csv')).toBe('legacy');
	});

	it('cannot mistake a legacy key for a current one, because a legacy key starts with a date', () => {
		// The whole reason the prefix can serve as the backfill's pending predicate. A v1 and a v2
		// key both open with YYYY-MM-DD, so neither can open with the marker, whatever a label
		// downstream of the first field happens to contain.
		const legacyWithMarkerInItsLabel = '2026-06-24|v3|not a date|2490|expense|0|';
		expect(legacyWithMarkerInItsLabel.startsWith(DEDUPE_KEY_PREFIX)).toBe(false);
		expect(isCurrentDedupeKeyVersion(legacyWithMarkerInItsLabel)).toBe(false);
	});

	it('has nothing to say about a row that was never keyed', () => {
		// A manually entered transaction carries no import fingerprint, and must not be counted
		// as pending by anything that walks for legacy keys.
		expect(dedupeKeyVersionOf(null)).toBe(null);
		expect(dedupeKeyVersionOf(undefined)).toBe(null);
		expect(dedupeKeyVersionOf('')).toBe(null);
		expect(isCurrentDedupeKeyVersion(null)).toBe(false);
	});
});

describe('the marker itself', () => {
	it('is derived from the version rather than spelled twice', () => {
		// Two literals is how the prefix and the version number quietly stop agreeing, and the
		// prefix is what the pending predicate compares while the version is what a reader
		// reasons about.
		expect(DEDUPE_KEY_PREFIX).toBe(`v${DEDUPE_KEY_VERSION}|`);
	});

	it('ends with the field separator, so a marker cannot merge into the first field', () => {
		expect(DEDUPE_KEY_PREFIX.endsWith('|')).toBe(true);
	});
});
