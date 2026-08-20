import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNetWorthTotal } from '$lib/domain/netWorth';
import {
	createNetWorthAccount,
	deleteNetWorthAccount,
	readNetWorthAccounts,
	readNetWorthSeries,
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
});
