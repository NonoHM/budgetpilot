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
			'enablebanking:prov-1:E42'
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
		expect(keys.get('a')).toBe('2026-06-24|carrefour market|2490|expense|0|');
		expect(keys.get('b')).toBe('2026-06-24|boulangerie|2490|expense|0|');
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
		expect(keys.get('imported')).toBe('2026-06-24|carrefour market|2490|expense|0|');
	});

	it('keys a provider-referenced row without an ordinal, and does not let it join a content group', () => {
		const keys = assignDedupeKeys([
			bankRow({ id: 'p', entryReference: 'E42' }),
			bankRow({ id: 'c' })
		]);
		expect(keys.get('p')).toBe('enablebanking:prov-1:E42');
		expect(keys.get('c')).toBe('2026-06-24|carrefour market|2490|expense|0|enablebanking:prov-1');
	});

	it('stays unambiguous when the label contains the field delimiter', () => {
		// REPLACES safety.spec.ts's `split('|')).toHaveLength(6)`, which passes only because its
		// fixture's label has no pipe: a label with one gives seven, on a key that is perfectly
		// correct. That assertion reports on its own fixture.
		//
		// A pipe in a label is ordinary: sanitizeImportedText collapses whitespace and neutralises
		// a leading formula character, and never touches a pipe.
		//
		// The property that actually holds is that the fields are recoverable FROM THE RIGHT,
		// because every field after the label is delimiter-free by its own grammar: a magnitude is
		// digits, a type is income or expense, an ordinal is digits and a scope is empty or an
		// identifier. That is the step between "the numbering is injective" and "the keys are
		// distinct", and it was never written down.
		const key = assignDedupeKeys([csvRow({ label: 'SARL A|B' })]).get('r1')!;
		const parts = key.split('|');
		expect(parts.slice(-4)).toEqual(['2490', 'expense', '0', '']);
		expect(parts.slice(1, -4).join('|')).toBe('sarl a|b');
	});
});

describe('the v2 shape this module reproduces before the version bump', () => {
	// These three are what make the restore change a no-op with an exact oracle: the keys the
	// recompute writes are byte-identical to the keys it replaces. The version bump rewrites them.

	it('writes exactly the six fields a v2 key carries, in v2 order', () => {
		expect(assignDedupeKeys([csvRow()]).get('r1')).toBe(
			'2026-06-24|carrefour market|2490|expense|0|'
		);
	});

	it('scopes an enablebanking row the way v2 scoped it', () => {
		expect(assignDedupeKeys([bankRow({ label: 'Supérette Générale' })]).get('r1')).toBe(
			'2026-06-24|superette generale|2490|expense|0|enablebanking:prov-1'
		);
	});

	it('scopes a mock row with the bare provider id, which is what mock.ts passes', () => {
		// mock.ts:129 passes `accountScope: accountId` with no `mock:` prefix, unlike
		// enablebanking.ts:397. Reproduced rather than tidied, because tidying it here would
		// re-key every mock row and the point of this phase is that nothing moves.
		expect(
			assignDedupeKeys([
				csvRow({ source: 'mock_connector', accountId: 'acc_mock', providerAccountId: 'Prov-Mock' })
			]).get('r1')
		).toBe('2026-06-24|carrefour market|2490|expense|0|prov-mock');
	});
});
