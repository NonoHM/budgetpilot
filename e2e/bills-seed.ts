// Recurring streams for e2e/upcoming-bills.spec.ts, created through the app's real
// `/?/createTransaction` action — never a direct Prisma insert, same rule as e2e/seed.ts. The
// detector is what turns these transactions into streams, so the suite exercises the production
// detection path rather than a hand-written fixture.
//
// EVERY date below is derived at run time from one anchor — `BILLS_ANCHOR.dueIso`, the estimated
// date every unsettled row in the suite carries — and the anchor itself is chosen by SIMULATING the
// production pipeline (`detectRecurringFlows` -> `buildBillOccurrences`) on the candidate dates and
// keeping the candidate with the most slack. Nothing here is a magic day offset: a change to the
// detector's cadence windows or to the staleness guard moves the fixture with it, and if no
// candidate survives the seed throws instead of leaving the suite to fail row by row.
//
// Why the anchor is not simply "the previous month" any more (it used to be, and that is what task
// B1 broke): a projected row only exists while its stream is still worth projecting, and
// `isStreamStale` retires a stream once it has been silent for longer than
//
//     medianIntervalDays + cadenceToleranceDays + ceil(medianIntervalDays * intervalCV)
//
// For a monthly stream that is ~30 + 5 + ~1 days. A projected occurrence sits one whole cadence
// after the last real one, so the row can only be rendered while
//
//     daysSince(lastDate) = medianIntervalDays + lateDays  <=  staleAfterDays
//
// i.e. while `lateDays` — how far the estimated date is already in the past — is at most the
// cadence tolerance, ~5 days for a monthly stream. An unsettled row therefore lives within a few
// days of TODAY, never "somewhere in the previous month". `BILLS_MONTH_KEY` is the month that
// window falls in: the current month on most days, the previous one during its first days.
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
import {
	computeStaleAfterDays,
	detectRecurringFlows,
	isStreamStale,
	type ForecastInputTransaction
} from '../src/lib/domain/forecast';
import { buildBillOccurrences } from '../src/lib/domain/upcomingBills';

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
	/** Every occurrence as an absolute `yyyy-mm-dd`, oldest first. */
	occurrences: string[];
	/** Seeded category to post the occurrences under. Defaults to `BILL_CATEGORY`; the transfer
	 *  stream overrides it so the app's real `CategoryNatureMapping` resolves it to `transfer`. */
	category: string;
}

const MS_PER_DAY = 86_400_000;

function toIsoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function parseIso(iso: string): Date {
	return new Date(`${iso}T00:00:00.000Z`);
}

function addDaysIso(iso: string, days: number): string {
	return toIsoDate(new Date(parseIso(iso).getTime() + days * MS_PER_DAY));
}

/** Same month arithmetic the rest of the app uses, overflow included: `Date.UTC` rolls a
 *  non-existent day (31 November) into the next month rather than clamping it. That can shift an
 *  interval by a day or two, which is precisely why the anchor is CHOSEN BY SIMULATION below
 *  instead of by a day-of-month rule — a rule would have to re-derive the calendar's edge cases and
 *  would be wrong the first time February moved. */
function addMonthsIso(iso: string, months: number): string {
	const date = parseIso(iso);
	return toIsoDate(
		new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()))
	);
}

function daysBetween(fromIso: string, toIso: string): number {
	return Math.round((parseIso(toIso).getTime() - parseIso(fromIso).getTime()) / MS_PER_DAY);
}

function monthKeyOf(iso: string): string {
	return iso.slice(0, 7);
}

