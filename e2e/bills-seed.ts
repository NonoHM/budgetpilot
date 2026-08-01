// Recurring streams for e2e/upcoming-bills.spec.ts, created through the app's real
// `/?/createTransaction` action — never a direct Prisma insert, same rule as e2e/seed.ts. The
// detector is what turns these transactions into streams, so the suite exercises the production
// detection path rather than a hand-written fixture.
//
// Dates are expressed as (months before the current month, day of month) and resolved at run time,
// so the suite keeps its shape whatever day it runs on. Everything the spec asserts lives in the
// PREVIOUS calendar month: it is the only period that is guaranteed to be entirely in the past, so
// an "overdue" row exists there on the 1st of a month just as it does on the 28th.
import { request, type APIRequestContext } from '@playwright/test';
import { E2E_BASE_URL } from './config';
import {
	E2E_BOOTSTRAP_ADMIN_EMAIL,
	E2E_BOOTSTRAP_ADMIN_PASSWORD,
	SEEDED_BUDGET_CATEGORY,
	assertOk,
	createTransaction,
	loginE2eUser,
	submitForm
} from './seed';

export interface BillStreamSeed {
	/** Raw label posted to the app. Letters only: `normalizeRecurringLabel` drops digits, and
	 *  `anonymizeMerchant` drops them again plus a list of bank keywords — a label carrying either
	 *  would render as something other than its title-cased self. */
	label: string;
	/** The anonymized label as the app renders it (`anonymizeMerchant` = strip, title-case). */
	display: string;
	/** Signed euros with a dot decimal, as the manual-entry action parses it. */
	amount: string;
	amountCents: number;
	/** Every occurrence, as (months before the current month, day of month). */
	occurrences: { monthsBack: number; day: number }[];
}

function monthAnchor(monthsBack: number): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
}

