import { describe, expect, it } from 'vitest';
import { normalizeForMatch } from '$lib/domain/normalize';
import {
	assignDedupeKeys,
	buildProviderRowKey,
	buildRowGroupKey,
	foldLabelForSource,
	type KeyableRow
} from './dedupeRecompute';

const csvRow = (over: Partial<KeyableRow> = {}): KeyableRow => ({
	id: 'r1',
	source: 'csv',
	accountId: 'acc_csv',
	date: '2026-06-24',
	label: 'Carrefour Market',
	amountCents: -2490,
	type: 'expense',
	currency: 'EUR',
	exponent: 2,
	providerAccountId: null,
	entryReference: null,
	keyed: true,
	...over
});

const bankRow = (over: Partial<KeyableRow> = {}): KeyableRow =>
	csvRow({
		source: 'enablebanking',
		accountId: 'acc_bank',
		providerAccountId: 'prov-1',
		...over
	});

describe('foldLabelForSource', () => {
	it('strips accents on the connector path and does not on the CSV path', () => {
		// Not a preference. `enablebanking.ts:363` feeds normalizeForMatch(label) into the group
		// while STORING the raw label, and the five CSV profiles pass one variable to both. So a
		// fixture drawn from CSV alone measures an identity on this property and can never fail
		// it, which is why the asymmetric case is the one written down.
		expect(foldLabelForSource('enablebanking', 'Supérette Générale')).toBe('superette generale');
		expect(foldLabelForSource('csv', 'Supérette Générale')).toBe('supérette générale');
	});

	it('folds the mock connector like a CSV row, because that is what the mock does', () => {
		// mock.ts:125 passes the raw label. The accent fold is enablebanking's alone, and
		// generalising it to "every bank source" would silently re-key every mock row.
		expect(foldLabelForSource('mock_connector', 'Supérette Générale')).toBe('supérette générale');
	});

	it('calls the production folder rather than retyping what it does', () => {
		// The oracle is the function itself: a retyped accent table would assert the copy.
		expect(foldLabelForSource('enablebanking', 'Café  Noir')).toBe(
			normalizeForMatch('Café  Noir').trim().toLowerCase().replace(/\s+/g, ' ')
		);
	});

	it('collapses whitespace and lowercases on both paths', () => {
		expect(foldLabelForSource('csv', '  CARREFOUR   MARKET ')).toBe('carrefour market');
		expect(foldLabelForSource('enablebanking', '  CARREFOUR   MARKET ')).toBe('carrefour market');
	});
});

describe('buildRowGroupKey', () => {
	it('takes the magnitude, whichever sign the caller passes', () => {
		// The direction lives in `type`. A signed amount and a magnitude must not produce two
		// groups for one transaction.
		expect(buildRowGroupKey(csvRow({ amountCents: -2490 }))).toBe(
			buildRowGroupKey(csvRow({ amountCents: 2490 }))
		);
	});

	it('has nothing to key a row whose type is null', () => {
		// A row with no direction cannot be keyed, and leaving it unkeyed makes it invisible to
		// deduplication rather than wrongly matched.
		expect(buildRowGroupKey(csvRow({ type: null }))).toBe(null);
	});

	it('has nothing to key a row whose direction is absent or unrecognised', () => {
		// An ALLOWLIST, not a null check, and the difference is a defect this caught. `type` is
		// `string | null` in the database and a union here, so a null check reads as sufficient. It
		// is not: an untyped caller reaches this with `undefined` and an older row could hold any
		// string, and both used to fall through and put the value straight into the key. A missing
		// direction then produced a key reading `...|undefined`, and every row with a missing
		// direction deduplicated against every other one.
		expect(buildRowGroupKey(csvRow({ type: undefined as unknown as null }))).toBe(null);
		expect(buildRowGroupKey(csvRow({ type: 'transfer' as unknown as null }))).toBe(null);
		expect(buildRowGroupKey(csvRow({ type: '' as unknown as null }))).toBe(null);
	});

	it('has nothing to key a row that was never keyed', () => {
		// A manually entered transaction has no import fingerprint, and inventing one would make
		// a row the user typed compete for identity with rows a file produced.
		expect(buildRowGroupKey(csvRow({ keyed: false }))).toBe(null);
	});
});

