import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { actions } from '../../../routes/categories/+page.server';
import { applyCategoryRules } from '$lib/server/categorization/rules';
import {
	readMonthlyBudgets,
	readCurrentMonthSpending,
	spentCentsFor
} from '$lib/server/budget/dashboard';

/**
 * Renaming a category must move every stored reference to its name, or `/budgets` states a false
 * figure.
 *
 * MEASURED before the fix, through this same action: renaming "Loisirs" to "Sorties" left
 * `MonthlyBudget.categoryName` at "Loisirs", and the budget's spent went **5000 cents -> 0** while
 * the spending itself never moved. The assertion below is that figure, not a proxy for it — a test
 * that only checked the columns would go green on a fix that repointed them and still broke the
 * read, which is the thing the user actually sees.
 *
 * This needs a REAL engine on all three providers because it is a multi-table write inside one
 * transaction, and rollback semantics on a mid-transaction constraint violation are exactly what
 * the providers disagree about (`CLAUDE.md`: a caught unique violation aborts the enclosing
 * transaction on some engines and not others). A mocked Prisma would be asserting against the
 * mock's chosen behaviour.
 */

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

const SPENT_CENTS = 5_000;

let userId: string;
let categoryId: string;
let locals: { user: { id: string; email: string; role: string } };

/** Drives the real form action exactly as the browser does. */
async function rename(id: string, newName: string) {
	const formData = new FormData();
	formData.set('id', id);
	formData.set('newName', newName);
	return actions.renameCategory({
		locals,
		request: new Request('http://localhost/categories?/renameCategory', {
			method: 'POST',
			body: formData
		})
	} as never);
}

async function readReferences(): Promise<Record<string, string[]>> {
	const [budgets, mappings, categoryRules, categorizationRules, manual] = await Promise.all([
		prisma.monthlyBudget.findMany({ where: { userId }, select: { categoryName: true } }),
		prisma.categoryNatureMapping.findMany({ where: { userId }, select: { categoryName: true } }),
		prisma.categoryRule.findMany({ where: { userId }, select: { targetCategory: true } }),
		prisma.categorizationRule.findMany({ where: { userId }, select: { targetCategory: true } }),
		prisma.transaction.findMany({
			where: { userId, manualCategory: { not: null } },
			select: { manualCategory: true }
		})
	]);
	return {
		'MonthlyBudget.categoryName': budgets.map((row) => row.categoryName),
		'CategoryNatureMapping.categoryName': mappings.map((row) => row.categoryName),
		'CategoryRule.targetCategory': categoryRules.map((row) => row.targetCategory),
		'CategorizationRule.targetCategory': categorizationRules.map((row) => row.targetCategory),
		'Transaction.manualCategory': manual.map((row) => row.manualCategory as string)
	};
}

