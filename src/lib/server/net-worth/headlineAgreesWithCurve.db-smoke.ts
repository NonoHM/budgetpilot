import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNetWorthTotal } from '$lib/domain/netWorth';
import {
	createNetWorthAccount,
	deleteNetWorthAccount,
	readNetWorthAccounts,
	readNetWorthSeries,
	recordSyncedBalance,
	updateNetWorthAccount
} from './service';

/**
 * `/net-worth` puts one figure above the other: « Patrimoine net » is
 * `computeNetWorthTotal(active accounts)`, and the curve's rightmost point is
 * `buildNetWorthTimeline(every snapshot)`. Nothing made them agree, and two ordinary journeys
 * pulled them apart in opposite directions.
 *
 * MEASURED on a real screen, both at once: headline **2 400,00 €** above a curve whose present
 * point read **10 900,00 €**, on the same card, in the same render.
 *
 * 1. DELETING an account soft-deletes it and writes no closing point, while the timeline carries
 *    every account's last known balance forward at every later timestamp. So a closed account
 *    keeps contributing to « today » forever, and the curve overstates by whatever was closed.
 *
 * 2. BACKDATING a balance wrote the past value into the account's CURRENT `balanceCents` while
 *    leaving the newer snapshot in place. Header 9 200 € / curve 8 500 €, and the curve sloping
 *    DOWN after an increase. `docs/using/net-worth.md` recommends exactly this as the way to get
 *    a curve on day one, so it is the documented onboarding path rather than an edge case.
 *
 * The assertion in both cases is the INVARIANT THE USER SEES — the two figures on the card — not
 * a proxy for it. A test that only checked `deletedAt` or a snapshot row would go green on a fix
 * that stored the right thing and still rendered two disagreeing numbers.
 *
 * A real engine because the fix moves the account's balance from "what the form said" to "what the
 * newest snapshot says", which is a read-then-write ordering question inside a transaction.
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

/** The headline, read exactly as `/net-worth`'s load reads it. */
async function headlineCents(): Promise<number> {
	return computeNetWorthTotal(await readNetWorthAccounts(userId));
}

/** The curve's rightmost point — what the card shows as "now". */
async function curvePresentCents(): Promise<number> {
	const series = await readNetWorthSeries(userId);
	return series.length === 0 ? 0 : series[series.length - 1].totalCents;
}

