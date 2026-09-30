import { beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '$lib/server/db';
import * as m from '$lib/paraglide/messages';
import { createSavingsGoal } from '$lib/server/savings-goals/service';
import { createNetWorthAccount } from '$lib/server/net-worth/service';
import { recordStreamAction } from '$lib/server/upcoming-bills/service';
import { resolveImportBucketAccount } from '$lib/server/import/persist';
import { resolveCategoryByName } from '$lib/server/categories/resolve';
import { reportDatesOutsideStorableRange } from '$lib/server/database/storableDatesBoot';
import { parseDateRange } from '$lib/server/date-range';
import { readDashboardDataForRange } from '$lib/server/budget/dashboard';

/**
 * #758's second half, on a real engine: the writers outside the import path, and the rows an
 * install already holds.
 *
 * ## Writers
 *
 * A savings goal's deadline, a net worth « à la date du » and an upcoming bill's due date parsed
 * their own dates and accepted any four-digit year: year 0000 reached PostgreSQL (`22008`, a 500)
 * and 0001 to 0099 were stored for MariaDB to read back in the wrong century. Each is now refused
 * before any write, and the first storable day is stored and read back as written, which is the
 * control that the refusal is about the year. The due date's accepted case needs a detected stream
 * to anchor on, so only its refusal is asserted here; `storableDateColumns.spec.ts` probes both.
 *
 * ## The boot report over a row written before the range existed
 *
 * The row is PLANTED through Prisma, the way a pre-#758 writer stored it, then the report runs.
 * Its count for the column must move by exactly one (the starting value is read first, so rows
 * other files left in this database cannot satisfy it), and the row must be byte-for-byte the same
 * afterwards, read as the engine's own text, because the report must never write.
 *
 * Breaks: `isStorableIsoDate` removed from a writer reddens its « refuses » test (on PostgreSQL by
 * `22008`, elsewhere by the row being stored); the report's `lt` bound moved to the epoch keeps the
 * delta at 1 here, so the bound is owned by `storableDatesBoot.spec.ts`; a write added to the report
 * reddens « unchanged ».
 */

let userId = '';

beforeAll(async () => {
	const user = await prisma.user.create({
		data: {
			email: `writers758-${Date.now()}-${Math.floor(performance.now())}@example.test`,
			passwordHash: 'x',
			role: 'USER'
		}
	});
	userId = user.id;
});

async function rawDate(table: string, column: string, id: string): Promise<string> {
	const provider = process.env.DATABASE_PROVIDER;
	const sql =
		provider === 'postgresql'
			? `SELECT "${column}"::text AS v FROM "${table}" WHERE id = $1`
			: provider === 'mysql'
				? `SELECT CAST(\`${column}\` AS CHAR) AS v FROM \`${table}\` WHERE id = ?`
				: `SELECT CAST("${column}" AS TEXT) AS v FROM "${table}" WHERE id = ?`;
	const rows = (await prisma.$queryRawUnsafe(sql, id)) as Array<{ v: string }>;
	return rows[0]?.v ?? '<no row>';
}

/** The refusal's status and its sentence: a test on a refusal asserts the REASON (AGENTS.md). */
function refusalOf(caught: unknown): { status: number | null; message: string | null } {
	const error = caught as { status?: number; body?: { message?: string } } | null;
	return { status: error?.status ?? null, message: error?.body?.message ?? null };
}

describe(`#758 writers on ${process.env.DATABASE_PROVIDER ?? 'the configured engine'}`, () => {
	it('refuses a savings goal deadline in year 0026 with a 400 and stores nothing', async () => {
		expect.assertions(2);
		const before = await prisma.savingsGoal.count({ where: { userId } });
		const caught = await createSavingsGoal(userId, {
			name: 'Objectif 0026',
			targetAmount: '100',
			trackingMode: 'manual',
			targetDate: '0026-05-01'
		}).catch((error: unknown) => error);
		expect(refusalOf(caught)).toEqual({
			status: 400,
			message: m.savings_goal_error_invalid_date()
		});
		expect(await prisma.savingsGoal.count({ where: { userId } })).toBe(before);
	});

	it('stores a savings goal deadline on the first storable day as written', async () => {
		expect.assertions(1);
		const { id } = await createSavingsGoal(userId, {
			name: 'Objectif 1000',
			targetAmount: '100',
			trackingMode: 'manual',
			targetDate: '1000-01-01'
		});
		expect(await rawDate('SavingsGoal', 'targetDate', id)).toMatch(/^1000-01-01[ T]12:00:00/);
	});

	it('refuses a net worth « à la date du » in year 0000 with a 400 and stores nothing', async () => {
		expect.assertions(2);
		const before = await prisma.netWorthSnapshot.count({ where: { userId } });
		const caught = await createNetWorthAccount(userId, {
			name: 'Compte 0000',
			type: 'savings',
			balance: '10',
			asOfDate: '0000-01-16'
		}).catch((error: unknown) => error);
		expect(refusalOf(caught)).toEqual({ status: 400, message: m.net_worth_error_invalid_date() });
		expect(await prisma.netWorthSnapshot.count({ where: { userId } })).toBe(before);
	});

	it('stores a net worth snapshot on the first storable day as written', async () => {
		expect.assertions(1);
		const { id } = await createNetWorthAccount(userId, {
			name: 'Compte 1000',
			type: 'savings',
			balance: '10',
			asOfDate: '1000-01-01'
		});
		const snapshot = await prisma.netWorthSnapshot.findFirstOrThrow({
			where: { userId, accountId: id },
			select: { id: true }
		});
		expect(await rawDate('NetWorthSnapshot', 'capturedAt', snapshot.id)).toMatch(
			/^1000-01-01[ T]12:00:00/
		);
	});

	it('refuses an upcoming bill due date in year 0026 with a 400 and stores nothing', async () => {
		expect.assertions(2);
		const before = await prisma.recurringStreamAction.count({ where: { userId } });
		const caught = await recordStreamAction(userId, {
			kind: 'paid',
			direction: 'expense',
			label: 'ABONNEMENT',
			dueDate: '0026-05-01',
			anchorTransactionIds: ['anchor-758']
		}).catch((error: unknown) => error);
		// The REASON, and it is load-bearing here: the anchor below resolves to nothing, so without
		// the date check the call still answers 400, for the stream. Measured by the break that
		// removed the check: status-only, this test stayed green on all three engines.
		expect(refusalOf(caught)).toEqual({
			status: 400,
			message: m.upcoming_bills_error_invalid_date()
		});
		expect(await prisma.recurringStreamAction.count({ where: { userId } })).toBe(before);
	});
});

describe(`#758 boot report on ${process.env.DATABASE_PROVIDER ?? 'the configured engine'}`, () => {
	let plantedId = '';
	let rawBefore = '';
	let countBefore = -1;
	let countAfter = -1;
	let rawAfter = '';

	beforeAll(async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			countBefore = (await reportDatesOutsideStorableRange())?.['Transaction.date'] ?? -1;
			const { accountId } = await resolveImportBucketAccount({
				userId,
				name: `report758-${Date.now()}`,
				source: 'csv'
			});
			const category = await resolveCategoryByName(userId, 'Alimentation');
			const planted = await prisma.transaction.create({
				data: {
					userId,
					accountId,
					categoryId: category.id,
					date: new Date('0026-05-01T00:00:00.000Z'),
					label: 'PLANTED 0026',
					amountCents: 100,
					type: 'expense',
					source: 'csv',
					currency: 'EUR',
					exponent: 2
				},
				select: { id: true }
			});
			plantedId = planted.id;
			rawBefore = await rawDate('Transaction', 'date', plantedId);
			countAfter = (await reportDatesOutsideStorableRange())?.['Transaction.date'] ?? -1;
			rawAfter = await rawDate('Transaction', 'date', plantedId);
		} finally {
			warn.mockRestore();
		}
	});

	it('counts the planted row: the Transaction.date count moves by exactly one', () => {
		expect.assertions(2);
		// The starting value, printed rather than assumed: another file's rows may sit here.
		expect(countBefore).toBeGreaterThanOrEqual(0);
		expect(countAfter - countBefore).toBe(1);
	});

	it('leaves the planted row exactly as it was', () => {
		expect.assertions(2);
		expect(rawBefore).toMatch(/^0026-05-01/);
		expect(rawAfter).toBe(rawBefore);
	});
});

