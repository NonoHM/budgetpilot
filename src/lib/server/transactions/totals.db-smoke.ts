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
