import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '$lib/server/db';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { actions } from '../../../routes/categories/+page.server';
import { DEFAULT_CATEGORIES } from './defaults';
import { planDefaultCategoryRenames } from './renamePrompt';

/**
 * #162's rename prompt, driven through the real form action against a real engine.
 *
 * The unit spec beside this proves which rows the plan SELECTS. It cannot prove the part that
 * costs money: a bulk rename moves twelve categories and, for each, the five columns that
 * reference it by text, all inside one transaction. That is a multi-table write whose rollback
 * behaviour on a mid-transaction constraint violation is exactly what the three engines disagree
 * about, and a mocked Prisma would assert against the mock's chosen behaviour rather than the
 * engine's.
 *
 * The figure that matters is the one #157 fixed: a rename that moved the category and not its
 * budget took `/budgets` from 5000 cents spent to 0 on unchanged spending. Twelve renames at once
 * is twelve chances to reproduce it.
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

let userId: string;
let locals: { user: { id: string; email: string; role: string } };

/** Drives the real form action exactly as the browser does. */
async function adopt() {
	return actions.adoptDefaultNames({
		locals,
		request: new Request('http://localhost/categories?/adoptDefaultNames', { method: 'POST' })
	} as never);
}

async function dismiss() {
	return actions.dismissRenamePrompt({
		locals,
		request: new Request('http://localhost/categories?/dismissRenamePrompt', { method: 'POST' })
	} as never);
}

async function categoryNames(): Promise<string[]> {
	const rows = await prisma.category.findMany({ where: { userId }, select: { name: true } });
	return rows.map((row) => row.name).sort();
}

/** Every stored reference to a category name, flattened, so a straggler is visible by value. */
async function referenceNames(): Promise<string[]> {
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
	return [
		...budgets.map((row) => row.categoryName),
		...mappings.map((row) => row.categoryName),
		...categoryRules.map((row) => row.targetCategory),
		...categorizationRules.map((row) => row.targetCategory),
		...manual.map((row) => row.manualCategory as string)
	].sort();
}

