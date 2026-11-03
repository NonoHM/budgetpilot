import { describe, expect, it } from 'vitest';
import { MAX_PAIRS_PER_REQUEST } from '$lib/domain/transferPair';
import { parseTransferPairList } from './where';

// Pass 1189-code-2 F1: the list an Undo or an Unlink posts is refused whole, never trimmed, so
// the banner can never confirm an undo the database only half made. Ids are 8 to 64 characters
// (`normalizeId`), so the fixtures are real-length.
const id = (n: number, side: 'a' | 'b') => `${side}${String(n).padStart(9, '0')}`;
const list = (n: number) =>
	Array.from({ length: n }, (_, i) => `${id(i, 'a')}:${id(i, 'b')}`).join(',');

describe('parseTransferPairList', () => {
	it('reads each « a:b » segment as a pair', () => {
		expect(parseTransferPairList(list(2))).toEqual([
			[id(0, 'a'), id(0, 'b')],
			[id(1, 'a'), id(1, 'b')]
		]);
	});

	it('accepts exactly MAX_PAIRS_PER_REQUEST pairs and refuses one more', () => {
		expect(parseTransferPairList(list(MAX_PAIRS_PER_REQUEST))).toHaveLength(MAX_PAIRS_PER_REQUEST);
		expect(parseTransferPairList(list(MAX_PAIRS_PER_REQUEST + 1))).toBeNull();
	});

	it('refuses the whole list on one malformed segment, rather than dropping it', () => {
		const good = `${id(0, 'a')}:${id(0, 'b')}`;
		expect(parseTransferPairList(`${good},!!bad`)).toBeNull();
		expect(parseTransferPairList(`${good},${id(1, 'a')}`)).toBeNull();
		expect(parseTransferPairList(`${id(1, 'a')}:${id(1, 'a')}`)).toBeNull();
		expect(parseTransferPairList('')).toBeNull();
	});
});