describe('buildProviderRowKey', () => {
	it('keys a bank row on its per-account entry reference', () => {
		// entry_reference is the provider's own stable per-account anchor. transaction_id is not
		// used: the provider says it may change if the list is fetched again.
		expect(buildProviderRowKey(bankRow({ entryReference: 'E42' }))).toBe(
			'v3|enablebanking|prov-1|E42'
		);
	});

	it('declines when the provider omitted the reference, so the content branch takes over', () => {
		expect(buildProviderRowKey(bankRow({ entryReference: '' }))).toBe(null);
		expect(buildProviderRowKey(bankRow({ entryReference: null }))).toBe(null);
	});

	it('declines on a row with no provider account to scope a reference to', () => {
		expect(buildProviderRowKey(csvRow({ entryReference: 'E42' }))).toBe(null);
	});

	it('declines on a row that was never keyed', () => {
		expect(buildProviderRowKey(bankRow({ entryReference: 'E42', keyed: false }))).toBe(null);
	});
});

describe('assignDedupeKeys', () => {
	it('separates two otherwise identical rows by a dense ordinal', () => {
		const keys = assignDedupeKeys([csvRow({ id: 'a' }), csvRow({ id: 'b' })]);
		expect(keys.get('a')).not.toBe(keys.get('b'));
	});

	it('numbers each group from zero, so a second group is not a continuation of the first', () => {
		const keys = assignDedupeKeys([csvRow({ id: 'a' }), csvRow({ id: 'b', label: 'Boulangerie' })]);
		expect(keys.get('a')).toBe('v3|2026-06-24|carrefour market|2490|expense|acc_csv|EUR|2|0');
		expect(keys.get('b')).toBe('v3|2026-06-24|boulangerie|2490|expense|acc_csv|EUR|2|0');
	});

	it('is stable: the same rows in the same order give the same answer twice', () => {
		const rows = [csvRow({ id: 'a' }), csvRow({ id: 'b' })];
		expect([...assignDedupeKeys(rows)]).toEqual([...assignDedupeKeys(rows)]);
	});

	it('leaves a manual row and a null-type row unkeyed, and lets neither consume an ordinal', () => {
		// An ordinal consumed by a row that carries no key shifts the keyed row beside it, and a
		// re-import of the file that produced the keyed row would then not match it.
		const keys = assignDedupeKeys([
			csvRow({ id: 'manual', source: 'manual', keyed: false }),
			csvRow({ id: 'untyped', type: null }),
			csvRow({ id: 'imported' })
		]);
		expect(keys.get('manual')).toBe(null);
		expect(keys.get('untyped')).toBe(null);
		expect(keys.get('imported')).toBe(
			'v3|2026-06-24|carrefour market|2490|expense|acc_csv|EUR|2|0'
		);
	});

	it('keys a provider-referenced row without an ordinal, and does not let it join a content group', () => {
		const keys = assignDedupeKeys([
			bankRow({ id: 'p', entryReference: 'E42' }),
			bankRow({ id: 'c' })
		]);
		expect(keys.get('p')).toBe('v3|enablebanking|prov-1|E42');
		expect(keys.get('c')).toBe('v3|2026-06-24|carrefour market|2490|expense|acc_bank|EUR|2|0');
	});
});

