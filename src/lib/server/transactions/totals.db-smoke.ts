import { describe, it, expect } from 'vitest';
import { prisma } from '$lib/server/db';
import { transactionKindWhere, resolveTransactionType } from './totals';

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