beforeEach(async () => {
	const user = await prisma.user.create({
		data: {
			email: `nw-agree-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
});

describe('/net-worth — the headline and the curve are the same number', () => {
	it('agrees after an ordinary update, which is the calibration for the two cases below', async () => {
		expect.assertions(2);

		const { id } = await createNetWorthAccount(userId, {
			name: 'Livret A',
			type: 'savings',
			balance: '8500,00',
			asOfDate: '2026-01-31'
		});
		await updateNetWorthAccount(userId, id, {
			name: 'Livret A',
			type: 'savings',
			balance: '9200,00',
			asOfDate: '2026-02-28'
		});

		expect(await headlineCents()).toBe(920_000);
		expect(await curvePresentCents()).toBe(await headlineCents());
	});

	it('agrees after a BACKDATED balance, which must add history and not rewrite the present', async () => {
		expect.assertions(2);

		const { id } = await createNetWorthAccount(userId, {
			name: 'Livret A',
			type: 'savings',
			balance: '9200,00',
			asOfDate: '2026-02-28'
		});

		// The documented onboarding move: fill in what the account held earlier, so the curve has
		// more than one point. It says nothing about today.
		await updateNetWorthAccount(userId, id, {
			name: 'Livret A',
			type: 'savings',
			balance: '8500,00',
			asOfDate: '2026-01-31'
		});

		expect(await headlineCents()).toBe(920_000);
		expect(await curvePresentCents()).toBe(await headlineCents());
	});

	it('agrees after an account is DELETED, which must stop it contributing to today', async () => {
		expect.assertions(3);

		const kept = await createNetWorthAccount(userId, {
			name: 'Compte courant',
			type: 'checking',
			balance: '2400,00',
			asOfDate: '2026-01-31'
		});
		const closed = await createNetWorthAccount(userId, {
			name: 'Ancien PEL',
			type: 'savings',
			balance: '8500,00',
			asOfDate: '2026-02-28'
		});

		// Both accounts alive: the curve's present point is the pair. This is the calibration — it
		// proves the closed account really was contributing before the delete, so the figure after
		// it is evidence about the delete.
		expect(await curvePresentCents()).toBe(1_090_000);

		await deleteNetWorthAccount(userId, closed.id);

		expect(await headlineCents()).toBe(240_000);
		expect(await curvePresentCents()).toBe(await headlineCents());

		void kept;
	});

	/**
	 * #441. "As of today" and "no date" describe the same thing, so two saves on one day must be
	 * settled by which was written last. They were settled by NOON instead: `parseAsOfDate` pinned
	 * an explicit date to `T12:00:00.000Z`, an arbitrary instant inside the day, while every other
	 * writer stamps the real clock. Which write won was then decided by which side of noon the other
	 * one happened to land on.
	 *
	 * THE CLOCK IS PINNED, and that is not tidiness. Run at any moment after 12:00 UTC, the two
	 * behaviours agree and this test passes against the defect: an explicit save at 15:00 is later
	 * than noon either way. The first version of this test did exactly that, and was green on the
	 * broken code. Only a morning reproduces it, so the morning is supplied rather than waited for.
	 *
	 * `toFake: ['Date']` only. Faking timers wholesale would stop Prisma's own I/O from ever
	 * resolving, which reads as a hang rather than as a wrong clock.
	 */
	it('lets the later of two same-day writes win, on a morning', async () => {
		expect.assertions(3);

		const morning = new Date('2026-08-20T09:00:00.000Z');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(morning);

		try {
			const { id } = await createNetWorthAccount(userId, {
				name: 'Compte courant',
				type: 'checking',
				balance: '100,00',
				asOfDate: '2026-01-01'
			});

			// Saved "as of today" at 09:00. Under the sentinel this was stamped 12:00Z, three hours
			// into the future of the moment the user pressed the button.
			await updateNetWorthAccount(userId, id, {
				name: 'Compte courant',
				type: 'checking',
				balance: '9200,00',
				asOfDate: '2026-08-20'
			});

			// Calibration: the explicit save landed, so a wrong figure below is evidence about
			// ordering rather than about a save that never happened.
			expect(await headlineCents()).toBe(920_000);

			// A sync five minutes later, carrying what the bank says. It is newer information and
			// must win. Under the sentinel it lost to a timestamp that had not happened yet.
			await recordSyncedBalance(userId, id, 850_000, new Date('2026-08-20T09:05:00.000Z'));

			expect(await headlineCents()).toBe(850_000);
			expect(await curvePresentCents()).toBe(await headlineCents());
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * The tie-break both readers share, exercised rather than argued for. `parseAsOfDate` pins a
	 * given YYYY-MM-DD to 12:00:00Z, so correcting a backdated balance to the SAME day writes a
	 * second snapshot at the identical instant. Nothing in `capturedAt` separates them, and the two
	 * figures on the card would each be free to pick a defensible different row.
	 */
	it('agrees when two snapshots carry the identical captured instant', async () => {
		expect.assertions(3);

		const { id } = await createNetWorthAccount(userId, {
			name: 'Livret A',
			type: 'savings',
			balance: '8500,00',
			asOfDate: '2026-01-31'
		});

		// Calibration: one snapshot, no tie, and the pair already agrees.
		expect(await headlineCents()).toBe(850_000);

		// The correction, same day: `capturedAt` is byte-identical to the row above.
		await updateNetWorthAccount(userId, id, {
			name: 'Livret A',
			type: 'savings',
			balance: '8600,00',
			asOfDate: '2026-01-31'
		});

		expect(await headlineCents()).toBe(860_000);
		expect(await curvePresentCents()).toBe(await headlineCents());
	});

	/**
	 * `updateNetWorthAccount` is not the only writer of `NetWorthAccount.balanceCents`: a bank sync
	 * writes it too. An invariant enforced in "the" write path is only enforced if every path is
	 * that one (CLAUDE.md), and this one was not — the sync wrote its own figure into the account
	 * whatever the snapshots said, so an OLDER sync pushed a stale value into the headline while
	 * the curve, built from the snapshots, kept the user's newer one.
	 *
	 * THE CLOCK IS PINNED, for the reason `lets the later of two same-day writes win, on a morning`
	 * gives above and to the opposite side of the sync. Since #443 an "as of today" save carries
	 * the real clock — `parseAsOfDate` returns `undefined` for today and `validateInput` resolves
	 * it with `?? new Date()` — so which of the two writes is the newer one is decided by the
	 * moment the run happens. Unpinned, this test read `new Date()` for its own fixture and
	 * asserted that the manual entry was the newest snapshot: true after 09:05Z, false before it.
	 * That is #481, and `db-matrix` is a required check on both engines, so it blocked every PR
	 * whose run started in the small hours. An AFTERNOON is what makes the sync the older of the
	 * two; the morning, where the sync is the newer one and must win, is that other test.
	 *
	 * The two states this separates are « the sync respects snapshot recency » and « the sync
	 * writes its figure into the account regardless of it ». A third state used to answer for
	 * both — « the sync was not the older write at all » — and it is what the pin removes. The
	 * ordering assertion below is what proves the pin removed it, because a fixture whose whole
	 * subject is which of two instants came first must not take that on trust.
	 */
	it('agrees after a bank sync that lands behind a same-day manual balance', async () => {
		expect.assertions(4);

		const afternoon = new Date('2026-08-20T14:00:00.000Z');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(afternoon);

		try {
			const { id } = await createNetWorthAccount(userId, {
				name: 'Compte courant',
				type: 'checking',
				balance: '2400,00',
				asOfDate: '2026-01-31'
			});

			// The user's own reading, saved "as of today", so it carries the clock above: 14:00Z.
			await updateNetWorthAccount(userId, id, {
				name: 'Compte courant',
				type: 'checking',
				balance: '9200,00',
				asOfDate: '2026-08-20'
			});
			expect(await headlineCents()).toBe(920_000);

			// The sync, stamped 09:05Z the same day: real, and OLDER than the manual entry above.
			await recordSyncedBalance(userId, id, 850_000, new Date('2026-08-20T09:05:00.000Z'));

			// The fixture did what its name says, read back rather than assumed: of the two
			// snapshots written today, the sync's is the older. `Number` because the column is
			// `BigInt` and only the money-columns extension makes it a `number` here, so the cast
			// keeps the assertion true of either.
			const sameDay = await prisma.netWorthSnapshot.findMany({
				where: { userId, accountId: id, capturedAt: { gte: new Date('2026-08-20T00:00:00.000Z') } },
				select: { balanceCents: true },
				orderBy: { capturedAt: 'asc' }
			});
			expect(sameDay.map((snapshot) => Number(snapshot.balanceCents))).toEqual([850_000, 920_000]);

			// The newest snapshot is still the user's, so it is still what the headline says.
			expect(await headlineCents()).toBe(920_000);
			expect(await curvePresentCents()).toBe(await headlineCents());
		} finally {
			vi.useRealTimers();
		}
	});
});