beforeEach(async () => {
	const user = await prisma.user.create({
		data: {
			email: `refs-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
	locals = { user: { id: userId, email: 'refs@budgetpilot.invalid', role: 'USER' } };

	const account = await prisma.account.create({
		data: { userId, name: 'Compte', nameKey: computeNameKey('Compte') },
		select: { id: true }
	});
	const category = await prisma.category.create({
		data: { userId, name: 'Loisirs', nameKey: computeNameKey('Loisirs') },
		select: { id: true }
	});
	categoryId = category.id;

	await prisma.monthlyBudget.create({
		data: {
			userId,
			categoryName: 'Loisirs',
			categoryNameKey: computeNameKey('Loisirs'),
			amountCents: 20_000
		}
	});
	await prisma.categoryNatureMapping.create({
		data: {
			userId,
			categoryName: 'Loisirs',
			categoryNameKey: computeNameKey('Loisirs'),
			nature: 'spending'
		}
	});
	// Stored in a DIFFERENT case from the category, on purpose: these two tables have no fold key,
	// so a rename that matched on raw text would leave them behind and this fixture is what proves
	// the JS fold is doing the work.
	await prisma.categoryRule.create({
		data: { userId, name: 'Cinema', matchText: 'CINEMA', targetCategory: 'loisirs' }
	});
	await prisma.categorizationRule.create({
		data: { userId, pattern: 'CINEMA', targetCategory: 'LOISIRS' }
	});

	// Spending in the CURRENT month: readCurrentMonthSpending reads the wall clock.
	const now = new Date();
	await prisma.transaction.create({
		data: {
			userId,
			accountId: account.id,
			categoryId: category.id,
			date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)),
			label: 'CINEMA PATHE',
			amountCents: -SPENT_CENTS,
			type: 'expense',
			source: 'manual',
			manualCategory: 'Loisirs',
			manualCategoryKey: computeNameKey('Loisirs')
		}
	});
});

describe('renaming a category', () => {
	it('keeps the budget tracking the same spending (the 5000 -> 0 regression)', async () => {
		const budgetsBefore = await readMonthlyBudgets(userId);
		const spentBefore = spentCentsFor(
			await readCurrentMonthSpending(userId),
			budgetsBefore[0].categoryName
		);
		expect(spentBefore, 'the fixture must start with real spending, or 0 -> 0 proves nothing').toBe(
			SPENT_CENTS
		);

		await expect(rename(categoryId, 'Sorties')).resolves.toMatchObject({
			success: expect.anything()
		});

		// The FIGURE first, then the mechanism. The user sees the number, not the column, and a
		// column assertion that fires first would hide which of the two this test is really about.
		const budgetsAfter = await readMonthlyBudgets(userId);
		expect(
			spentCentsFor(await readCurrentMonthSpending(userId), budgetsAfter[0].categoryName),
			'the budget stopped tracking its own spending'
		).toBe(SPENT_CENTS);
		expect(budgetsAfter[0].categoryName).toBe('Sorties');
	});

	it('moves every stored reference, whatever case it was written in', async () => {
		await rename(categoryId, 'Sorties');

		const references = await readReferences();
		for (const [column, values] of Object.entries(references)) {
			expect(values, `${column} did not follow the rename`).toEqual(['Sorties']);
		}
	});

	it('leaves the rules unable to resurrect the old name', async () => {
		await rename(categoryId, 'Sorties');

		// A transaction the rule matches, with no manual category, so applyCategoryRules will pin
		// one. Before the fix it pinned "loisirs" — a name no Category row holds.
		const account = await prisma.account.findFirstOrThrow({
			where: { userId },
			select: { id: true }
		});
		const fresh = await prisma.transaction.create({
			data: {
				userId,
				accountId: account.id,
				categoryId,
				date: new Date(),
				label: 'CINEMA UGC',
				amountCents: -1_200,
				type: 'expense',
				source: 'manual'
			},
			select: { id: true }
		});

		await applyCategoryRules(userId, { transactionIds: [fresh.id] });

		const after = await prisma.transaction.findUniqueOrThrow({
			where: { id: fresh.id },
			select: { manualCategory: true }
		});
		expect(after.manualCategory).toBe('Sorties');
	});

	it('writes nothing at all when the new name collides', async () => {
		await prisma.category.create({
			data: { userId, name: 'Sorties', nameKey: computeNameKey('Sorties') }
		});
		const before = await readReferences();

		const result = await rename(categoryId, 'Sorties');
		expect(result, 'the collision guard must still refuse').toMatchObject({ status: 400 });

		// The two guards compose: the #149 collision check still refuses, AND nothing is
		// half-written. What this proves is that the refusal happens BEFORE the transaction opens —
		// the unique constraint on Category.nameKey is the backstop for the race the pre-check
		// cannot see, and its rollback is why the five updates had to move inside one transaction
		// rather than run as five statements after it.
		expect(await readReferences()).toEqual(before);
		const category = await prisma.category.findUniqueOrThrow({
			where: { id: categoryId },
			select: { name: true }
		});
		expect(category.name).toBe('Loisirs');
	});
});
