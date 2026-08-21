import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '$lib/server/db';
import { load } from '../../../routes/transactions/+page.server';

/**
 * Paging over TIED DATES must return each row exactly once.
 *
 * `date` is not a total order on this table — a bank import routinely lands a whole day's
 * transactions on one date — and the list is read with `skip`/`take`, one query per page. Without a
 * tiebreak the engine may order tied rows differently between two of those queries, so a row can
 * land on both adjacent pages or on neither. The "neither" case is the one that matters: a user
 * paginating simply never sees a transaction they own, and nothing reports it.
 *
 * This needs a REAL engine. The ordering of ties is the engine's choice, not the ORM's, so a
 * fixture-injected unit test would be asserting against a mock's chosen order — the exact shape
 * CLAUDE.md records under "Unit tests cannot see a wrong SQL predicate".
 *
 * MEASURED, and the measurement is why the fixture looks the way it does. With the tiebreak removed
 * on purpose, this test PASSED on SQLite and PASSED on PostgreSQL with a static 60-row fixture —
 * both engines happened to return a stable order, so the defect was present and invisible. It only
 * reproduces once a WRITE lands between two page reads: on PostgreSQL an UPDATE writes a new tuple
 * at the end of the heap, the tie-only sort falls back on physical order, and
 * `paging-fixture-0011` came back on two pages — meaning another row came back on none.
 *
 * That write is not a contrivance to force a failure; it is the page's own workflow. A user works
 * down the list categorising rows, and every save is an update landing between their clicks on
 * "next". A fixture without it is the one that is unrealistic.
 *
 * Deliberately its own file rather than a case in scope.db-smoke.ts: that suite gives every row a
 * DISTINCT date on purpose, to hold this variable still while it measures something else. Adding
 * ties there would make its page walk depend on the very property under test here.
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

// 3 pages at PAGE_SIZE 25, so the walk crosses two page boundaries rather than one.
const ROW_COUNT = 60;
/** Every row on ONE date: the worst case, and an ordinary one after a single-day bank import. */
const TIED_DATE = new Date('2026-03-04T00:00:00.000Z');

let userId: string;

beforeAll(async () => {
	const user = await prisma.user.create({
		data: {
			email: `paging-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
	const account = await prisma.account.create({
		data: { ...DEFAULT_DENOMINATION, userId, name: 'Paging smoke account' },
		select: { id: true }
	});
	const category = await prisma.category.create({
		data: { userId, name: 'Paging smoke category' },
		select: { id: true }
	});
	// Deterministic ids collide on a reused database; the refusal guards demand a throwaway, but a
	// unique-violation would read as an engine problem rather than "you reused the database".
	await prisma.transaction.deleteMany({ where: { id: { startsWith: 'paging-fixture-' } } });
	await prisma.transaction.createMany({
		data: Array.from({ length: ROW_COUNT }, (_, index) => ({
			...DEFAULT_DENOMINATION,
			id: `paging-fixture-${String(index).padStart(4, '0')}`,
			userId,
			accountId: account.id,
			categoryId: category.id,
			date: TIED_DATE,
			label: `Tied row ${index}`,
			amountCents: 1_000 + index,
			type: 'expense',
			source: 'csv'
		}))
	});
}, 60_000);

describe('paging over tied dates', () => {
	it('returns every row exactly once across the page boundaries', async () => {
		const event = (page: number) =>
			({
				locals: { user: { id: userId, email: 'paging@budgetpilot.invalid', role: 'USER' } },
				url: new URL(`http://localhost/transactions?page=${page}`)
			}) as never;

		const first = (await load(event(1))) as {
			transactions: Array<{ id: string }>;
			pagination: { totalPages: number; totalTransactions: number };
		};
		expect(first.pagination.totalTransactions).toBe(ROW_COUNT);
		// The boundary crossing is the point; one page would prove nothing.
		expect(first.pagination.totalPages).toBeGreaterThan(2);

		const seen: string[] = [...first.transactions.map((row) => row.id)];
		for (let page = 2; page <= first.pagination.totalPages; page++) {
			// A write BETWEEN two page reads, because that is what this page is for: the user works
			// down the list categorising rows, and each save is an update landing between their
			// clicks on "next". On PostgreSQL an UPDATE writes a new tuple at the end of the heap, so
			// the physical order a tie-only sort falls back on genuinely changes mid-walk. Without
			// this the fixture is too small and too static for any engine to reorder anything, and
			// the test passes with the defect present — measured on both SQLite and PostgreSQL.
			await prisma.transaction.update({
				where: { id: `paging-fixture-${String((page - 2) * 3).padStart(4, '0')}` },
				data: { manualCategory: `touched-${page}` }
			});
			const next = (await load(event(page))) as { transactions: Array<{ id: string }> };
			seen.push(...next.transactions.map((row) => row.id));
		}

		// Asserted as three separate claims, because they fail differently and a single
		// set-equality check would hide which one broke.
		const duplicates = seen.filter((id, index) => seen.indexOf(id) !== index);
		expect(duplicates, 'a row appeared on more than one page').toEqual([]);

		const missing = Array.from(
			{ length: ROW_COUNT },
			(_, index) => `paging-fixture-${String(index).padStart(4, '0')}`
		).filter((id) => !seen.includes(id));
		expect(missing, 'a row the user owns appeared on NO page').toEqual([]);

		expect(seen).toHaveLength(ROW_COUNT);
	});
});
