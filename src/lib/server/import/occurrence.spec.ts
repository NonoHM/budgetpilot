import { describe, expect, it } from 'vitest';
import { createOccurrenceCounter } from './occurrence';

/** Convenience for the tests below: the ordinals a counter produces for a sequence of groups. */
function ordinals(groups: string[]): number[] {
	const next = createOccurrenceCounter();
	return groups.map(next);
}

describe('createOccurrenceCounter', () => {
	it('numbers each group independently, in source order', () => {
		expect(ordinals(['a', 'b', 'a', 'c', 'a', 'b'])).toEqual([0, 0, 1, 0, 2, 1]);
	});

	it('gives every row a zero when no two share a group', () => {
		// The other half of the pair above. A counter returning a constant zero fails the first
		// test; one returning a running index fails this one. Neither test alone pins it.
		expect(ordinals(['a', 'b', 'c'])).toEqual([0, 0, 0]);
	});

	it('numbers a prefix identically to the longer sequence that starts with it', () => {
		// The property that makes overlapping statements safe, and the whole reason the ordinal
		// is scoped to the collision group rather than to the file. Import January, then
		// January-to-February: each January group's membership is unchanged, so its ordinals hold
		// and those rows deduplicate. A file-wide ordinal would shift every row after the first
		// new one and re-import the overlap as new transactions.
		const january = ['a', 'a', 'b'];
		const januaryToFebruary = [...january, 'a', 'c'];

		const first = ordinals(january);
		const second = ordinals(januaryToFebruary);

		expect(first).toEqual([0, 1, 0]);
		expect(second.slice(0, january.length)).toEqual(first);
	});

	it('starts a fresh count per counter, so two files never continue each other', () => {
		// One counter per source is the rule the docstring states, and this is what it buys.
		// Sharing a counter across two uploads would number the second file's rows as
		// continuations of the first, so the same statement uploaded twice would key differently
		// the second time and import again, which is the exact defect the ordinal exists to
		// avoid one level up.
		expect(ordinals(['a', 'a'])).toEqual([0, 1]);
		expect(ordinals(['a', 'a'])).toEqual([0, 1]);
	});

	it('produces nothing for an empty sequence, which a caller must not read as agreement', () => {
		expect(ordinals([])).toEqual([]);
	});
});
