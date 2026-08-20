import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';
import * as m from '$lib/paraglide/messages';
import { actions, load } from '../../../routes/categories/+page.server';

/**
 * `/categories` counts a category's transactions, and the delete dialog and its success message
 * both speak from that count. The count read `Category._count.transactions`, which is
 * `Transaction.categoryId` alone — while the EFFECTIVE category is
 * `manualCategory ?? category.name` (see `getEffectiveCategory`), and `manualCategory` is what
 * every categorisation rule writes and what every hand classification writes.
 *
 * So the screen under-reported, and the delete destroyed exactly what it had not counted: the same
 * transaction clears `Transaction.manualCategoryKey` in its own `updateMany`, three lines below the
 * count that ignores it.
 *
 * MEASURED through the real screen before the fix: the page read
 * « Factures & énergie — 0 transactions », the delete returned « Catégorie supprimée. » (the
 * no-transactions variant), and ELEVEN categorisations were destroyed — the effective count went
 * 11 -> 0, uncategorised 12 -> 13, and a neighbouring category 11 -> 21. Nothing on screen said so.
 *
 * A real engine rather than a mocked Prisma, and on all three providers: the fix reads the count
 * through two `groupBy` queries joined on `computeNameKey`'s folded key, and folding is precisely
 * what the three engines disagree about when a comparison is left to SQL (CLAUDE.md). A mocked
 * Prisma would be asserting against the mock's chosen grouping semantics.
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
let accountId: string;
let locals: { user: { id: string; email: string; role: string } };
let facturesId: string;
let loisirsId: string;
let unclassifiedId: string;

/** Drives the real form action exactly as the browser does. */
async function remove(id: string) {
	const formData = new FormData();
	formData.set('id', id);
	return actions.deleteCategory({
		locals,
		request: new Request('http://localhost/categories?/deleteCategory', {
			method: 'POST',
			body: formData
		})
	} as never);
}

/** Drives the real `load`, so the assertion is about what the screen is handed. */
async function countOf(name: string): Promise<number> {
	const data = (await load({ locals } as never)) as {
		categories: { name: string; transactionCount: number }[];
	};
	return data.categories.find((row) => row.name === name)?.transactionCount ?? -1;
}

/**
 * `Transaction.categoryId` is NOT NULL in the schema, so every row always points at some category
 * — which is exactly why the old count read as plausible and was wrong. A rule-categorised
 * transaction still points at « Non catégorisé » (or at whatever the import assigned) and carries
 * its real category in `manualCategory`, invisible to `Category._count.transactions`.
 */
async function makeTransaction(fields: {
	label: string;
	categoryId: string;
	manualCategory?: string | null;
}) {
	await prisma.transaction.create({
		data: {
			userId,
			accountId,
			date: new Date('2026-06-15T00:00:00.000Z'),
			label: fields.label,
			amountCents: -1_000,
			type: 'expense',
			source: 'csv',
			categoryId: fields.categoryId,
			...manualCategoryUpdate(fields.manualCategory ?? null)
		}
	});
}

beforeEach(async () => {
	const user = await prisma.user.create({
		data: {
			email: `effcount-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
	locals = { user: { id: userId, email: 'eff@budgetpilot.invalid', role: 'USER' } };

	const account = await prisma.account.create({
		data: { userId, name: 'Compte', nameKey: computeNameKey('Compte') },
		select: { id: true }
	});
	accountId = account.id;

	const [factures, loisirs, unclassified] = await Promise.all([
		prisma.category.create({
			data: { userId, name: 'Factures', nameKey: computeNameKey('Factures') },
			select: { id: true }
		}),
		prisma.category.create({
			data: { userId, name: 'Loisirs', nameKey: computeNameKey('Loisirs') },
			select: { id: true }
		}),
		prisma.category.create({
			data: {
				userId,
				name: UNCLASSIFIED_CATEGORY,
				nameKey: computeNameKey(UNCLASSIFIED_CATEGORY)
			},
			select: { id: true }
		})
	]);
	facturesId = factures.id;
	loisirsId = loisirs.id;
	unclassifiedId = unclassified.id;
});

describe('/categories — the count is the EFFECTIVE category, not categoryId alone', () => {
	it('counts a transaction a rule categorised, which never touches categoryId', async () => {
		expect.assertions(2);

		// Calibration first: a plain `categoryId` transaction is counted, so a wrong figure below is
		// evidence about `manualCategory` and not about the harness or the fixture.
		await makeTransaction({ label: 'EDF', categoryId: facturesId });
		expect(await countOf('Factures')).toBe(1);

		// What a rule actually writes: `manualCategory`, on a transaction whose `categoryId` points
		// somewhere else entirely.
		await makeTransaction({ label: 'ORANGE', categoryId: loisirsId, manualCategory: 'Factures' });
		expect(await countOf('Factures')).toBe(2);
	});

	it('does not count a transaction whose hand-set category points elsewhere', async () => {
		expect.assertions(1);

		// `manualCategory` WINS over `categoryId` — so this row is Loisirs, not Factures, and a naive
		// OR that forgot the precedence would count it twice over.
		await makeTransaction({ label: 'CINEMA', categoryId: facturesId, manualCategory: 'Loisirs' });

		expect(await countOf('Factures')).toBe(0);
	});

	it('folds the key, so a rule that wrote a differently-cased name still counts', async () => {
		expect.assertions(1);

		await makeTransaction({ label: 'EDF', categoryId: unclassifiedId, manualCategory: 'factures' });

		expect(await countOf('Factures')).toBe(1);
	});
});

describe('/categories — deleting says what it destroyed', () => {
	it('reports the transactions it un-categorised, not only the ones it repointed', async () => {
		expect.assertions(3);

		// Every one of these is invisible to `categoryId`, which is the audited case: the page said
		// 0 and eleven categorisations went.
		await makeTransaction({ label: 'EDF', categoryId: unclassifiedId, manualCategory: 'Factures' });
		await makeTransaction({ label: 'ORANGE', categoryId: loisirsId, manualCategory: 'Factures' });

		const result = (await remove(facturesId)) as { success: string };

		expect(result.success).toBe(m.categories_success_deleted_detached({ count: 2 }));
		expect(result.success).not.toBe(m.categories_success_deleted());

		// And the destruction the message is now honest about really happened.
		const stillPinned = await prisma.transaction.count({
			where: { userId, manualCategoryKey: computeNameKey('Factures') }
		});
		expect(stillPinned).toBe(0);
	});

	/**
	 * Why the message names no destination. The two populations it counts do NOT land in the same
	 * place, and the previous wording ("{count} transaction(s) deplacee(s) vers Non categorise")
	 * was true for one of them and false for the other, which sent the user looking for rows that
	 * were never there.
	 */
	it('sends the inherited rows to Non categorise and the pinned rows back to their own category', async () => {
		expect.assertions(2);

		await makeTransaction({ label: 'EDF', categoryId: facturesId });
		await makeTransaction({ label: 'ORANGE', categoryId: loisirsId, manualCategory: 'Factures' });

		await remove(facturesId);

		const rows = await prisma.transaction.findMany({
			where: { userId },
			select: { label: true, category: { select: { name: true } } }
		});
		const categoryOf = new Map(rows.map((row) => [row.label, row.category?.name]));

		expect(categoryOf.get('EDF')).toBe(UNCLASSIFIED_CATEGORY);
		expect(categoryOf.get('ORANGE')).toBe('Loisirs');
	});
});
