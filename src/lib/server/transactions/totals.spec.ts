import { describe, it, expect } from 'vitest';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { resolveTransactionType, sumFilteredTotals, pickMatchedAllocation } from './totals';

/**
 * The canonical répartition from the design: 80 € at a supermarket, 60 € Alimentation + 20 € Maison,
 * with the PARENT filed under Alimentation. "Maison" is therefore present only in a part, which is
 * the whole point — a total that reads the parent cannot tell it apart from a category that is not
 * there at all.
 */
function canonicalSplitRow() {
	return {
		amountCents: -8_000,
		type: 'expense' as string | null,
		// Annotated, not inferred: TypeScript would narrow a bare `null` to the `null` TYPE, and
		// `unsplitRow`'s overrides are `Partial<ReturnType<typeof canonicalSplitRow>>`. This is the
		// fixture-narrowing trap CLAUDE.md records — vitest strips it, only `npm run check` sees it.
		manualCategory: null as string | null,
		category: { name: 'Alimentation' },
		splits: [
			{ amountCents: -6_000, category: { name: 'Alimentation' } },
			{ amountCents: -2_000, category: { name: 'Maison' } }
		]
	};
}

function unsplitRow(overrides: Partial<ReturnType<typeof canonicalSplitRow>> = {}) {
	return {
		amountCents: -1_500,
		type: 'expense' as string | null,
		manualCategory: null as string | null,
		category: { name: 'Maison' },
		splits: [] as Array<{ amountCents: number; category: { name: string } }>,
		...overrides
	};
}

describe('resolveTransactionType', () => {
	it.each([
		['income', -500, 'income'],
		['expense', 500, 'expense'],
		[null, 500, 'income'],
		[null, 0, 'income'],
		[null, -1, 'expense'],
		['other', 500, 'income'],
		['other', -1, 'expense']
	])('type=%s amount=%s resolves to %s', (type, amountCents, expected) => {
		expect(resolveTransactionType({ type: type as string | null, amountCents })).toBe(expected);
	});
});