describe('the v3 key', () => {
	it('carries the version marker, the group and the ordinal, in that order', () => {
		expect(assignDedupeKeys([csvRow()]).get('r1')).toBe(
			'v3|2026-06-24|carrefour market|2490|expense|acc_csv|EUR|2|0'
		);
	});

	it('starts with its own group key, so the two cannot drift', () => {
		// The reason the ordinal is LAST rather than in the middle as the design note draws it:
		// the group becomes a literal prefix of the key, so there is exactly one expression for it
		// and no second copy to disagree with.
		const row = csvRow();
		const key = assignDedupeKeys([row]).get('r1')!;
		expect(key.startsWith(`${buildRowGroupKey(row)}|`)).toBe(true);
	});

	it('separates two amounts of one magnitude in different currencies', () => {
		// SEPARATE calls, and that is the whole test. Passing both rows to one call puts them in
		// one group and the ORDINAL separates them, so the assertion goes green on a key that
		// carries no currency at all. Measured: this test passed against the previous key shape
		// before the fixtures were split.
		expect(assignDedupeKeys([csvRow({ currency: 'EUR' })]).get('r1')).not.toBe(
			assignDedupeKeys([csvRow({ currency: 'GBP' })]).get('r1')
		);
	});

	it('separates two amounts of one magnitude at different exponents', () => {
		// Magnitude plus currency does not identify an amount. 1000 EUR is ten euros at exponent 2
		// and one euro at exponent 3, so a key that merges them lets the unique constraint drop
		// one. That is why the exponent is in the key at all: it is stored per row precisely
		// because the currency does not determine it.
		expect(assignDedupeKeys([csvRow({ exponent: 2 })]).get('r1')).not.toBe(
			assignDedupeKeys([csvRow({ exponent: 3 })]).get('r1')
		);
	});

	it('separates one transaction held by two accounts, which is what #449 asks for', () => {
		// Separate calls again: this is the SAME transaction imported into two accounts, which is
		// two runs, not one batch.
		expect(assignDedupeKeys([csvRow({ accountId: 'acc_one' })]).get('r1')).not.toBe(
			assignDedupeKeys([csvRow({ accountId: 'acc_two' })]).get('r1')
		);
	});

	it('prefixes the provider branch too, so no key this build writes is unprefixed', () => {
		// The prefix is what makes `NOT LIKE 'v3|%'` an exact pending predicate for the backfill.
		// A provider-keyed row left unprefixed would be walked forever.
		expect(assignDedupeKeys([bankRow({ entryReference: 'E42' })]).get('r1')).toBe(
			'v3|enablebanking|prov-1|E42'
		);
	});

	it('cannot be mistaken for a legacy key, because a legacy key opens with a date', () => {
		const key = assignDedupeKeys([csvRow()]).get('r1')!;
		expect(key.startsWith('v3|')).toBe(true);
		expect(/^\d{4}-\d{2}-\d{2}\|/.test(key)).toBe(false);
	});
});

describe('the format is injective BY CONSTRUCTION, not by an argument', () => {
	// The delimiter question, settled rather than reasoned about. The previous key was unambiguous
	// only because every field after the label happened to be delimiter-free by its own grammar,
	// and that argument was never written down, so the next field added would have broken it
	// silently. Encoding removes the argument.
	//
	// ASVS 5.0.0 1.3.3: "Verify that data being passed to a potentially dangerous context is
	// sanitized beforehand to enforce safety measures, such as only allowing characters which are
	// safe for this context".

	it('encodes a delimiter inside a label rather than letting it become a field boundary', () => {
		const key = assignDedupeKeys([csvRow({ label: 'SARL A|B' })]).get('r1')!;
		expect(key).toBe('v3|2026-06-24|sarl a%7cb|2490|expense|acc_csv|EUR|2|0');
		// Nine fields, whatever the label contains. The old assertion counted fields by splitting
		// on the delimiter, which measures whether the fixture's label has one.
		expect(key.split('|')).toHaveLength(9);
	});

	it('encodes the escape character itself, so the encoding is reversible', () => {
		// Without escaping `%`, a label containing the literal escape sequence and one containing
		// a real pipe encode to the same string, and two different merchants become one
		// transaction. The escape is emitted in LOWERCASE so this test cannot pass by the accident
		// of the fold having lowercased the label first.
		expect(assignDedupeKeys([csvRow({ label: 'A|B' })]).get('r1')).not.toBe(
			assignDedupeKeys([csvRow({ label: 'A%7CB' })]).get('r1')
		);
	});

	it('separates two provider rows that the old colon-joined shape would have merged', () => {
		// The gap this fixes, and it was live: `enablebanking:<account>:<reference>` joined two
		// provider-supplied fields with a delimiter both can contain, so ("a", "b:c") and
		// ("a:b", "c") produced one key and one of two real transactions was silently dropped.
		// The colliding pair uses the OLD delimiter, `:`, because that is the pair the old shape
		// merged. A pair chosen with the new delimiter would differ under both shapes and prove
		// nothing.
		expect(
			assignDedupeKeys([bankRow({ providerAccountId: 'a', entryReference: 'b:c' })]).get('r1')
		).not.toBe(
			assignDedupeKeys([bankRow({ providerAccountId: 'a:b', entryReference: 'c' })]).get('r1')
		);
	});
});
