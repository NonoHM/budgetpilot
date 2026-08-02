import type { Prisma } from '../database/types.ts';
import { getTransactionKind, type TransactionKind } from '$lib/domain/transaction';
import { prisma } from '$lib/server/db';

/**
 * The one place the app turns a stored row into income-or-expense.
 *
 * This function existed twice, byte-identically and privately, in routes/transactions/+page.server.ts
 * and routes/transactions/export/+server.ts, plus as an inlined ternary in at least three more
 * places. Both copies are now imports of this one.
 */
export function resolveTransactionType(transaction: {
	amountCents: number;
	type: string | null;
}): TransactionKind {
	return getTransactionKind({
		amountCents: transaction.amountCents,
		type:
			transaction.type === 'income' || transaction.type === 'expense' ? transaction.type : undefined
	});
}

/**
 * The SQL twin of resolveTransactionType, and the riskiest few lines in this feature.
 *
 * `Transaction.type` is nullable, and getTransactionKind falls back to the sign of `amountCents`
 * whenever it is not exactly 'income' or 'expense'. Reproducing that in SQL has one trap that no
 * amount of reading catches: `notIn` does NOT match NULL, because SQL three-valued logic makes
 * `NULL NOT IN (...)` unknown rather than true. Omitting the explicit `{ type: null }` branch
 * silently drops every row with no stored type from BOTH totals.
 *
 * That is exactly the class of defect CLAUDE.md records as invisible to unit tests: the fixture is
 * what replaces the SQL. totals.db-smoke.ts asserts this predicate and getTransactionKind agree
 * over the full type x sign matrix, against all three engines.
 */
export function transactionKindWhere(kind: TransactionKind): Prisma.TransactionWhereInput {
	const typeIsUnset: Prisma.TransactionWhereInput = {
		OR: [{ type: null }, { type: { notIn: ['income', 'expense'] } }]
	};

	if (kind === 'income') {
		return {
			OR: [{ type: 'income' }, { AND: [typeIsUnset, { amountCents: { gte: 0 } }] }]
		};
	}
	return {
		OR: [{ type: 'expense' }, { AND: [typeIsUnset, { amountCents: { lt: 0 } }] }]
	};
}

export interface FilteredTotals {
	incomeCents: number;
	expenseCents: number;
}

/**
 * Income and expense magnitudes over the WHOLE filtered set, not the current page.
 *
 * A sum, not a policy: no nature is excluded. Every existing "spend by X" site in this codebase
 * encodes its own rule about which natures count, and the five of them disagree. This one answers
 * a narrower question, "what does the set I am looking at add up to", so it needs no rule at all.
 */
export async function computeFilteredTotals(
	where: Prisma.TransactionWhereInput
): Promise<FilteredTotals> {
	const [income, expense] = await Promise.all([
		prisma.transaction.aggregate({
			where: { AND: [where, transactionKindWhere('income')] },
			_sum: { amountCents: true }
		}),
		prisma.transaction.aggregate({
			where: { AND: [where, transactionKindWhere('expense')] },
			_sum: { amountCents: true }
		})
	]);

	return {
		incomeCents: Math.abs(income._sum.amountCents ?? 0),
		expenseCents: Math.abs(expense._sum.amountCents ?? 0)
	};
}

/**
 * In-memory counterpart, for the `?q=` path where matching happens in JS and the rows are already
 * loaded. The two must agree; totals.spec.ts pins them against the same fixture.
 */
export function sumFilteredTotals(
	rows: Array<{ amountCents: number; type: string | null }>
): FilteredTotals {
	let incomeCents = 0;
	let expenseCents = 0;
	for (const row of rows) {
		if (resolveTransactionType(row) === 'income') incomeCents += Math.abs(row.amountCents);
		else expenseCents += Math.abs(row.amountCents);
	}
	return { incomeCents, expenseCents };
}