describe('sumFilteredTotals', () => {
	it('splits by kind and reports magnitudes, not signs', () => {
		expect(
			sumFilteredTotals([
				unsplitRow({ amountCents: -4230 }),
				unsplitRow({ amountCents: 245000, type: 'income' }),
				unsplitRow({ amountCents: -1000, type: null })
			])
		).toEqual({ incomeCents: 245000, expenseCents: 5230 });
	});

	it('counts a zero amount as income, matching getTransactionKind', () => {
		expect(sumFilteredTotals([unsplitRow({ amountCents: 0, type: null })])).toEqual({
			incomeCents: 0,
			expenseCents: 0
		});
	});

	it('applies no nature policy: a transfer counts like anything else', () => {
		// Deliberate. This is a SUM of the filtered set, not an analysis of it. Adding a nature
		// filter here would make it the sixth site encoding "which natures count", each of which
		// currently disagrees with the others.
		expect(sumFilteredTotals([unsplitRow({ amountCents: -20000 })])).toEqual({
			incomeCents: 0,
			expenseCents: 20000
		});
	});

	it('returns zeroes for an empty set', () => {
		expect(sumFilteredTotals([])).toEqual({ incomeCents: 0, expenseCents: 0 });
	});

	// --- The category dimension ------------------------------------------------------------------

	it('sums the whole parent when no category dimension is active', () => {
		// The unchanged behaviour, asserted rather than assumed. Without a category the sum invariant
		// makes parent and parts identical, which is what keeps the golden master still.
		expect(sumFilteredTotals([canonicalSplitRow()])).toEqual({
			incomeCents: 0,
			expenseCents: 8_000
		});
	});

	it('sums only the matching PART when the filter carries a category present only in a part', () => {
		// The defect this test exists for: the row is matched by `?category=Maison` (OD-1 widens the
		// predicate to a part's category), and a total read off `Transaction.amountCents` reports the
		// whole 80,00 € as Maison spending. 20,00 € went to Maison.
		expect(sumFilteredTotals([canonicalSplitRow()], 'Maison')).toEqual({
			incomeCents: 0,
			expenseCents: 2_000
		});
	});

	it('sums only the matching part when the category is also the parent own', () => {
		// Alimentation is both the parent's category and one part's. The parent's 80,00 € must not be
		// added to the part's 60,00 €: that is the double-count §2.2 names, and it is the shape a fix
		// written as "parent OR parts" produces.
		expect(sumFilteredTotals([canonicalSplitRow()], 'Alimentation')).toEqual({
			incomeCents: 0,
			expenseCents: 6_000
		});
	});

	it('contributes nothing for a répartie row whose PARENT category matches and whose parts do not', () => {
		// The row is still matched — the parent's category is an identity fact and `?category=` reads
		// it — but no money went there. Zero is the honest answer, and it is the one case where the
		// list showing a row and the total ignoring it is correct rather than a bug.
		const row = canonicalSplitRow();
		row.splits = [
			{ amountCents: -6_000, category: { name: 'Transport' } },
			{ amountCents: -2_000, category: { name: 'Maison' } }
		];

		expect(sumFilteredTotals([row], 'Alimentation')).toEqual({ incomeCents: 0, expenseCents: 0 });
	});

	it('takes the PARENT kind for every part, because a part has no type of its own', () => {
		// A refund posted as income, split across two categories. Reading the part's sign instead of
		// the parent's kind would file it under expenses.
		expect(
			sumFilteredTotals(
				[
					{
						amountCents: 5_000,
						type: 'income',
						manualCategory: null,
						category: { name: 'Alimentation' },
						splits: [
							{ amountCents: 3_000, category: { name: 'Alimentation' } },
							{ amountCents: 2_000, category: { name: 'Maison' } }
						]
					}
				],
				'Maison'
			)
		).toEqual({ incomeCents: 2_000, expenseCents: 0 });
	});

	it('folds the category name, like every other category read in the app', () => {
		// `?category=maison` and `?category=Maison` are the same category. Comparing raw text here
		// would make the total depend on which spelling the user clicked.
		expect(sumFilteredTotals([canonicalSplitRow()], 'MAISON')).toEqual({
			incomeCents: 0,
			expenseCents: 2_000
		});
	});

	it('reads an unsplit row through its EFFECTIVE category, manual override included', () => {
		expect(
			sumFilteredTotals(
				[
					unsplitRow({
						amountCents: -1_500,
						manualCategory: 'Maison',
						category: { name: 'Autre' }
					}),
					unsplitRow({ amountCents: -700, category: { name: 'Autre' } })
				],
				'Maison'
			)
		).toEqual({ incomeCents: 0, expenseCents: 1_500 });
	});
});

describe('pickMatchedAllocation', () => {
	// The two ordinary (category, amountCents) pairs `allocateByCategory` would hand back for the
	// canonical répartition: 80,00 € split 60,00 € Alimentation / 20,00 € Maison.
	const alimentation = { category: 'Alimentation', amountCents: -6_000 };
	const maison = { category: 'Maison', amountCents: -2_000 };

	it('returns null when nothing matches — the identity-match, zero-money case', () => {
		expect(pickMatchedAllocation([alimentation, maison], computeNameKey('Loisirs'))).toBeNull();
	});

	it('picks the single matching entry and reports its magnitude', () => {
		expect(pickMatchedAllocation([alimentation, maison], computeNameKey('Maison'))).toEqual({
			entry: maison,
			amountCentsAbs: 2_000
		});
	});

	it('folds the category name, exactly like sumFilteredTotals', () => {
		expect(pickMatchedAllocation([alimentation, maison], computeNameKey('MAISON'))?.entry).toBe(
			maison
		);
	});

	it('sums every matching entry and keeps the DOMINANT one by magnitude, ties to the earliest', () => {
		const first = { category: 'Maison', amountCents: -3_000 };
		const second = { category: 'Maison', amountCents: -2_000 };

		const result = pickMatchedAllocation([first, second], computeNameKey('Maison'));

		expect(result?.amountCentsAbs).toBe(5_000);
		expect(result?.entry).toBe(first);
	});
});
