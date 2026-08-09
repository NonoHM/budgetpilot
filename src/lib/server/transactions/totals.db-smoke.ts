import { describe, it, expect } from 'vitest';
import { prisma } from '$lib/server/db';
import {
	transactionKindWhere,
	resolveTransactionType,
	computeFilteredTotals,
	sumFilteredTotals
} from './totals';
import { buildTransactionWhere } from './where';
import { replaceSplits } from './splits';
import { computeNameKey } from '$lib/server/naming/nameKey';

/**
 * The SQL predicate and the TypeScript function must agree, on every engine, over every shape a
 * row can take. They have no shared implementation, so nothing but this stops them drifting.
 *
 * Modelled on the feedsCashFlowProjection anti-drift test from #97, and required here for the
 * reason CLAUDE.md gives under "Unit tests cannot see a wrong SQL predicate": a fixture-injected
 * unit test replaces the very SQL in question. `NULL NOT IN (...)` in particular is unknown, not
 * true, and no vitest fixture can show that.
 *
 * See vitest.db.config.ts for how to run it.
 */

// Same refusal as crossProvider.db-smoke.ts and prune.db-smoke.ts, for the same reason: the app's
// client falls back to `file:./dev.db`, a developer's real local database, and this suite writes
// and deletes rows.
if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly. It refuses to fall back to the default local ' +
			'SQLite file.'
	);
}

if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const TYPES = ['income', 'expense', null, 'other'] as const;
const AMOUNTS = [-1, 0, 1] as const;