beforeEach(async () => {
	overwriteGetLocale(() => 'en');

	const user = await prisma.user.create({
		data: {
			email: `prompt-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
	locals = { user: { id: userId, email: 'prompt@budgetpilot.invalid', role: 'USER' } };

	const account = await prisma.account.create({
		data: { ...DEFAULT_DENOMINATION, userId, name: 'Compte', nameKey: computeNameKey('Compte') },
		select: { id: true }
	});

	// The fourteen seeded rows, written the way the seeder writes them.
	await prisma.category.createMany({
		data: DEFAULT_CATEGORIES.map((entry) => ({
			userId,
			name: entry.name,
			nameKey: computeNameKey(entry.name)
		}))
	});

	// One reference of each kind, all pointing at "Alimentation", and the two keyless rule tables
	// hold it in a DIFFERENT case on purpose: they are matched by folding in JS, so a rename that
	// compared raw text would leave them behind and this fixture is what proves it does not.
	await prisma.monthlyBudget.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			categoryName: 'Alimentation',
			categoryNameKey: computeNameKey('Alimentation'),
			amountCents: 20_000
		}
	});
	await prisma.categoryNatureMapping.create({
		data: {
			userId,
			categoryName: 'Alimentation',
			categoryNameKey: computeNameKey('Alimentation'),
			nature: 'spending'
		}
	});
	await prisma.categoryRule.create({
		data: { userId, name: 'Super', matchText: 'SUPERMARCHE', targetCategory: 'alimentation' }
	});
	await prisma.categorizationRule.create({
		data: { userId, pattern: 'CARREFOUR', targetCategory: 'ALIMENTATION' }
	});
	const food = await prisma.category.findFirstOrThrow({
		where: { userId, name: 'Alimentation' },
		select: { id: true }
	});
	await prisma.transaction.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			accountId: account.id,
			categoryId: food.id,
			date: new Date('2026-05-04T00:00:00.000Z'),
			label: 'CARREFOUR',
			amountCents: -5_000,
			source: 'manual',
			manualCategory: 'Alimentation',
			manualCategoryKey: computeNameKey('Alimentation')
		}
	});
});

afterEach(async () => {
	overwriteGetLocale(() => 'fr');
	await prisma.transaction.deleteMany({ where: { userId } });
	await prisma.user.deleteMany({ where: { id: userId } });
});

describe('adoptDefaultNames', () => {
	it('renames every seeded category the locale would render differently', async () => {
		expect.assertions(3);

		const before = await categoryNames();
		expect(before).toContain('Alimentation');

		await adopt();

		const after = await categoryNames();
		expect(after).toContain('Groceries');
		// "Transport" is spelled the same in both catalogues, so it must NOT have been touched. The
		// assertion is on the row surviving, which is what distinguishes "left alone" from "renamed
		// to itself and something went wrong on the way".
		expect(after).toContain('Transport');
	});

	it('CARRIES EVERY REFERENCE WITH IT, which is the figure #157 was about', async () => {
		expect.assertions(2);

		await adopt();

		// Five references, all folded onto the same category, all now reading the new name. Asserted
		// by VALUE rather than by counting rows: a count goes green on a rename that moved the
		// columns to the wrong string, and the wrong string is what silently zeroes a budget.
		const references = await referenceNames();
		expect(references).toEqual(['Groceries', 'Groceries', 'Groceries', 'Groceries', 'Groceries']);
		expect(references).not.toContain('Alimentation');
	});

	it('is REVERSIBLE: renaming back by hand restores every reference', async () => {
		expect.assertions(3);

		await adopt();
		expect(await referenceNames()).not.toContain('Alimentation');

		// The single-category rename the user already had, driven the same way. Reversibility is
		// what makes the prompt safe to accept: it is an ordinary rename of ordinary rows, not a
		// one-way migration, and nothing about the fourteen makes them special afterwards.
		const groceries = await prisma.category.findFirstOrThrow({
			where: { userId, name: 'Groceries' },
			select: { id: true }
		});
		const formData = new FormData();
		formData.set('id', groceries.id);
		formData.set('newName', 'Alimentation');
		await actions.renameCategory({
			locals,
			request: new Request('http://localhost/categories?/renameCategory', {
				method: 'POST',
				body: formData
			})
		} as never);

		const references = await referenceNames();
		expect(references).toEqual([
			'Alimentation',
			'Alimentation',
			'Alimentation',
			'Alimentation',
			'Alimentation'
		]);
		expect(await categoryNames()).toContain('Alimentation');
	});

	it('is idempotent: a replayed submission finds nothing to do', async () => {
		expect.assertions(2);

		await adopt();
		const afterFirst = await categoryNames();

		// The plan is recomputed from the database, so a second POST from a stale page cannot
		// rename anything twice. It refuses rather than silently succeeding, which is what tells a
		// user pressing the button again that their first press worked.
		const second = await adopt();
		expect((second as { status?: number }).status).toBe(400);
		expect(await categoryNames()).toEqual(afterFirst);
	});

	it('skips a proposal whose name the user already owns, and renames the rest', async () => {
		expect.assertions(3);

		await prisma.category.create({
			data: { userId, name: 'Groceries', nameKey: computeNameKey('Groceries') }
		});

		await adopt();

		const after = await categoryNames();
		// "Alimentation" stays, because "Groceries" is taken. Everything else still moved: a
		// collision on one row must not hold the other eleven hostage.
		expect(after).toContain('Alimentation');
		expect(after).toContain('Travel');
		// And its references stayed with it rather than being repointed at a category that is not
		// the one they belong to. THREE distinct spellings, which is the fixture as seeded: the two
		// keyless rule tables hold "alimentation" and "ALIMENTATION" on purpose. That is the
		// contrast with the renamed case above, where all five collapse to one string, and it is
		// worth asserting rather than normalising away: a rename REWRITES every reference to the
		// new name exactly, so the case spread surviving is the proof nothing here was rewritten.
		expect(await referenceNames()).toEqual([
			'ALIMENTATION',
			'Alimentation',
			'Alimentation',
			'Alimentation',
			'alimentation'
		]);
	});
});

describe('dismissRenamePrompt', () => {
	it('records the refusal without touching a single category', async () => {
		expect.assertions(3);

		const before = await categoryNames();
		await dismiss();

		const user = await prisma.user.findUniqueOrThrow({
			where: { id: userId },
			select: { categoryRenamePromptDismissedAt: true }
		});
		expect(user.categoryRenamePromptDismissedAt).toBeInstanceOf(Date);
		expect(await categoryNames()).toEqual(before);

		// The plan itself is UNCHANGED by dismissing, which is the split the schema docstring
		// describes: the offer is still what it was, and only the load's last line decides not to
		// show it. Asserting here rather than trusting the docstring, because the alternative
		// design (freezing the plan) reads identically from outside until the user switches locale.
		expect(
			planDefaultCategoryRenames(await prisma.category.findMany({ where: { userId } })).proposals
				.length
		).toBeGreaterThan(0);
	});
});