/** `yyyy-mm` of the month `monthsBack` months before the current one. */
function monthKey(monthsBack: number, now: Date = new Date()): string {
	const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
	return `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Every stream here uses one seeded default category: the detector groups on
 *  direction + normalized label + category, and the labels already differ. */
const BILL_CATEGORY = SEEDED_BUDGET_CATEGORY;

/**
 * The seeded default whose `CategoryNatureMapping` is `transfer` (`server/categories/defaults.ts`,
 * key `savings`). Used by TRANSFER_SHAPE alone, so the suite can observe a nature that is RESOLVED
 * by the app from real per-user mapping rows rather than asserted from a fixture — the one link in
 * the badge's chain that no unit test can exercise, because the fixture is what it replaces.
 */
const TRANSFER_CATEGORY = 'Épargne';

interface StreamShape {
	label: string;
	display: string;
	amount: string;
	amountCents: number;
	/** Months before the anchor at which this stream's real occurrences sit. */
	monthsBack: number[];
	/** Days before the anchor's day-of-month, applied to every occurrence. */
	dayOffset: number;
	/** Defaults to `BILL_CATEGORY`. */
	category?: string;
}

const SETTLED_SHAPES: StreamShape[] = [
	{
		label: 'ZETA ALPHA CLUB',
		display: 'Zeta Alpha Club',
		amount: '-12.00',
		amountCents: -1200,
		monthsBack: [2, 1, 0],
		dayOffset: 1
	},
	{
		label: 'ZETA BRAVO CLUB',
		display: 'Zeta Bravo Club',
		amount: '-13.00',
		amountCents: -1300,
		monthsBack: [2, 1, 0],
		dayOffset: 1
	},
	{
		label: 'ZETA CHARLIE CLUB',
		display: 'Zeta Charlie Club',
		amount: '-14.00',
		amountCents: -1400,
		monthsBack: [2, 1, 0],
		dayOffset: 1
	},
	{
		label: 'ZETA DELTA CLUB',
		display: 'Zeta Delta Club',
		amount: '-15.00',
		amountCents: -1500,
		monthsBack: [2, 1, 0],
		dayOffset: 1
	},
	{
		label: 'ZETA ECHO CLUB',
		display: 'Zeta Echo Club',
		amount: '-16.00',
		amountCents: -1600,
		monthsBack: [2, 1, 0],
		dayOffset: 1
	}
];

const OVERDUE_GYM_SHAPE: StreamShape = {
	label: 'ZETA GYM CLUB',
	display: 'Zeta Gym Club',
	amount: '-29.99',
	amountCents: -2999,
	monthsBack: [3, 2, 1],
	dayOffset: 0
};

const OVERDUE_WATER_SHAPE: StreamShape = {
	label: 'ZETA WATER CLUB',
	display: 'Zeta Water Club',
	amount: '-48.90',
	amountCents: -4890,
	monthsBack: [3, 2, 1],
	dayOffset: 0
};

const UNCERTAIN_SHAPE: StreamShape = {
	label: 'ZETA SPOTI CLUB',
	display: 'Zeta Spoti Club',
	amount: '-17.99',
	amountCents: -1799,
	monthsBack: [6, 3],
	dayOffset: 0
};

/**
 * Same shape as the two overdue streams — three occurrences, last one a month before the anchor, so
 * the anchor date is a projected overdue occurrence — but posted under `TRANSFER_CATEGORY`. Its
 * subject is item C: a standing order to a livret A is a confirmed expense stream like any other,
 * it STAYS in "reste à sortir" (the cash-flow forecast counts it, and filtering one surface and not
 * the other is the disagreement #97 closed), and the only thing that distinguishes it is a badge.
 */
const TRANSFER_SHAPE: StreamShape = {
	label: 'ZETA LIVRET CLUB',
	display: 'Zeta Livret Club',
	amount: '-200.00',
	amountCents: -20_000,
	monthsBack: [3, 2, 1],
	dayOffset: 0,
	category: TRANSFER_CATEGORY
};

const RETIRED_SHAPE: StreamShape = {
	label: 'ZETA CANCEL CLUB',
	display: 'Zeta Cancel Club',
	amount: '-21.50',
	amountCents: -2150,
	monthsBack: [4, 3, 2],
	dayOffset: 0
};

function buildStream(shape: StreamShape, dueIso: string): BillStreamSeed {
	const base = addDaysIso(dueIso, -shape.dayOffset);
	return {
		label: shape.label,
		display: shape.display,
		amount: shape.amount,
		amountCents: shape.amountCents,
		occurrences: [...shape.monthsBack]
			.sort((a, b) => b - a)
			.map((monthsBack) => addMonthsIso(base, -monthsBack)),
		category: shape.category ?? BILL_CATEGORY
	};
}

interface BillsFixture {
	settled: BillStreamSeed[];
	gym: BillStreamSeed;
	water: BillStreamSeed;
	transfer: BillStreamSeed;
	uncertain: BillStreamSeed;
	retired: BillStreamSeed;
	all: BillStreamSeed[];
}

function buildFixture(dueIso: string): BillsFixture {
	const settled = SETTLED_SHAPES.map((shape) => buildStream(shape, dueIso));
	const gym = buildStream(OVERDUE_GYM_SHAPE, dueIso);
	const water = buildStream(OVERDUE_WATER_SHAPE, dueIso);
	const transfer = buildStream(TRANSFER_SHAPE, dueIso);
	const uncertain = buildStream(UNCERTAIN_SHAPE, dueIso);
	const retired = buildStream(RETIRED_SHAPE, dueIso);
	return {
		settled,
		gym,
		water,
		transfer,
		uncertain,
		retired,
		all: [...settled, gym, water, transfer, uncertain, retired]
	};
}

function toSimulationTransactions(streams: BillStreamSeed[]): ForecastInputTransaction[] {
	return streams.flatMap((stream) =>
		stream.occurrences.map((date, index) => ({
			id: `${stream.label}-${index}`,
			date,
			label: stream.label,
			amountCents: stream.amountCents,
			category: stream.category,
			type: 'expense' as const
		}))
	);
}

/**
 * How many days of slack the tightest live stream still has before `isStreamStale` retires it, or
 * `null` when the candidate does not produce the shape the spec pins. Everything the suite depends
 * on is checked here, against the real domain functions, on the real dates:
 *
 *  - the two overdue streams and the uncertain one each project EXACTLY ONE occurrence into the
 *    anchor's month, on the anchor date itself, with the status the spec asserts;
 *  - the five settled streams land one realized row each in that month and project none into it;
 *  - the retired stream is stale, so it contributes nothing at all.
 */
function scoreCandidate(dueIso: string, todayIso: string): number | null {
	const fixture = buildFixture(dueIso);
	const transactions = toSimulationTransactions(fixture.all);
	const flows = detectRecurringFlows(transactions);
	if (flows.length !== fixture.all.length) return null;

	const month = monthKeyOf(dueIso);
	const occurrences = buildBillOccurrences({
		flows,
		transactions,
		actions: [],
		fromIso: `${month}-01`,
		toIsoExclusive: addMonthsIso(`${month}-01`, 1),
		todayIso
	});

	const rowsOf = (stream: BillStreamSeed) =>
		occurrences.filter((occurrence) => occurrence.flow.label === stream.label);

	for (const stream of [fixture.gym, fixture.water, fixture.transfer]) {
		const rows = rowsOf(stream);
		if (rows.length !== 1) return null;
		if (rows[0].dateIso !== dueIso || rows[0].status !== 'overdue') return null;
	}

	const uncertainRows = rowsOf(fixture.uncertain);
	if (uncertainRows.length !== 1) return null;
	if (uncertainRows[0].dateIso !== dueIso) return null;
	if (uncertainRows[0].status !== 'upcoming' || !uncertainRows[0].estimatePassed) return null;
	if (uncertainRows[0].tier !== 'uncertain') return null;

	for (const stream of fixture.settled) {
		const rows = rowsOf(stream);
		if (rows.length !== 1 || rows[0].status !== 'settled') return null;
	}

	if (rowsOf(fixture.retired).length !== 0) return null;

	let slack = Number.POSITIVE_INFINITY;
	for (const flow of flows) {
		const stale = isStreamStale(flow, todayIso);
		const isRetired = flow.label === fixture.retired.label;
		if (isRetired !== stale) return null;
		if (isRetired) continue;
		slack = Math.min(slack, computeStaleAfterDays(flow) - daysBetween(flow.lastDate, todayIso));
	}

	return slack;
}

export interface BillsAnchor {
	/** The estimated date every unsettled row in this suite carries. Always strictly in the past. */
	dueIso: string;
	/** `yyyy-mm` of `dueIso` — the month the whole spec navigates to. */
	monthKey: string;
	/** How many days ago `dueIso` was. Bounded by the cadence tolerance, see the file header. */
	lateDays: number;
	/** Days left before the tightest live stream would be retired by the staleness guard. */
	slackDays: number;
}

/**
 * The estimated date is at least one day in the past (so `estimatePassed` holds) and at most
 * `MAX_LATE_DAYS` — one more than a monthly stream's own tolerance, so the loop is guaranteed to
 * walk past the last viable candidate rather than stop one short of it. The winner is the candidate
 * with the most slack, not the first that works: on a day where several qualify, the one furthest
 * from the staleness cliff is the one that survives a run crossing midnight.
 */
const MAX_LATE_DAYS = 6;

export function chooseBillsAnchor(now: Date = new Date()): BillsAnchor {
	const todayIso = toIsoDate(now);
	const rejected: string[] = [];
	let best: BillsAnchor | null = null;

	for (let lateDays = 1; lateDays <= MAX_LATE_DAYS; lateDays++) {
		const dueIso = addDaysIso(todayIso, -lateDays);
		const slackDays = scoreCandidate(dueIso, todayIso);
		if (slackDays === null) {
			rejected.push(dueIso);
			continue;
		}
		if (best === null || slackDays > best.slackDays) {
			best = { dueIso, monthKey: monthKeyOf(dueIso), lateDays, slackDays };
		}
	}

	if (best === null) {
		throw new Error(
			`bills-seed: no viable anchor date on ${todayIso} (rejected: ${rejected.join(', ')}). ` +
				'The detector or the staleness guard changed shape — fix the fixture, not the assertions.'
		);
	}

	return best;
}

export const BILLS_ANCHOR = chooseBillsAnchor();
/** The month every /upcoming-bills assertion in the spec runs against. */
export const BILLS_MONTH_KEY = BILLS_ANCHOR.monthKey;
export const CURRENT_MONTH_KEY = monthKey(0);
/** The month the retired stream's next occurrence WOULD fall in, had it not gone stale. */
export const RETIRED_ABSENT_MONTH_KEY = monthKeyOf(addMonthsIso(BILLS_ANCHOR.dueIso, -1));
/** The month holding the retired stream's last REAL occurrence, which is still a fact and renders. */
export const RETIRED_REALIZED_MONTH_KEY = monthKeyOf(addMonthsIso(BILLS_ANCHOR.dueIso, -2));

const FIXTURE = buildFixture(BILLS_ANCHOR.dueIso);

/**
 * Five confirmed monthly streams whose last real occurrence is the day BEFORE the anchor, so the
 * anchor's month holds five auto-settled rows before anything the spec does to it — and every one
 * of them sorts ahead of the anchor date. That is design plate B1's own shape, and it is the
 * precondition for the focus-after-ignore check: the group collapses to three rows, so a row landing
 * in it past index 2 is only rendered if the page expands the group first.
 */
export const SETTLED_STREAMS: BillStreamSeed[] = FIXTURE.settled;

/**
 * Confirmed monthly streams (three occurrences => `status: 'confirmed'`) whose last real occurrence
 * is one month before the anchor, so the anchor date itself is a projected — therefore unsettled
 * and, being `BILLS_ANCHOR.lateDays` days in the past, overdue — occurrence.
 */
export const OVERDUE_GYM: BillStreamSeed = FIXTURE.gym;
export const OVERDUE_WATER: BillStreamSeed = FIXTURE.water;

/** Same, in the `transfer`-mapped seeded category. See `TRANSFER_SHAPE`. */
export const TRANSFER_STREAM: BillStreamSeed = FIXTURE.transfer;

/**
 * EXACTLY two occurrences, so `status: 'tentative'`, which `getFlowDisplayTier` maps to the
 * "Incertain" tier whatever the regularity score — and the projected next date is the anchor,
 * already `BILLS_ANCHOR.lateDays` days in the past, while the row must still read "À venir". This
 * is the locked tier gate.
 *
 * The comment this replaced said the last occurrence was "more than 35 days old", and that is
 * exactly what task B1 turned into a stream with NO ROW AT ALL. The window is narrow, and the
 * arithmetic is worth having in front of you:
 *
 *     row exists  <=>  1 <= lateDays  and  interval + lateDays <= computeStaleAfterDays(flow)
 *
 * With two occurrences there is a single interval, so `intervalCV` is 0 and
 * `computeStaleAfterDays` collapses to `medianIntervalDays + getCadenceToleranceDays(cadence)`.
 * The projection lands one whole interval after the last occurrence, so the surviving room is the
 * CADENCE TOLERANCE and nothing else: 5 days for a monthly stream, 10 for a quarterly one.
 *
 * Hence QUARTERLY here, which is the one non-obvious choice in this file. A monthly pair cannot be
 * seeded at all on four days a year: around 30 April the two occurrences fall in February and
 * March, so the observed interval is 28 (threshold 33) while the elapsed time is already 31 + late.
 * Verified by sweeping `chooseBillsAnchor` over 800 consecutive days — monthly leaves 1 May and
 * 2 May with no viable anchor, quarterly leaves every day with at least half a day of slack and
 * most with four. The property under test is cadence-independent: `computeOccurrenceStatus` gates
 * on the tier before it looks at any date.
 */
export const UNCERTAIN_STREAM: BillStreamSeed = FIXTURE.uncertain;

/**
 * A confirmed monthly stream that simply stopped: its last real occurrence is TWO months before the
 * anchor, so it has been silent for roughly two cadences — well past `computeStaleAfterDays`. The
 * design's second exit for a stream (docs/superpowers/plans/2026-07-31-upcoming-bills-design-spec:D)
 * is that it disappears silently, and this fixture is the only way to observe it end to end: same
 * shape as `OVERDUE_GYM`, one month staler.
 */
export const RETIRED_STREAM: BillStreamSeed = FIXTURE.retired;

export const ALL_BILL_STREAMS: BillStreamSeed[] = FIXTURE.all;

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

		const probe = await context.get(`/upcoming-bills?month=${BILLS_MONTH_KEY}`);
		if ((await probe.text()).includes(OVERDUE_GYM.display)) return;

		for (const stream of ALL_BILL_STREAMS) {
			for (const date of stream.occurrences) {
				await createTransaction(context, {
					date,
					label: stream.label,
					amount: stream.amount,
					category: stream.category
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
