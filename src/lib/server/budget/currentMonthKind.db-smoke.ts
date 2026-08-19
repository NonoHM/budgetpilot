import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { readCurrentMonthSpending, spentCentsFor } from '$lib/server/budget/dashboard';

/**
 * The dashboard's current-month spending must agree with every other money read about the same
 * rows. #201.
 *
 * ## The defect
 *
 * `readCurrentMonthSpending` selected `type: 'expense'` in SQL. Every other money read in the
 * application resolves the direction through `getTransactionKind`, which falls back to the SIGN
 * when `type` is null. So a negative transaction with no stored type counted as an expense in
 * /reports, in the budget summary and in every filtered total, and was INVISIBLE here — two
 * figures about one month, both on screen, one of them wrong.
 *
 * ## Why it runs against a real engine
 *
 * The defect is the WHERE clause. A fake Prisma is handed the clause and returns the fixture, so
 * a unit test asserts the fake. `vitest.db.config.ts` records the same reasoning for the suites
 * beside this one.
 *
 * ## Why the fixture leaves `type` NULL, deliberately
 *
 * That is the whole condition being tested. `allocation.db-smoke.ts` writes `type` explicitly and
 * says in a comment that it must, precisely to route around this divergence — so that suite could
 * never have caught this, and its comment stops being true with the fix. See the note there.
 *
 * ## The wall clock
 *
 * `readCurrentMonthSpending` bounds its own range with `getUTCMonth()` and cannot be pinned by an
 * argument, so the fixture is seeded into the real current UTC month, on day 15 — far enough from
 * either boundary that the month cannot roll between the seed and the read.
 */
if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a ' +
			'server engine) to a throwaway database explicitly. It refuses to fall back to the ' +
			'default local SQLite file.'
	);
}
if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const createdUserIds: string[] = [];

function currentMonthDay(dayOfMonth: number): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dayOfMonth));
}

async function seedUser(): Promise<{ userId: string; accountId: string; categoryId: string }> {
	const user = await prisma.user.create({
		data: {
			email: `current-month-kind-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);

	const account = await prisma.account.create({
		data: { userId: user.id, name: 'Compte courant', source: 'manual' },
		select: { id: true }
	});
	const category = await prisma.category.create({
		data: { userId: user.id, name: 'Alimentation', nameKey: computeNameKey('Alimentation') },
		select: { id: true }
	});

	return { userId: user.id, accountId: account.id, categoryId: category.id };
}

afterAll(async () => {
	for (const userId of createdUserIds) {
		// Transactions first, explicitly. Deleting a User cascades into both Category and
		// Transaction, and TransactionSplit is RESTRICT on Category while it cascades from
		// Transaction — reach Category first and the whole delete fails. Provider-divergent:
		// this passes on SQLite and MySQL either way and fails on PostgreSQL.
		await prisma.transaction.deleteMany({ where: { userId } });
		await prisma.category.deleteMany({ where: { userId } });
		await prisma.account.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
	}
});

describe('current-month spending resolves the kind the way every other read does', () => {
	it('counts a negative transaction whose type was never stored', async () => {
		expect.assertions(1);

		const seed = await seedUser();
		await prisma.transaction.create({
			data: {
				userId: seed.userId,
				accountId: seed.accountId,
				categoryId: seed.categoryId,
				date: currentMonthDay(15),
				label: 'Mercerie Lafayette',
				amountCents: -4520,
				// NULL, which is the condition under test. A manually entered row and several
				// import paths leave it unset, and the sign is what carries the direction.
				type: null,
				source: 'manual'
			}
		});

		const spending = await readCurrentMonthSpending(seed.userId);

		expect(spentCentsFor(spending, 'Alimentation')).toBe(4520);
	});

	it('still counts a stored expense, and still ignores a stored income', async () => {
		expect.assertions(2);

		// The control. Without it, a "fix" that dropped the kind predicate entirely — counting
		// income as spending — would pass the test above and be reported as a success.
		const seed = await seedUser();
		await prisma.transaction.createMany({
			data: [
				{
					userId: seed.userId,
					accountId: seed.accountId,
					categoryId: seed.categoryId,
					date: currentMonthDay(15),
					label: 'Boulangerie Pain Doré',
					// POSITIVE with type 'expense': how the CSV import writes an expense.
					// `persist.ts` stores Math.abs and puts the direction in `type`, so the sign
					// alone would read this as income.
					amountCents: 840,
					type: 'expense',
					source: 'import'
				},
				{
					userId: seed.userId,
					accountId: seed.accountId,
					categoryId: seed.categoryId,
					date: currentMonthDay(15),
					label: 'Salaire',
					amountCents: 245000,
					type: 'income',
					source: 'manual'
				}
			]
		});

		const spending = await readCurrentMonthSpending(seed.userId);

		expect(spentCentsFor(spending, 'Alimentation')).toBe(840);
		// And a positive row with no type is an income by the sign fallback, so it is absent.
		expect(spentCentsFor(spending, 'Salaire')).toBe(0);
	});
});