/** `yyyy-mm` of the month `monthsBack` months before the current one. */
export function monthKey(monthsBack: number): string {
	const anchor = monthAnchor(monthsBack);
	return `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `yyyy-mm-dd` for a day of that month. Days are kept <= 22 everywhere below so February needs no
 *  special case. */
export function dateInMonth(monthsBack: number, day: number): string {
	return `${monthKey(monthsBack)}-${String(day).padStart(2, '0')}`;
}

export const PREVIOUS_MONTH_KEY = monthKey(1);
export const CURRENT_MONTH_KEY = monthKey(0);

/** Every stream here uses one seeded default category: the detector groups on
 *  direction + normalized label + category, and the labels already differ. */
const BILL_CATEGORY = SEEDED_BUDGET_CATEGORY;

function monthlyOccurrences(
	day: number,
	monthsBack: number[]
): { monthsBack: number; day: number }[] {
	return monthsBack.map((offset) => ({ monthsBack: offset, day }));
}

/**
 * Five confirmed monthly streams whose last real occurrence falls early in the PREVIOUS month, so
 * that month's "Réglées" group holds five auto-settled rows before anything the spec does to it.
 * That is design plate B1's own shape, and it is the precondition for the focus-after-ignore check:
 * the group collapses to three rows, so a row landing in it past index 2 is only rendered if the
 * page expands the group first.
 */
export const SETTLED_STREAMS: BillStreamSeed[] = [
	{
		label: 'ZETA ALPHA CLUB',
		display: 'Zeta Alpha Club',
		amount: '-12.00',
		amountCents: -1200,
		occurrences: monthlyOccurrences(2, [3, 2, 1])
	},
	{
		label: 'ZETA BRAVO CLUB',
		display: 'Zeta Bravo Club',
		amount: '-13.00',
		amountCents: -1300,
		occurrences: monthlyOccurrences(3, [3, 2, 1])
	},
	{
		label: 'ZETA CHARLIE CLUB',
		display: 'Zeta Charlie Club',
		amount: '-14.00',
		amountCents: -1400,
		occurrences: monthlyOccurrences(4, [3, 2, 1])
	},
	{
		label: 'ZETA DELTA CLUB',
		display: 'Zeta Delta Club',
		amount: '-15.00',
		amountCents: -1500,
		occurrences: monthlyOccurrences(5, [3, 2, 1])
	},
	{
		label: 'ZETA ECHO CLUB',
		display: 'Zeta Echo Club',
		amount: '-16.00',
		amountCents: -1600,
		occurrences: monthlyOccurrences(6, [3, 2, 1])
	}
];

/**
 * Confirmed monthly streams whose last real occurrence is TWO months back, so the previous month
 * holds a projected — therefore unsettled and, being in the past, overdue — occurrence. Day 18/20
 * puts both after every settled row above in the date sort.
 */
export const OVERDUE_GYM: BillStreamSeed = {
	label: 'ZETA GYM CLUB',
	display: 'Zeta Gym Club',
	amount: '-29.99',
	amountCents: -2999,
	occurrences: monthlyOccurrences(20, [4, 3, 2])
};

export const OVERDUE_WATER: BillStreamSeed = {
	label: 'ZETA WATER CLUB',
	display: 'Zeta Water Club',
	amount: '-48.90',
	amountCents: -4890,
	occurrences: monthlyOccurrences(18, [4, 3, 2])
};

/**
 * EXACTLY two occurrences, ~30 days apart, the last of them more than 35 days old. Two occurrences
 * is `status: 'tentative'`, which `getFlowDisplayTier` maps to the "Incertain" tier whatever the
 * regularity score — and the projected next date (one month after the last one, i.e. in the
 * previous month) is therefore long past while the row must still read "À venir". This is the
 * locked tier gate.
 */
export const UNCERTAIN_STREAM: BillStreamSeed = {
	label: 'ZETA SPOTI CLUB',
	display: 'Zeta Spoti Club',
	amount: '-17.99',
	amountCents: -1799,
	occurrences: [
		{ monthsBack: 3, day: 22 },
		{ monthsBack: 2, day: 21 }
	]
};

export const ALL_BILL_STREAMS: BillStreamSeed[] = [
	...SETTLED_STREAMS,
	OVERDUE_GYM,
	OVERDUE_WATER,
	UNCERTAIN_STREAM
];

/**
 * Idempotent by probe, not by flag: Playwright restarts the worker on a retry, which re-runs
 * `beforeAll`. Creating every occurrence a second time would double each stream's amounts and
 * silently invalidate every figure this suite asserts, so the seed asks the app whether it is
 * already there.
 */
export async function seedBillStreams(): Promise<void> {
	const context = await request.newContext({
		baseURL: E2E_BASE_URL,
		// Same reason as e2e/seed.ts: SvelteKit's CSRF check compares Origin against the request's
		// own origin, and APIRequestContext does not send one by default.
		extraHTTPHeaders: { Origin: E2E_BASE_URL }
	});

	try {
		await loginE2eUser(context);

		const probe = await context.get(`/upcoming-bills?month=${PREVIOUS_MONTH_KEY}`);
		if ((await probe.text()).includes(OVERDUE_GYM.display)) return;

		for (const stream of ALL_BILL_STREAMS) {
			for (const occurrence of stream.occurrences) {
				await createTransaction(context, {
					date: dateInMonth(occurrence.monthsBack, occurrence.day),
					label: stream.label,
					amount: stream.amount,
					category: BILL_CATEGORY
				});
			}
		}
	} finally {
		await context.dispose();
	}
}

/**
 * A second, genuinely different account's session — the disposable bootstrap admin created by
 * e2e/seed.ts. The only way to prove the `userId` conjunct of a server query against real SQL is to
 * issue the request as another user, which no mocked route spec can do.
 */
export async function withOtherUserContext<T>(
	run: (context: APIRequestContext) => Promise<T>
): Promise<T> {
	const context = await request.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: { Origin: E2E_BASE_URL }
	});

	try {
		assertOk(
			'other-user login',
			await submitForm(context, '/login', {
				email: E2E_BOOTSTRAP_ADMIN_EMAIL,
				password: E2E_BOOTSTRAP_ADMIN_PASSWORD
			})
		);
		return await run(context);
	} finally {
		await context.dispose();
	}
}
