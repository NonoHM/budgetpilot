import { describe, expect, it } from 'vitest';
import { MAX_SEEN_CATEGORY_LENGTH, encodeSeenRow, parseSeenRow } from './seenRow';

// Note pass 1: the pin is compared with what is stored, so the parser must not normalise it. A
// restore can store an empty pin, and a name longer than a typed one, and both stay acceptable.
describe('parseSeenRow', () => {
	it('reads back what the page encodes, the empty pin of a restore included', () => {
		for (const seen of [
			{ category: null, nature: null },
			{ category: '', nature: 'uncategorized' as const },
			{ category: ' Courses ', nature: 'spending' as const },
			{ category: 'x'.repeat(191), nature: null }
		])
			expect(parseSeenRow(encodeSeenRow(seen))).toEqual(seen);
	});

	it('refuses a pin over the payload bound, and any other shape', () => {
		const over = JSON.stringify({
			category: 'x'.repeat(MAX_SEEN_CATEGORY_LENGTH + 1),
			nature: null
		});
		for (const raw of [
			over,
			'',
			'[]',
			'{"category":null}',
			'{"category":null,"nature":null,"extra":1}',
			'{"category":1,"nature":null}',
			'{"category":null,"nature":"bogus"}',
			'{"cat":null,"nature":null}'
		])
			expect(parseSeenRow(raw), raw).toBeNull();
		expect(
			parseSeenRow(JSON.stringify({ category: 'x'.repeat(MAX_SEEN_CATEGORY_LENGTH), nature: null }))
		).not.toBeNull();
	});
});