/**
 * #758's two bounds a query builds, read through `readDashboardDataForRange`, the reader the
 * dashboard and the reports call.
 *
 * - « Toujours » floored at the epoch dropped a 1969 row from every all-time total, silently.
 * - A custom period ending on the last storable day built the exclusive bound `10000-01-01`, which
 *   MariaDB turns into warning 1292 and ZERO rows, so the whole period read empty with no error.
 *   SQLite read zero rows too (measured by the break below): it compares the stored text, and
 *   `+010000-...` sorts before every four-digit year. PostgreSQL alone answered correctly.
 *
 * Separates « both rows counted » from each failure. Breaks: the floor back at `new Date(0)`
 * reddens the first test; the upper bound built as `to + 1 day` reddens the second on MariaDB and
 * SQLite.
 */
describe(`#758 period bounds on ${process.env.DATABASE_PROVIDER ?? 'the configured engine'}`, () => {
	let rangeUser = '';

	beforeAll(async () => {
		const user = await prisma.user.create({
			data: {
				email: `range758-${Date.now()}-${Math.floor(performance.now())}@example.test`,
				passwordHash: 'x',
				role: 'USER'
			}
		});
		rangeUser = user.id;
		const { accountId } = await resolveImportBucketAccount({
			userId: rangeUser,
			name: `range758-${Date.now()}`,
			source: 'csv'
		});
		const category = await resolveCategoryByName(rangeUser, 'Alimentation');
		for (const [date, label] of [
			['1969-06-01', 'AVANT 1970'],
			['9999-12-31', 'DERNIER JOUR']
		]) {
			await prisma.transaction.create({
				data: {
					userId: rangeUser,
					accountId,
					categoryId: category.id,
					date: new Date(`${date}T00:00:00.000Z`),
					label,
					amountCents: 100,
					type: 'expense',
					source: 'csv',
					currency: 'EUR',
					exponent: 2
				}
			});
		}
	});

	it('« Toujours » counts a row dated 1969', async () => {
		expect.assertions(1);
		const range = parseDateRange(new URLSearchParams('period=all-time'));
		const data = await readDashboardDataForRange(rangeUser, range);
		expect(data.transactions.map((transaction) => transaction.label)).toContain('AVANT 1970');
	});

	it('a custom period ending on the last storable day returns both rows', async () => {
		expect.assertions(1);
		const range = parseDateRange(
			new URLSearchParams('period=custom&from=1000-01-01&to=9999-12-31')
		);
		const data = await readDashboardDataForRange(rangeUser, range);
		expect(data.transactions.map((transaction) => transaction.label).sort()).toEqual([
			'AVANT 1970',
			'DERNIER JOUR'
		]);
	});
});