async function seedUser() {
	const user = await prisma.user.create({
		data: {
			email: `totals-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			// Not a hash of anything, and never used to authenticate: nothing in this suite logs in.
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	const account = await prisma.account.create({
		data: { userId: user.id, name: 'Totals smoke account' },
		select: { id: true }
	});
	const category = await prisma.category.create({
		data: { userId: user.id, name: 'Totals smoke category' },
		select: { id: true }
	});
	return { userId: user.id, accountId: account.id, categoryId: category.id };
}

describe('transaction kind predicate', () => {
	it('agrees with resolveTransactionType over the full type x sign matrix', async () => {
		const { userId, accountId, categoryId } = await seedUser();

		const rows = TYPES.flatMap((type) =>
			AMOUNTS.map((amountCents) => ({
				userId,
				accountId,
				categoryId,
				date: new Date('2026-07-01T00:00:00.000Z'),
				label: `${type}-${amountCents}`,
				amountCents,
				type,
				source: 'manual'
			}))
		);
		await prisma.transaction.createMany({ data: rows });
		expect(rows).toHaveLength(12);

		for (const kind of ['income', 'expense'] as const) {
			const matched = await prisma.transaction.findMany({
				where: { AND: [{ userId }, transactionKindWhere(kind)] },
				select: { label: true, amountCents: true, type: true }
			});
			const expected = rows
				.filter((row) => resolveTransactionType(row) === kind)
				.map((row) => row.label)
				.sort();

			expect(matched.map((row) => row.label).sort()).toEqual(expected);
		}

		// Every row lands in exactly one bucket: no row is counted twice, and none is dropped.
		const incomeCount = await prisma.transaction.count({
			where: { AND: [{ userId }, transactionKindWhere('income')] }
		});
		const expenseCount = await prisma.transaction.count({
			where: { AND: [{ userId }, transactionKindWhere('expense')] }
		});
		expect(incomeCount + expenseCount).toBe(rows.length);

		await prisma.user.delete({ where: { id: userId } });
	}, 60_000);
});

/**
 * The category branch of computeFilteredTotals, which is SQL and therefore unprovable in a unit
 * test: a fixture-injected mock replaces the very aggregate under test. The absolute figure is what
 * matters here — 20,00 €, not "the same as the other implementation" — because the two
 * implementations could agree on 80,00 € and both be wrong, which is the anti-drift trap CLAUDE.md
 * records. The agreement assertion is a second, weaker check on top of it.
 */
describe('filtered totals with a category dimension', () => {
	it('sums the matching PARTS, not the parents, and agrees with the in-memory twin', async () => {
		const { userId, accountId } = await seedUser();
		const [food, home] = await Promise.all([
			prisma.category.create({
				data: { userId, name: 'Alimentation', nameKey: computeNameKey('Alimentation') },
				select: { id: true }
			}),
			prisma.category.create({
				data: { userId, name: 'Maison', nameKey: computeNameKey('Maison') },
				select: { id: true }
			})
		]);

		// The canonical case, plus an UNSPLIT row in Maison. Without the second row the assertion
		// could not distinguish "sums the parts" from "sums nothing at all for a répartie row".
		const split = await prisma.transaction.create({
			data: {
				userId,
				accountId,
				categoryId: food.id,
				date: new Date('2026-07-01T00:00:00.000Z'),
				label: 'Carrefour Market',
				amountCents: -8_000,
				type: 'expense',
				source: 'manual'
			},
			select: { id: true }
		});
		await prisma.transaction.create({
			data: {
				userId,
				accountId,
				categoryId: home.id,
				date: new Date('2026-07-02T00:00:00.000Z'),
				label: 'Quincaillerie',
				amountCents: -1_500,
				type: 'expense',
				source: 'manual'
			}
		});
		const replaced = await replaceSplits(userId, split.id, [
			{ categoryId: food.id, amountCents: -6_000 },
			{ categoryId: home.id, amountCents: -2_000 }
		]);
		expect(replaced).toEqual({ ok: true });

		const whereMaison = buildTransactionWhere({
			userId,
			type: 'all',
			category: 'Maison',
			importBatchId: ''
		});

		// OD-1: the répartie row is MATCHED by ?category=Maison even though its parent is
		// Alimentation. Asserted first, because the total below is only interesting if the row it
		// must not over-count is actually in the set.
		const matched = await prisma.transaction.findMany({
			where: whereMaison,
			select: { id: true, label: true }
		});
		expect(matched.map((row) => row.label).sort()).toEqual(['Carrefour Market', 'Quincaillerie']);

		// 2000 from the part + 1500 from the unsplit row. A parent-based total reads 9500.
		expect(await computeFilteredTotals(whereMaison, { userId, name: 'Maison' })).toEqual({
			incomeCents: 0,
			expenseCents: 3_500
		});

		// And the `?q=` path's twin, over the same rows, must return the same figure.
		const rows = await prisma.transaction.findMany({
			where: whereMaison,
			select: {
				amountCents: true,
				type: true,
				manualCategory: true,
				category: { select: { name: true } },
				splits: { select: { amountCents: true, category: { select: { name: true } } } }
			}
		});
		expect(sumFilteredTotals(rows, 'Maison')).toEqual({ incomeCents: 0, expenseCents: 3_500 });

		// With NO category dimension both paths report the parents, unchanged — the property that
		// keeps every figure outside this feature still.
		const whereAll = buildTransactionWhere({
			userId,
			type: 'all',
			category: '',
			importBatchId: ''
		});
		expect(await computeFilteredTotals(whereAll)).toEqual({
			incomeCents: 0,
			expenseCents: 9_500
		});

		// A category the parent carries and no part does: matched on identity, contributing nothing.
		await prisma.transaction.create({
			data: {
				userId,
				accountId,
				categoryId: home.id,
				date: new Date('2026-07-03T00:00:00.000Z'),
				label: 'Meuble reparti',
				amountCents: -4_000,
				type: 'expense',
				source: 'manual'
			},
			select: { id: true }
		});
		const parentOnly = await prisma.transaction.findFirst({
			where: { userId, label: 'Meuble reparti' },
			select: { id: true }
		});
		await replaceSplits(userId, parentOnly!.id, [
			{ categoryId: food.id, amountCents: -3_000 },
			{ categoryId: food.id, amountCents: -1_000 }
		]);
		expect(await computeFilteredTotals(whereMaison, { userId, name: 'Maison' })).toEqual({
			incomeCents: 0,
			expenseCents: 3_500
		});

		await prisma.transaction.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
	}, 60_000);
});

/**
 * MIXED STORED SIGNS INSIDE ONE BUCKET — the condition every other fixture in this file removes.
 *
 * `import/persist.ts:317` stores `Math.abs(amountCents)` and puts the direction in `type`, while a
 * manually added transaction stores a signed amount. So any user who has both imported a CSV and
 * added a transaction by hand holds an expense bucket containing positive AND negative rows, and
 * that is the app's primary data-entry path, not an edge case.
 *
 * `computeFilteredTotals` used to `_sum` first and `Math.abs` last, so inside one bucket a
 * positive-stored expense CANCELLED a negative-stored one. `sumFilteredTotals` takes the magnitude
 * PER ROW and never cancels. The two are supposed to agree and did not — and the agreement suite
 * could not see it, because every fixture above is uniformly negative. That is CLAUDE.md's own
 * entry: a fixture that holds still is not a neutral fixture, it is a fixture that has removed the
 * conditions under which the bug happens.
 *
 * Measured on a seeded instance before the fix, at `/transactions?type=expense`: the band read
 * 99,47 € where the truth is 399,47 €, under-reporting by 300,00 € — exactly twice the 150,00 € of
 * positive-stored magnitudes. The figures below reproduce that arithmetic.
 */
describe('filtered totals over mixed stored signs', () => {
	it('sums magnitudes rather than cancelling, and agrees with the in-memory twin', async () => {
		const { userId, accountId, categoryId } = await seedUser();

		// -249,47 € of ordinary signed expenses, plus the two positive-stored imported ones
		// (90,00 € and 60,00 €). Σ signed = -99,47 €; Σ magnitudes = 399,47 € — the measured pair.
		const rows = [
			{ label: 'Loyer', amountCents: -18_000, type: 'expense' },
			{ label: 'Assurance', amountCents: -6_947, type: 'expense' },
			{ label: 'EDF FACTURE', amountCents: 9_000, type: 'expense' },
			{ label: 'COURSES DIVERSES', amountCents: 6_000, type: 'expense' },
			{ label: 'Salaire', amountCents: 250_000, type: 'income' },
			// An income stored as a NEGATIVE magnitude, the mirror case: the same cancellation in the
			// other bucket, and the sign that a fixture built from expenses alone never exercises.
			{ label: 'Remboursement', amountCents: -40_000, type: 'income' }
		];
		await prisma.transaction.createMany({
			data: rows.map((row, index) => ({
				userId,
				accountId,
				categoryId,
				date: new Date(`2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
				label: row.label,
				amountCents: row.amountCents,
				type: row.type,
				source: 'csv'
			}))
		});

		const whereAll = buildTransactionWhere({
			userId,
			type: 'all',
			category: '',
			importBatchId: ''
		});
		// The URL the defect was measured on.
		const whereExpense = buildTransactionWhere({
			userId,
			type: 'expense',
			category: '',
			importBatchId: ''
		});

		// THE MEASURED PAIR. Σ|expense| = 18000 + 6947 + 9000 + 6000 = 39947 — the band reads
		// 399,47 €. The cancelling implementation answered |−24947 + 15000| = 9947, i.e. 99,47 €,
		// short by exactly twice the 150,00 € of positive-stored magnitudes.
		expect(await computeFilteredTotals(whereExpense)).toEqual({
			incomeCents: 0,
			expenseCents: 39_947
		});

		// ABSOLUTE first, over the unfiltered set. Σ|income| = 250000 + 40000 = 290000; the same
		// cancellation in the other bucket answered 210000, so the mirror sign is covered too.
		expect(await computeFilteredTotals(whereAll)).toEqual({
			incomeCents: 290_000,
			expenseCents: 39_947
		});

		// Then the agreement, which is the weaker of the two checks and is stated second on purpose.
		const loaded = await prisma.transaction.findMany({
			where: whereAll,
			select: {
				amountCents: true,
				type: true,
				manualCategory: true,
				category: { select: { name: true } },
				splits: { select: { amountCents: true, category: { select: { name: true } } } }
			}
		});
		expect(sumFilteredTotals(loaded)).toEqual(await computeFilteredTotals(whereAll));

		await prisma.transaction.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
	}, 60_000);

	it('does not cancel inside the CATEGORY branch either, on parents or on parts', async () => {
		const { userId, accountId } = await seedUser();
		const [food, home] = await Promise.all([
			prisma.category.create({
				data: { userId, name: 'Alimentation', nameKey: computeNameKey('Alimentation') },
				select: { id: true }
			}),
			prisma.category.create({
				data: { userId, name: 'Maison', nameKey: computeNameKey('Maison') },
				select: { id: true }
			})
		]);

		// Two répartitions of opposite STORED sign, both expenses. `replaceSplits` requires each part
		// to carry the parent ROW's sign, so an imported répartition is stored entirely positive —
		// which means the part aggregate cancels exactly as the parent one did.
		const imported = await prisma.transaction.create({
			data: {
				userId,
				accountId,
				categoryId: food.id,
				date: new Date('2026-07-01T00:00:00.000Z'),
				label: 'Carrefour importe',
				amountCents: 8_000,
				type: 'expense',
				source: 'csv'
			},
			select: { id: true }
		});
		const manual = await prisma.transaction.create({
			data: {
				userId,
				accountId,
				categoryId: food.id,
				date: new Date('2026-07-02T00:00:00.000Z'),
				label: 'Carrefour saisi',
				amountCents: -5_000,
				type: 'expense',
				source: 'manual'
			},
			select: { id: true }
		});
		expect(
			await replaceSplits(userId, imported.id, [
				{ categoryId: food.id, amountCents: 6_000 },
				{ categoryId: home.id, amountCents: 2_000 }
			])
		).toEqual({ ok: true });
		expect(
			await replaceSplits(userId, manual.id, [
				{ categoryId: food.id, amountCents: -4_000 },
				{ categoryId: home.id, amountCents: -1_000 }
			])
		).toEqual({ ok: true });

		// Unsplit rows in Maison, one of each stored sign, so the parent aggregate mixes too.
		await prisma.transaction.createMany({
			data: [
				{
					userId,
					accountId,
					categoryId: home.id,
					date: new Date('2026-07-03T00:00:00.000Z'),
					label: 'Quincaillerie importee',
					amountCents: 1_500,
					type: 'expense',
					source: 'csv'
				},
				{
					userId,
					accountId,
					categoryId: home.id,
					date: new Date('2026-07-04T00:00:00.000Z'),
					label: 'Quincaillerie saisie',
					amountCents: -700,
					type: 'expense',
					source: 'manual'
				}
			]
		});

		const whereMaison = buildTransactionWhere({
			userId,
			type: 'all',
			category: 'Maison',
			importBatchId: ''
		});

		// Parts: 2000 + 1000. Unsplit parents: 1500 + 700. Total 5200. Cancelling answers
		// |2000 - 1000| + |1500 - 700| = 1800.
		expect(await computeFilteredTotals(whereMaison, { userId, name: 'Maison' })).toEqual({
			incomeCents: 0,
			expenseCents: 5_200
		});

		const loaded = await prisma.transaction.findMany({
			where: whereMaison,
			select: {
				amountCents: true,
				type: true,
				manualCategory: true,
				category: { select: { name: true } },
				splits: { select: { amountCents: true, category: { select: { name: true } } } }
			}
		});
		expect(sumFilteredTotals(loaded, 'Maison')).toEqual(
			await computeFilteredTotals(whereMaison, { userId, name: 'Maison' })
		);

		await prisma.transaction.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
	}, 60_000);
});
