import { describe, expect, it } from 'vitest';
import {
	findNetWorthCollisions,
	groupCollisions,
	planAccountMerges,
	planCategoryMerges,
	planValuedMerges,
	type AccountRow,
	type CategoryRow
} from './mergePlan';
import { computeNameKey } from './nameKey';

const OLD = new Date('2026-01-01T00:00:00.000Z');
const MID = new Date('2026-03-01T00:00:00.000Z');
const NEW = new Date('2026-06-01T00:00:00.000Z');

function category(overrides: Partial<CategoryRow> & { id: string; name: string }): CategoryRow {
	return {
		createdAt: MID,
		defaultKey: null,
		transactionCount: 0,
		...overrides
	};
}

function account(overrides: Partial<AccountRow> & { id: string; name: string }): AccountRow {
	return {
		createdAt: MID,
		source: 'csv',
		netWorthAccountId: null,
		bankConnectionId: null,
		providerAccountId: null,
		providerCashAccountType: null,
		transactionCount: 0,
		...overrides
	};
}

describe('groupCollisions', () => {
	it('ignores names that fold to themselves alone', () => {
		expect.assertions(1);

		const groups = groupCollisions(
			[category({ id: 'a', name: 'Courses' }), category({ id: 'b', name: 'Loyer' })],
			(row) => computeNameKey(row.name)
		);

		expect(groups).toHaveLength(0);
	});

	it('keeps the oldest row as the survivor', () => {
		expect.assertions(2);

		const groups = groupCollisions(
			[
				category({ id: 'young', name: 'courses', createdAt: NEW }),
				category({ id: 'old', name: 'Courses', createdAt: OLD })
			],
			(row) => computeNameKey(row.name)
		);

		expect(groups[0].survivor.id).toBe('old');
		expect(groups[0].losers.map((row) => row.id)).toEqual(['young']);
	});

	it('breaks a createdAt tie on the id, so the plan never depends on row order', () => {
		expect.assertions(2);

		const rows = [
			category({ id: 'b', name: 'Courses', createdAt: OLD }),
			category({ id: 'a', name: 'courses', createdAt: OLD })
		];

		expect(groupCollisions(rows, (row) => computeNameKey(row.name))[0].survivor.id).toBe('a');
		expect(
			groupCollisions([...rows].reverse(), (row) => computeNameKey(row.name))[0].survivor.id
		).toBe('a');
	});
});

describe('planCategoryMerges', () => {
	it('repoints every transaction of the losing rows onto the survivor', () => {
		expect.assertions(3);

		const [merge] = planCategoryMerges([
			category({ id: 'old', name: 'Courses', createdAt: OLD, transactionCount: 12 }),
			category({ id: 'young', name: 'courses', createdAt: NEW, transactionCount: 5 }),
			category({ id: 'younger', name: 'COURSES', createdAt: NEW, transactionCount: 2 })
		]);

		expect(merge.survivorId).toBe('old');
		// Only the losers move: the survivor's own transactions are already in place.
		expect(merge.transactionsToReassign).toBe(7);
		expect(merge.losers.map((row) => row.id)).toEqual(['young', 'younger']);
	});

	it('keeps the survivor own defaultKey when it has one', () => {
		expect.assertions(2);

		const [merge] = planCategoryMerges([
			category({ id: 'old', name: 'Courses', createdAt: OLD, defaultKey: 'food' }),
			category({ id: 'young', name: 'courses', createdAt: NEW, defaultKey: 'leisure' })
		]);

		expect(merge.resolvedDefaultKey).toBe('food');
		expect(merge.defaultKeySource).toBe('survivor');
	});

	it('adopts a loser defaultKey when the survivor is a renamed or custom category', () => {
		expect.assertions(3);

		const [merge] = planCategoryMerges([
			category({ id: 'old', name: 'Courses', createdAt: OLD, defaultKey: null }),
			category({ id: 'young', name: 'courses', createdAt: NEW, defaultKey: 'food' })
		]);

		expect(merge.resolvedDefaultKey).toBe('food');
		expect(merge.defaultKeySource).toBe('loser');
		expect(merge.discardedDefaultKeys).toEqual([]);
	});

	it('reports the default keys it drops instead of dropping them silently', () => {
		expect.assertions(2);

		const [merge] = planCategoryMerges([
			category({ id: 'old', name: 'Courses', createdAt: OLD, defaultKey: 'food' }),
			category({ id: 'young', name: 'courses', createdAt: NEW, defaultKey: 'leisure' })
		]);

		expect(merge.resolvedDefaultKey).toBe('food');
		expect(merge.discardedDefaultKeys).toEqual(['leisure']);
	});

	it('reports no default key at all when neither row carries one', () => {
		expect.assertions(2);

		const [merge] = planCategoryMerges([
			category({ id: 'old', name: 'Courses', createdAt: OLD }),
			category({ id: 'young', name: 'courses', createdAt: NEW })
		]);

		expect(merge.resolvedDefaultKey).toBeNull();
		expect(merge.defaultKeySource).toBe('none');
	});

	it('plans nothing when every name is already distinct', () => {
		expect.assertions(1);

		expect(
			planCategoryMerges([
				category({ id: 'a', name: 'Courses' }),
				category({ id: 'b', name: 'Loyer' })
			])
		).toEqual([]);
	});
});

describe('planAccountMerges', () => {
	it('does not merge across sources: uniqueness is per (name, source)', () => {
		expect.assertions(1);

		const plan = planAccountMerges([
			account({ id: 'csv', name: 'Courses', source: 'csv' }),
			account({ id: 'revolut', name: 'courses', source: 'revolut' })
		]);

		expect(plan.merges).toEqual([]);
	});

	it('merges two buckets of the same source and moves their transactions', () => {
		expect.assertions(2);

		const plan = planAccountMerges([
			account({ id: 'old', name: 'Compte', createdAt: OLD, transactionCount: 40 }),
			account({ id: 'young', name: 'compte', createdAt: NEW, transactionCount: 3 })
		]);

		expect(plan.merges[0].survivorId).toBe('old');
		expect(plan.merges[0].transactionsToReassign).toBe(3);
	});

	it('lets the survivor adopt link fields it does not have', () => {
		expect.assertions(2);

		const plan = planAccountMerges([
			account({ id: 'old', name: 'Compte', createdAt: OLD }),
			account({
				id: 'young',
				name: 'compte',
				createdAt: NEW,
				netWorthAccountId: 'nwa-1',
				providerCashAccountType: 'CACC'
			})
		]);

		expect(plan.merges[0].adoptedLinks.netWorthAccountId).toBe('nwa-1');
		expect(plan.merges[0].adoptedLinks.providerCashAccountType).toBe('CACC');
	});

	it('never overwrites a link the survivor already has', () => {
		expect.assertions(1);

		const plan = planAccountMerges([
			account({ id: 'old', name: 'Compte', createdAt: OLD, netWorthAccountId: 'nwa-keep' }),
			account({ id: 'young', name: 'compte', createdAt: NEW })
		]);

		expect(plan.merges[0].adoptedLinks.netWorthAccountId).toBeUndefined();
	});

	it.each([
		['netWorthAccountId', { netWorthAccountId: 'nwa-1' }, { netWorthAccountId: 'nwa-2' }],
		['bankConnectionId', { bankConnectionId: 'conn-1' }, { bankConnectionId: 'conn-2' }],
		['providerAccountId', { providerAccountId: 'prov-1' }, { providerAccountId: 'prov-2' }]
	])('refuses to merge when the rows hold different %s values', (field, first, second) => {
		expect.assertions(3);

		// Two buckets pointing at different things are two real buckets that happen to be
		// named alike. Merging would silently drop one of the links, so nothing is merged
		// and the operator is told instead.
		const plan = planAccountMerges([
			account({ id: 'old', name: 'Compte', createdAt: OLD, ...first }),
			account({ id: 'young', name: 'compte', createdAt: NEW, ...second })
		]);

		expect(plan.merges).toEqual([]);
		expect(plan.blocked).toHaveLength(1);
		expect(plan.blocked[0].conflictingField).toBe(field);
	});

	it('merges when only one row carries the link, since nothing is lost', () => {
		expect.assertions(2);

		const plan = planAccountMerges([
			account({ id: 'old', name: 'Compte', createdAt: OLD }),
			account({ id: 'young', name: 'compte', createdAt: NEW, bankConnectionId: 'conn-1' })
		]);

		expect(plan.blocked).toEqual([]);
		expect(plan.merges[0].adoptedLinks.bankConnectionId).toBe('conn-1');
	});
});

describe('planValuedMerges', () => {
	function budget(id: string, categoryName: string, value: number, updatedAt: Date) {
		return { id, categoryName, value, createdAt: OLD, updatedAt };
	}

	it('keeps the most recently edited value, not the survivor own', () => {
		expect.assertions(3);

		const [merge] = planValuedMerges([
			budget('old', 'Courses', 25_000, MID),
			budget('young', 'courses', 40_000, NEW)
		]);

		// The oldest row survives so ids stay stable, but the newest edit is what the user
		// last meant, so that is the value it keeps.
		expect(merge.survivorId).toBe('old');
		expect(merge.resolvedValue).toBe(40_000);
		expect(merge.valueSource).toBe('loser');
	});

	it('keeps the survivor value when the survivor is also the most recent edit', () => {
		expect.assertions(2);

		const [merge] = planValuedMerges([
			budget('old', 'Courses', 25_000, NEW),
			budget('young', 'courses', 40_000, MID)
		]);

		expect(merge.resolvedValue).toBe(25_000);
		expect(merge.valueSource).toBe('survivor');
	});

	it('names the value it throws away, not just the one it keeps', () => {
		expect.assertions(2);

		const [merge] = planValuedMerges([
			budget('old', 'Courses', 25_000, MID),
			budget('young', 'courses', 40_000, NEW)
		]);

		expect(merge.losers).toEqual([{ id: 'young', name: 'courses', value: 40_000 }]);
		// The survivor's own 250 EUR is what actually disappears here, and the report has to
		// be able to say so.
		expect(merge.discardedValues).toEqual([{ name: 'Courses', value: 25_000 }]);
	});

	it('works the same on natures, which are strings rather than amounts', () => {
		expect.assertions(1);

		const [merge] = planValuedMerges([
			{ id: 'old', categoryName: 'Courses', value: 'spending', createdAt: OLD, updatedAt: MID },
			{ id: 'young', categoryName: 'COURSES', value: 'investment', createdAt: OLD, updatedAt: NEW }
		]);

		expect(merge.resolvedValue).toBe('investment');
	});
});

describe('findNetWorthCollisions', () => {
	it('reports a folded pair without proposing anything', () => {
		expect.assertions(1);

		const collisions = findNetWorthCollisions([
			{ id: 'a', name: 'Livret A', deletedAt: null, createdAt: OLD },
			{ id: 'b', name: 'livret a', deletedAt: null, createdAt: NEW }
		]);

		expect(collisions).toEqual([
			{ key: computeNameKey('Livret A'), names: ['Livret A', 'livret a'] }
		]);
	});

	it('ignores soft-deleted accounts, which uniqueness never covered', () => {
		expect.assertions(1);

		const collisions = findNetWorthCollisions([
			{ id: 'a', name: 'Livret A', deletedAt: null, createdAt: OLD },
			{ id: 'b', name: 'livret a', deletedAt: NEW, createdAt: NEW }
		]);

		expect(collisions).toEqual([]);
	});
});
