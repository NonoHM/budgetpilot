import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	detectRecurringFlows,
	getFlowAmountVariability,
	type FlowAmountVariability,
	type FlowCadence,
	type FlowDirection,
	type FlowDisplayTier,
	type RecurringFlow
} from '$lib/domain/forecast';
import {
	actionMatchesFlow,
	applyStreamExclusions,
	buildBillOccurrences,
	computeTotals,
	listObservationCandidates,
	occurrenceActionWindowDays,
	type BillOccurrence,
	type OccurrenceStatus,
	type StreamActionInput,
	type StreamActionKind
} from '$lib/domain/upcomingBills';
import { getInitials } from '$lib/domain/initials';
import { normalizeStoredRecurringLabel, truncateStoredLabel } from '$lib/domain/recurrence';
import type { Transaction } from '$lib/domain/transaction';
import { readDashboardDataForRange } from '$lib/server/budget/dashboard';
import { FORECAST_LOOKBACK_MONTHS } from '$lib/server/forecast';
import { anonymizeMerchant } from '$lib/server/reports/monthly';
// The single reader of the anchor column, exported from the restore path for exactly this reuse:
// a bare JSON.parse on a hand-edited (or restore-mangled) cell throws, and this column is read on
// every page load of the widget and the month view. Never duplicate it, never inline a parse.
import { parseAnchorTransactionIds } from '$lib/server/backup/import';
import {
	MAX_ANCHOR_CELL_CHARS,
	MAX_ANCHOR_IDS,
	MAX_RECURRING_STREAM_ACTIONS
} from '$lib/server/backup/schema';
import { prisma } from '$lib/server/db';
import { normalizeId } from '$lib/server/transactions/where';

/**
 * Upcoming-bills server layer: reads the recurring flows out of the user's transactions, projects
 * them into a period, applies the user's persisted per-stream actions, and exposes the three
 * mutations behind those actions.
 *
 * Every DISPLAYED label leaves this module through `anonymizeMerchant`. Three fields are derived
 * from the raw flow label instead, none of which is display copy, and a fourth kind of field must
 * not be added without deciding which group it belongs to:
 *
 *  - `actionPayload.label` — the raw label capped at `STORED_LABEL_MAX_CHARS`. It is the value
 *    `recordStreamAction` stores, so it has to round-trip unchanged.
 *  - `actionPayload.normalizedLabel` and `rowKey` — `normalizeStoredRecurringLabel(flow.label)`.
 *    That is NOT the anonymizer: it lowercases, strips diacritics, digits and punctuation, but it
 *    does NOT strip bank keywords (CB, SEPA, VIREMENT…) and does not cap the merchant at 28
 *    characters. No confidentiality impact — it is the user's own data going to the user's own
 *    browser, with every digit removed — but do not read it as "already anonymized".
 */

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Rolling half-window of the widget, in days, on both sides of today (locked decisions 4 & 5). */
const WIDGET_WINDOW_DAYS = 30;
const WIDGET_ROW_LIMIT = 5;

/**
 * Longest a stored anchor id may be, DERIVED from the cell budget rather than picked.
 *
 * `MAX_ANCHOR_CELL_CHARS` was sized as `MAX_ANCHOR_IDS * 28 + 2`, where 28 = 25 (a cuid) + 2
 * (quotes) + 1 (comma). Any per-id bound above that per-element budget lets this write path emit a
 * cell the backup validator refuses — 250 ids of 32 characters serialize to 8752 > 7500. That was
 * unreachable today only because the ownership filter means every surviving id is a real 25-char
 * cuid, i.e. the safety rested on a property of the id generator, not on the bound. It would break
 * silently the day ids become uuid v7 (36) or anything else longer.
 *
 * Solving `MAX_ANCHOR_IDS * (n + 3) + 2 <= MAX_ANCHOR_CELL_CHARS` gives 26, which still clears a
 * cuid with room. `fitAnchorCell` then asserts the real property on the real string, so nothing
 * downstream depends on this arithmetic being right.
 */
export const MAX_ANCHOR_ID_CHARS = Math.floor((MAX_ANCHOR_CELL_CHARS - 2) / MAX_ANCHOR_IDS) - 3;

/**
 * Idempotence window used only when the request carries fewer than two owned anchors, i.e. when
 * there are no dates to derive a cadence from. The widest window the domain ever grants — the
 * clamp ceiling of `occurrenceActionWindowDays` — expressed through that function rather than as a
 * literal so it cannot drift from it.
 *
 * With two or more anchors the real median interval is computed instead: a fixed 15 days is WRONG
 * for a weekly stream, whose own window is 3. Ignoring this week's occurrence and then next week's
 * (7 days apart, 7 <= 15) matched the first action and wrote no row, so the second occurrence
 * stayed on the page and the tap looked broken.
 */
const FALLBACK_IDEMPOTENCE_WINDOW_DAYS = occurrenceActionWindowDays({ medianIntervalDays: 365 });

/**
 * The widest tolerance the domain ever grants between a stored `dueDate` and a projected
 * occurrence date, which is the whole safety margin of the prune cutoff below: an action further
 * than this from every renderable occurrence date can be assigned to none of them.
 *
 * An ALIAS of `FALLBACK_IDEMPOTENCE_WINDOW_DAYS` rather than a second identical initializer. The
 * two names answer different questions — "how far apart may two taps be and still be one decision"
 * versus "how far from a projected date can a stored decision still reach" — but both are the same
 * quantity, the clamp ceiling of `occurrenceActionWindowDays`, and writing it twice would let one
 * of them be tuned without the other. If they ever have to differ, they must stop being an alias
 * deliberately, with a reason written here.
 */
const MAX_OCCURRENCE_ACTION_WINDOW_DAYS = FALLBACK_IDEMPOTENCE_WINDOW_DAYS;

type DbActionKind = 'IGNORE' | 'PAID' | 'EXCLUDE';

/**
 * The kinds the prune may delete. EXCLUDE is permanent and user-initiated, and the element type
 * makes adding it here a COMPILE error rather than a test failure — the mistake this guards against
 * is a contributor generalising the prune to "everything inert", which would silently and
 * irreversibly destroy exclusions.
 *
 * `readonly`, and therefore spread at the call site: Prisma's generated `in` takes a MUTABLE
 * `RecurringActionKind[]`, so passing this directly is itself a type error ("The type 'readonly
 * (\"IGNORE\" | \"PAID\")[]' is 'readonly' and cannot be assigned to the mutable type
 * 'RecurringActionKind[]'"). Dropping `readonly` to satisfy it would hand every caller a mutable
 * module-level array holding the safety list — a `PRUNABLE_KINDS.push('EXCLUDE')` that no type
 * checks. The copy costs two elements once per write.
 */
const PRUNABLE_KINDS: readonly Exclude<DbActionKind, 'EXCLUDE'>[] = ['IGNORE', 'PAID'];

const DB_KIND_BY_ACTION_KIND: Record<StreamActionKind, DbActionKind> = {
	ignore: 'IGNORE',
	paid: 'PAID',
	exclude: 'EXCLUDE'
};

const ACTION_KIND_BY_DB_KIND: Record<DbActionKind, StreamActionKind> = {
	IGNORE: 'ignore',
	PAID: 'paid',
	EXCLUDE: 'exclude'
};

export interface UpcomingBillRowView {
	/** Unique per render — the same stream can legitimately appear twice in one period. */
	rowKey: string;
	/** Anonymized; never the raw bank label. */
	label: string;
	initials: string;
	category: string;
	direction: FlowDirection;
	tier: FlowDisplayTier;
	occurrenceCount: number;
	cadence: FlowCadence;
	anchorDayOfMonth: number;
	dateIso: string;
	status: OccurrenceStatus;
	daysLate: number | null;
	estimatePassed: boolean;
	settledKind: 'auto' | 'manual' | null;
	/** Signed. */
	amountCents: number;
	averageAmountCents: number;
	minAmountCents: number;
	maxAmountCents: number;
	variability: FlowAmountVariability;
	countsInRemainingTotal: boolean;
	appliedActionId: string | null;
	/**
	 * Hidden-field payload for the row's action forms. `label` here is the RAW flow label capped at
	 * 191 — not the anonymized display label — because it is what `recordStreamAction` stores in the
	 * `label` column, whose documented purpose is display and debugging of the stored decision. It
	 * is the one raw value this module lets out.
	 *
	 * It used to be true that it "never reaches a rendered string". It no longer is: the month
	 * view's "Voir les transactions liées" builds `/transactions?q=<this label>`, because `?q=` is a
	 * substring test over the raw `Transaction.label` and the anonymized form matches nothing. So
	 * the value now reaches a URL — browser history, and any reverse-proxy access log that does not
	 * strip `q` (`Caddyfile.example` does). Still never rendered as page text.
	 */
	actionPayload: {
		direction: string;
		normalizedLabel: string;
		label: string;
		dueDate: string;
		anchorTransactionIds: string;
	};
}

/**
 * One stream the user asked the app to stop detecting, for the page's collapsed escape hatch.
 *
 * `actionId` is the id of the EXCLUDE row itself, so the restore control posts it to the SAME
 * `?/undoAction` the banner and the ignored-row "Rétablir" already use — there is no second delete
 * path, and therefore no second place for the ownership check to be forgotten.
 */
export interface ExcludedStreamView {
	actionId: string;
	/** Anonymized, like every other label leaving this module. Never the raw stored one. */
	label: string;
	initials: string;
}

export interface UpcomingBillsMonthView {
	/** YYYY-MM. */
	month: string;
	todayIso: string;
	isCurrentMonth: boolean;
	isFutureMonth: boolean;
	/**
	 * YYYY-MM of the detection window's own start — the OLDEST month that can hold anything.
	 *
	 * Detection is pinned to the 12 months before today (see `loadUpcomingBillsMonth`), and a
	 * realized row is resolved through `flow.occurrenceIds`, so a month entirely older than this one
	 * renders NOTHING while `streamCount` stays non-zero — which the page would otherwise present as
	 * "no bill due in June 2024, try another month", a false claim about a month the user really did
	 * pay bills in. The period navigator stops here instead, reusing the inert-arrow treatment it
	 * already has for the no-stream-at-all case.
	 */
	oldestNavigableMonth: string;
	/** Flows surviving the user's exclusions, all tiers. */
	streamCount: number;
	remainingExpenseCents: number;
	expectedIncomeCents: number;
	/** Date ascending; the page groups them. */
	rows: UpcomingBillRowView[];
	/** Only meaningful when `rows` is empty — computed only then. */
	observationCandidates: { label: string; occurrenceCount: number }[];
	/**
	 * Every EXCLUDE the user holds, oldest first. NOT period-scoped: an exclusion has no date, so
	 * showing a different set on each month would make the escape hatch depend on where the user
	 * happens to be standing.
	 */
	excludedStreams: ExcludedStreamView[];
}

export interface UpcomingBillsWidgetView {
	/** <= 5; upcoming|overdue only; confirmed|likely tiers only; date ascending. */
	rows: UpcomingBillRowView[];
	overdueCount: number;
	/** Rolling 30-day window, not the calendar month (locked decisions 4 & 5). */
	remainingExpenseCents: number;
	hasStreams: boolean;
	/** The server's own UTC date, same convention as `UpcomingBillsMonthView.todayIso`: the client
	 *  must render relative dates against THIS value, never `new Date()` — a browser in another
	 *  timezone can already be "tomorrow" in UTC while the server-computed row statuses still read
	 *  today's date. */
	todayIso: string;
}

/**
 * The month `/upcoming-bills` shows when the URL names none — UTC, because that is what
 * `isCurrentMonth`/`isFutureMonth` below are derived from. `getCurrentMonth()` reads the server's
 * LOCAL month, and on a UTC+2 host between 00:00 and 02:00 on the 1st the two disagree: the load
 * resolves the new month, the view calls that month FUTURE, and the page loses its "Ce mois" badge
 * and renders "Revenir à ce mois" as a link to the page it is already on.
 */
export function getCurrentBillsMonth(): string {
	return toIsoDate(new Date()).slice(0, 7);
}

/**
 * Start of the detector's pinned lookback window: `FORECAST_LOOKBACK_MONTHS` before `now`, in UTC.
 *
 * ONE definition, called by all three places that need it — the month view's fetch range, the
 * widget's, and `computeInertActionCutoff`. It used to be the same `Date.UTC(…)` expression written
 * out three times, and that is a duplicate whose divergence DELETES USER DATA: the prune is safe
 * only because its floor is derived from the same window the read paths render from. Nothing tied
 * the widget's copy to the other two at all.
 *
 * `Date.UTC` month overflow is load-bearing, and is the reason this must not be reimplemented per
 * call site: on 2028-02-29 `getUTCMonth() - 12` names month 1 of 2027, which has no 29th, so the
 * value rolls forward into 2027-03-01. That is acceptable — but only because every caller rolls
 * identically.
 */
export function computeDetectionLookbackStart(now: Date): Date {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - FORECAST_LOOKBACK_MONTHS, now.getUTCDate())
	);
}

/**
 * YYYY-MM of the oldest month any surface can render: the month `computeDetectionLookbackStart`
 * lands IN, not the one after it — that month is half inside the window and its second half still
 * carries real rows.
 *
 * Exported so the route can clamp a typed or bookmarked `?month=` to it (a month older than this
 * renders nothing while `streamCount` stays non-zero, i.e. the page's "rien de prévu ici, changez
 * de mois" copy would be a false claim). Derived from the SAME helper the detection filter uses —
 * never a second `Date.UTC(…)` expression, which is how a boundary and the window it names drift
 * apart.
 */
export function getOldestNavigableBillsMonth(now: Date = new Date()): string {
	return toIsoDate(computeDetectionLookbackStart(now)).slice(0, 7);
}

export async function loadUpcomingBillsMonth(
	userId: string,
	month: string
): Promise<UpcomingBillsMonthView> {
	if (!MONTH_PATTERN.test(month)) throw error(400, m.upcoming_bills_error_invalid_month());
	const year = Number(month.slice(0, 4));
	const monthNumber = Number(month.slice(5, 7));
	if (monthNumber < 1 || monthNumber > 12) {
		throw error(400, m.upcoming_bills_error_invalid_month());
	}

	const now = new Date();
	const todayIso = toIsoDate(now);
	const monthStart = new Date(Date.UTC(year, monthNumber - 1, 1));
	const monthEndExclusive = new Date(Date.UTC(year, monthNumber, 1));

	// The fetch must cover the displayed period as well as the detector's 12-month lookback (same
	// derivation as loadCashFlowForecast), hence min/max rather than a single fixed range.
	//
	// The `min()` half is now nearly vestigial: since detection is pinned below, a transaction older
	// than `lookbackStart` reaches no consumer — `buildBillOccurrences` only ever looks a transaction
	// up by an id that is already in some `flow.occurrenceIds`, and every such id comes from the
	// pinned set. It is kept because narrowing the range is a separate decision (this call site is
	// not the only shape `readDashboardDataForRange` serves) and because widening back is exactly the
	// regression B2 removed. Do NOT write it back into `detectRecurringFlows`.
	const lookbackStart = computeDetectionLookbackStart(now);
	const from = lookbackStart < monthStart ? lookbackStart : monthStart;
	const to = monthEndExclusive > now ? monthEndExclusive : now;

	const [{ transactions }, actionRows] = await Promise.all([
		readDashboardDataForRange(userId, { from, to, budgetMonth: month }),
		findStreamActions(userId)
	]);

	const actions = toStreamActionInputs(actionRows);
	// The DETECTION INPUT is pinned to the 12 months before today, always — never widened to reach
	// the viewed month, even though the FETCH above still does. Navigating to a month older than
	// `lookbackStart` used to hand the detector more history than the widget's fixed 12 months, and
	// detection is not monotonic in its input: a 2-occurrence tentative flow becomes confirmed, the
	// amount-grouping (`getSimilarAmountGroups`, order-dependent) re-splits, `streamCount` moves. The
	// same stream therefore read "Probable" on one month and "Confirmé" on another, and disagreed
	// with the dashboard widget.
	//
	// Accepted consequence, stated at full strength because the comment outlives the report: a month
	// entirely older than `lookbackStart` renders NOTHING AT ALL. Not "fewer streams" — nothing. A
	// realized row is resolved through `flow.occurrenceIds`, so a transaction outside this window
	// belongs to no flow, and `projectFlowOccurrences` only emits dates after `flow.lastDate`, which
	// is by construction recent. `streamCount` stays non-zero there, which is why the view exports
	// `oldestNavigableMonth` and the page stops the period navigator at it (see that field).
	//
	// Consistency of a stream's tier across every surface is what this buys: a stream showing two
	// different confidence levels on two screens is actively confusing, while an unreachable month is
	// merely unreachable. Months INSIDE the lookback are unaffected — their settled rows still
	// render, including the partial first one.
	//
	// Filtered rather than refetched: one query already ran, and re-issuing a narrower one would cost
	// a round trip to discard rows already in memory.
	const detectionFromIso = toIsoDate(lookbackStart);
	const detectionTransactions = transactions.filter(
		(transaction) => transaction.date >= detectionFromIso
	);
	const flows = detectRecurringFlows(detectionTransactions);
	const occurrences = buildBillOccurrences({
		flows,
		transactions,
		actions,
		fromIso: toIsoDate(monthStart),
		toIsoExclusive: toIsoDate(monthEndExclusive),
		todayIso
	});
	const totals = computeTotals(occurrences);
	const rows = occurrences.map(toRowView);

	return {
		month,
		todayIso,
		// Both derived from `todayIso` rather than from getCurrentMonth(), which reads the server's
		// LOCAL month: every date in this view is UTC, and a view that calls a month "current" while
		// its own occurrences disagree is worse than one that is an hour off at a month boundary.
		isCurrentMonth: month === todayIso.slice(0, 7),
		isFutureMonth: month > todayIso.slice(0, 7),
		// Through the exported helper, not `detectionFromIso.slice(0, 7)`: the route clamps `?month=`
		// to that function's value, and a view disagreeing with the clamp by even one month is a
		// redirect loop or an unreachable month.
		oldestNavigableMonth: getOldestNavigableBillsMonth(now),
		streamCount: applyStreamExclusions(flows, actions).length,
		remainingExpenseCents: totals.remainingExpenseCents,
		expectedIncomeCents: totals.expectedIncomeCents,
		rows,
		// Computed only for the empty state it belongs to — and from the PRE-exclusion flow list,
		// because the `claimedIds` filter inside is what keeps a detected stream out of the
		// suggestions. Passing the post-exclusion list would resurface, as "en cours d'observation",
		// exactly the streams the user asked the app to stop detecting.
		//
		// Built from the same pinned set as `flows`, never from the wider fetch: the `claimedIds`
		// filter inside compares against the flows' occurrence ids, so a wider transaction list would
		// suggest, as "en cours d'observation", groups the detector was never shown.
		observationCandidates:
			rows.length === 0 ? toObservationCandidateViews(detectionTransactions, flows) : [],
		excludedStreams: toExcludedStreamViews(actionRows)
	};
}

export async function loadUpcomingBillsWidget(userId: string): Promise<UpcomingBillsWidgetView> {
	const now = new Date();
	const todayIso = toIsoDate(now);
	const fromIso = addDaysIso(todayIso, -WIDGET_WINDOW_DAYS);
	const toIsoExclusive = addDaysIso(todayIso, WIDGET_WINDOW_DAYS);

	const lookbackStart = computeDetectionLookbackStart(now);
	// `today + 30 days` is unconditionally after `now`, so unlike the month view — which can be
	// asked for a period entirely in the past — this range needs no max() against `now`.
	const windowEnd = new Date(`${toIsoExclusive}T00:00:00.000Z`);

	const [{ transactions }, actionRows] = await Promise.all([
		readDashboardDataForRange(userId, {
			from: lookbackStart,
			to: windowEnd,
			budgetMonth: todayIso.slice(0, 7)
		}),
		findStreamActions(userId)
	]);

	const actions = toStreamActionInputs(actionRows);
	const flows = detectRecurringFlows(transactions);
	const occurrences = buildBillOccurrences({
		flows,
		transactions,
		actions,
		fromIso,
		toIsoExclusive,
		todayIso
	});

	// Everything still open and trustworthy inside the rolling window. The total is summed over
	// this same kept set — never over the 5 rows that get displayed, which would understate it.
	const kept = occurrences.filter(
		(occurrence) =>
			(occurrence.status === 'upcoming' || occurrence.status === 'overdue') &&
			occurrence.tier !== 'uncertain'
	);

	return {
		rows: kept.slice(0, WIDGET_ROW_LIMIT).map(toRowView),
		overdueCount: kept.filter((occurrence) => occurrence.status === 'overdue').length,
		remainingExpenseCents: computeTotals(kept).remainingExpenseCents,
		hasStreams: applyStreamExclusions(flows, actions).length > 0,
		todayIso
	};
}

export interface RecordStreamActionInput {
	kind: StreamActionKind;
	direction: string;
	/** Raw flow label. `normalizedLabel` is DERIVED from this server-side and is deliberately not
	 *  an input: see recordStreamAction. The row's `actionPayload` still carries a normalizedLabel
	 *  for the client's own use (grouping, row keys) — the route simply does not forward it. */
	label: string;
	dueDate: string | null;
	anchorTransactionIds: string[];
}

/**
 * Persists one per-stream decision. Idempotent by construction: re-recording a decision that is
 * already stored returns the existing row's id instead of inserting a second one, so a double
 * submit (or a second tab) cannot produce two rows the read path then has to reconcile.
 *
 * A plain `create` on purpose — the model carries no unique constraint to race on, so there is
 * nothing for `withConcurrentWriteRetry` to retry, and the rare duplicate two simultaneous writes
 * could produce is resolved on read by first-match.
 */
export async function recordStreamAction(
	userId: string,
	input: RecordStreamActionInput
): Promise<{ actionId: string }> {
	// Both come off a form, so `kind` is only nominally typed here: the route hands over whatever
	// the request body held. Parsed through guards that return the narrowed type rather than
	// asserted, so a value outside the enum cannot reach the column.
	const kind = parseActionKind(input.kind);
	const direction = parseDirection(input.direction);

	// Neither field is trusted to BE a string / an array. Both come off a form body, so an absent or
	// wrongly shaped field would otherwise throw a TypeError out of `.trim()` / `.map()` and surface
	// as a 500. Every rejection in this function is a 400.
	const rawLabel = typeof input.label === 'string' ? input.label : '';
	const rawAnchors = Array.isArray(input.anchorTransactionIds) ? input.anchorTransactionIds : [];

	// Both columns are varchar(191) on MySQL, and the schema's own doc comments name this function
	// as the cap that makes that safe. Real bank labels do exceed it (Transaction.label is
	// @db.Text), so without the truncation the same input succeeds on SQLite/PostgreSQL and errors
	// on MySQL under STRICT_TRANS_TABLES — the provider divergence this codebase removes on sight.
	// `truncateStoredLabel` also refuses to cut inside a surrogate pair; see it for why the bound is
	// counted in UTF-16 units rather than code points.
	//
	// The column is NOT NULL and the backup validator requires `min(1)`, so an empty label would
	// produce a row whose own export cannot be restored — refused rather than written.
	const label = truncateStoredLabel(rawLabel.trim());
	if (!label) throw error(400, m.upcoming_bills_error_invalid_action());

	// DERIVED, never taken from the request. `normalizedLabel` is the fallback half of the stream
	// identity `actionMatchesFlow` uses once the anchors have aged out, so a client-supplied value
	// is a way to point an action at a stream the user never acted on. Goes through the same
	// truncate-then-normalize helper the domain matcher uses, so the two sides cannot diverge.
	const normalizedLabel = normalizeStoredRecurringLabel(label);
	// Unreachable from the app: a label that normalizes to nothing is dropped by
	// `groupTransactionsForRecurrence`, so no flow can carry one. A forged payload can, and such a
	// row would be unmatchable by anything but its anchors.
	if (!normalizedLabel) throw error(400, m.upcoming_bills_error_invalid_action());

	const dueDate = parseDueDate(kind, input.dueDate);

	// Sanitize before the ownership query, not after: the sanitized list is what goes into the
	// `IN (...)`, so its size and element length must be bounded here. Truncation keeps the NEWEST
	// anchors (`occurrenceIds` is date-ascending) — the same rule the restore path applies, and for
	// the same reason: dropping old anchors only weakens the action to label-based matching.
	const requestedAnchors = [
		...new Set(
			rawAnchors
				.map((id) => (typeof id === 'string' ? id.trim() : ''))
				.filter((id) => id.length > 0 && id.length <= MAX_ANCHOR_ID_CHARS)
		)
	].slice(-MAX_ANCHOR_IDS);
	if (requestedAnchors.length === 0) throw error(400, m.upcoming_bills_error_invalid_stream());

	// Ownership, fail closed. The `userId` conjunct is the whole point of this query: without it a
	// forged (or stale-after-restore) id would be persisted into this user's row and then read back
	// as one of their anchors, which is a cross-user reference. Only ids this user actually owns
	// survive, and if none does the action is refused rather than stored anchor-less.
	//
	// `date` is selected as well because the idempotence window below needs the stream's real
	// cadence, and these rows are the only occurrences of it this function has in hand.
	const owned = await prisma.transaction.findMany({
		where: { userId, id: { in: requestedAnchors } },
		select: { id: true, date: true }
	});
	const ownedIds = new Set(owned.map((transaction) => transaction.id));
	const anchors = fitAnchorCell(requestedAnchors.filter((id) => ownedIds.has(id)));
	if (anchors.length === 0) throw error(400, m.upcoming_bills_error_invalid_stream());

	// The window this stream's own cadence justifies, from the anchor dates just fetched.
	const windowDays = resolveIdempotenceWindowDays(owned.map((transaction) => transaction.date));

	const dbKind = DB_KIND_BY_ACTION_KIND[kind];
	// Scoped to (userId, kind) — the composite index this model carries exists for this read.
	const existing = await prisma.recurringStreamAction.findMany({
		where: { userId, kind: dbKind },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
	});

	// The stream the request describes, shaped as a flow so the domain's own matcher decides — the
	// priority (anchors first, direction + normalized label as fallback) must not be reimplemented.
	const pseudoFlow = { direction, label, occurrenceIds: anchors };
	const duplicate = existing.find((row) => {
		if (
			!actionMatchesFlow(
				{
					direction: row.direction as FlowDirection,
					normalizedLabel: row.normalizedLabel,
					anchorTransactionIds: parseAnchorTransactionIds(row.anchorTransactionIds)
				},
				pseudoFlow
			)
		) {
			return false;
		}
		if (dueDate === null) return true;
		if (row.dueDate === null) return false;
		return Math.abs(daysBetween(toIsoDate(row.dueDate), toIsoDate(dueDate))) <= windowDays;
	});
	if (duplicate) return { actionId: duplicate.id };

	// Refuse rather than EVICT. The backup validator bounds a payload, so an unbounded write path
	// lets a user build a set their OWN export is then refused on — but dropping a live decision to
	// make room would silently undo something the user asked for (an excluded stream would reappear
	// with no trace). Refusing is visible and recoverable with one undo.
	//
	// The prune inside the transaction below is NOT an eviction and must not become one: its
	// predicate does not depend on the count, so it deletes the same rows whether the cap is near or
	// not, and it can only ever remove decisions that no surface can still act on.
	//
	// Read once, outside the transaction: every date the prune derives has to come from ONE instant,
	// or a write straddling midnight could compute two different cutoffs.
	const now = new Date();

	// Count and insert share one transaction so the check cannot be read stale by the time the row
	// lands. That bounds normal growth; it is NOT exact under READ COMMITTED, which is why the
	// import validator is given headroom above this cap rather than the same number — see
	// MAX_IMPORTED_RECURRING_STREAM_ACTIONS. No `withConcurrentWriteRetry`: there is no unique
	// constraint here to race on, so there would be nothing to retry.
	//
	// Two failure modes the prune added to this transaction, both availability-only and both
	// accepted: a prune that errors now aborts a legitimate write the user just made (it did not
	// exist to fail before), and on MySQL the range delete over `@@index([userId, kind])` takes
	// next-key locks from the start of the transaction, where previously nothing was locked until
	// the insert — so two concurrent writers for one user serialize slightly earlier.
	const created = await prisma.$transaction(async (tx) => {
		// Prune the inert ignore/paid decisions BEFORE counting, so the cap is a statement about the
		// decisions that can still do something rather than about everything ever recorded. See
		// `computeInertActionCutoff` for the predicate and for why the trigger is here and not on the
		// read path. Same transaction as the count and the insert: if the cap still refuses the write,
		// the whole thing rolls back and nothing was deleted.
		await tx.recurringStreamAction.deleteMany({
			where: {
				userId,
				// THE ONLY THING KEEPING EXCLUDE OUT OF THIS DELETE. Do not remove this conjunct on the
				// strength of the `dueDate` bound below.
				//
				// It is true that no NULL satisfies a SQL comparison, and true that `parseDueDate`
				// refuses a due date on an exclude — but that guarantee belongs to the WRITE path only.
				// `backup/import.ts` writes `dueDate` verbatim for every kind and `backup/schema.ts` has
				// no cross-field refine, so a RESTORED exclude can carry a non-null, arbitrarily old
				// date. Such a row is a fully live exclusion (`applyStreamExclusions` never looks at
				// `dueDate`), and a prune reaching it would irreversibly delete a decision the user
				// still relies on. The date bound therefore protects a subset of the rows that can
				// exist; `PRUNABLE_KINDS` protects all of them.
				kind: { in: [...PRUNABLE_KINDS] },
				dueDate: { lt: computeInertActionCutoff(now) }
			}
		});

		const total = await tx.recurringStreamAction.count({ where: { userId } });
		if (total >= MAX_RECURRING_STREAM_ACTIONS) {
			throw error(400, m.upcoming_bills_error_action_limit());
		}

		return tx.recurringStreamAction.create({
			data: {
				userId,
				kind: dbKind,
				direction,
				normalizedLabel,
				label,
				anchorTransactionIds: JSON.stringify(anchors),
				dueDate
			},
			select: { id: true }
		});
	});

	return { actionId: created.id };
}

export async function undoStreamAction(userId: string, actionId: string): Promise<void> {
	const id = normalizeId(actionId);
	if (!id) throw error(404, m.upcoming_bills_error_not_found());

	const result = await prisma.recurringStreamAction.deleteMany({ where: { id, userId } });
	if (result.count === 0) throw error(404, m.upcoming_bills_error_not_found());
}

/**
 * Oldest `dueDate` an IGNORE or PAID decision can still change anything about. Everything strictly
 * before it is inert on every surface, forever, and `recordStreamAction` deletes it.
 *
 * WHY THE BOUND IS WHERE IT IS. An action only ever reaches a render through
 * `assignActionsToOccurrences`, which needs a PROJECTED occurrence date within
 * `occurrenceActionWindowDays` (at most `MAX_OCCURRENCE_ACTION_WINDOW_DAYS`) of its `dueDate`. The
 * oldest date any surface can project is the 1st of `oldestNavigableMonth` — the month the pinned
 * 12-month detection window starts in, past which the month view renders nothing at all and the
 * period navigator refuses to go. So an action further back than that day minus one full window can
 * be assigned to no occurrence on any month the user can reach, and on no widget window either
 * (the widget only looks 30 days back).
 *
 * WHY IT IS DELIBERATELY LOOSE. It does not catch the decisions that went inert EARLY — a PAID
 * whose real transaction landed the next day, absorbing the occurrence, is inert from that moment
 * but survives here for a year. That is on purpose: such a row is harmless while it lives
 * (assigning to no date, it renders nothing and counts for nothing), the only cost is a row, and
 * the alternative predicate would have to re-run detection to decide — the same computation whose
 * output the user is about to see, run to justify a DELETE. Given the choice between a prune that
 * misses inert rows and one that could remove a live decision, this takes the first.
 *
 * Derived from `FORECAST_LOOKBACK_MONTHS` and `occurrenceActionWindowDays` rather than written as a
 * duration, so widening the detection window or the assignment tolerance moves the cutoff with it.
 * Exported for the spec that ties it back to `oldestNavigableMonth`: the two are computed in
 * different functions and only a test asserting them together proves they still line up.
 */
export function computeInertActionCutoff(now: Date): Date {
	const lookbackStart = computeDetectionLookbackStart(now);
	// `oldestNavigableMonth` is that date's MONTH, so the oldest renderable day is its 1st.
	const oldestRenderableDayMs = Date.UTC(
		lookbackStart.getUTCFullYear(),
		lookbackStart.getUTCMonth(),
		1
	);
	return new Date(oldestRenderableDayMs - MAX_OCCURRENCE_ACTION_WINDOW_DAYS * MS_PER_DAY);
}

// ─── Internals ──────────────────────────────────────────────────────────────

type StreamActionRow = {
	id: string;
	kind: DbActionKind;
	direction: string;
	normalizedLabel: string;
	/** RAW capped label, as stored. Only `toExcludedStreamViews` reads it, and only through the
	 *  anonymizer. */
	label: string;
	anchorTransactionIds: string;
	dueDate: Date | null;
};

async function findStreamActions(userId: string): Promise<StreamActionRow[]> {
	// Ordered oldest first: `buildBillOccurrences` resolves a tie between two actions of the same
	// kind landing on one date by input order, so a stable order is what keeps the view from
	// flickering between renders.
	return prisma.recurringStreamAction.findMany({
		where: { userId },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
		select: {
			id: true,
			kind: true,
			direction: true,
			normalizedLabel: true,
			label: true,
			anchorTransactionIds: true,
			dueDate: true
		}
	});
}

/**
 * The EXCLUDE rows, as the page's collapsed section renders them.
 *
 * Built from the SAME `findStreamActions` result the occurrence build uses, so the section cannot
 * disagree with what the page hides — and so no second query has to repeat the `userId` scope.
 *
 * Unlike `toStreamActionInputs`, a row with an unreadable `direction` is KEPT: that function drops
 * it because applying a decision to the wrong side of the budget is worse than ignoring it, but
 * here the row is only being listed so the user can delete it, and a decision the app refuses to
 * apply AND refuses to show is one the user can never get rid of.
 */
function toExcludedStreamViews(rows: readonly StreamActionRow[]): ExcludedStreamView[] {
	return rows
		.filter((row) => row.kind === 'EXCLUDE')
		.map((row) => {
			const label = anonymizeMerchant(row.label);
			return { actionId: row.id, label, initials: getInitials(label) };
		});
}

function toStreamActionInputs(rows: readonly StreamActionRow[]): StreamActionInput[] {
	const actions: StreamActionInput[] = [];

	for (const row of rows) {
		// `direction` is a plain String column, so a row written by an older version or a
		// hand-restored file can hold anything. Such a row is dropped rather than coerced: coercing
		// would apply the user's decision to the opposite side of their budget.
		if (row.direction !== 'income' && row.direction !== 'expense') continue;

		actions.push({
			id: row.id,
			kind: ACTION_KIND_BY_DB_KIND[row.kind],
			direction: row.direction,
			normalizedLabel: row.normalizedLabel,
			anchorTransactionIds: parseAnchorTransactionIds(row.anchorTransactionIds),
			dueDate: row.dueDate ? toIsoDate(row.dueDate) : null
		});
	}

	return actions;
}

function toRowView(occurrence: BillOccurrence, index: number): UpcomingBillRowView {
	const flow = occurrence.flow;
	// The merchant half only. The category travels as its own field and the design prints it in the
	// row's sub-line, so the composed `anonymizeLabel` form would show it twice per row — and
	// `getInitials` over that form reads its " - " as a word and renders "N-" on the avatar. Same
	// sanitizer, same anonymization boundary, just not the composed string.
	const label = anonymizeMerchant(flow.label);
	// The STORED normalized form (truncate, then normalize), so the value the form posts back is
	// already the value `recordStreamAction` derives — and so `rowKey` groups a row under the same
	// identity the persisted action carries.
	const normalizedLabel = normalizeStoredRecurringLabel(flow.label);

	return {
		rowKey: `${flow.direction}:${normalizedLabel}:${occurrence.dateIso}:${index}`,
		label,
		// Same function and same string as the transaction-label avatars already rendered on `/` and
		// `/transactions`: the widget lands on that viewport, and a second initials rule would give
		// one merchant two different badges side by side.
		initials: getInitials(label),
		category: flow.category,
		direction: flow.direction,
		tier: occurrence.tier,
		occurrenceCount: flow.occurrenceCount,
		cadence: flow.cadence,
		anchorDayOfMonth: flow.anchorDayOfMonth,
		dateIso: occurrence.dateIso,
		status: occurrence.status,
		daysLate: occurrence.daysLate,
		estimatePassed: occurrence.estimatePassed,
		settledKind: occurrence.settledKind,
		amountCents: occurrence.amountCents,
		averageAmountCents: flow.averageAmountCents,
		minAmountCents: flow.minAmountCents,
		maxAmountCents: flow.maxAmountCents,
		variability: getFlowAmountVariability(flow),
		countsInRemainingTotal: occurrence.countsInRemainingTotal,
		appliedActionId: occurrence.appliedActionId,
		actionPayload: {
			direction: flow.direction,
			// Capped the same way recordStreamAction caps, so the value posted back is already the
			// value that gets stored: a payload the write path would silently truncate is a payload
			// whose idempotence check compares a different string than the one on disk.
			// `normalizedLabel` needs no cap of its own — it is derived from an already-capped label.
			normalizedLabel,
			label: truncateStoredLabel(flow.label),
			dueDate: occurrence.dateIso,
			anchorTransactionIds: JSON.stringify(fitAnchorCell(flow.occurrenceIds.slice(-MAX_ANCHOR_IDS)))
		}
	};
}

/**
 * Observation candidates carry the RAW label of the transaction they were built from, so they have
 * to cross the same anonymization boundary as everything else. `anonymizeMerchant` is what makes
 * that straightforward: the candidate type has no category, and the composed form would have needed
 * one recovered by label lookup for no gain.
 */
function toObservationCandidateViews(
	transactions: readonly Transaction[],
	flows: readonly RecurringFlow[]
): { label: string; occurrenceCount: number }[] {
	return listObservationCandidates(transactions, flows).map((candidate) => ({
		label: anonymizeMerchant(candidate.label),
		occurrenceCount: candidate.occurrenceCount
	}));
}

/**
 * Drops the OLDEST anchors until the serialized cell fits `MAX_ANCHOR_CELL_CHARS`.
 *
 * `MAX_ANCHOR_IDS` and `MAX_ANCHOR_ID_CHARS` together already keep the cell inside the budget, so
 * this normally removes nothing. It exists because that is an arithmetic argument about two
 * constants, and the property that actually matters — "the string this function writes is a string
 * the backup validator accepts" — is worth asserting on the string itself. Same direction of
 * degradation as every other anchor truncation here: fewer anchors only weakens the action to
 * label-based matching.
 */
function fitAnchorCell(anchors: readonly string[]): string[] {
	let fitted = [...anchors];
	while (fitted.length > 1 && JSON.stringify(fitted).length > MAX_ANCHOR_CELL_CHARS) {
		fitted = fitted.slice(1);
	}
	return fitted;
}

/**
 * Idempotence tolerance for THIS stream, from the dates of the anchors the user owns.
 *
 * A fixed window cannot work: `occurrenceActionWindowDays` grants 3 days to a weekly stream and 15
 * to a monthly one, so a single value either merges two consecutive weekly occurrences into one
 * action or splits a monthly one. The anchors are that stream's own past occurrences, so their
 * median consecutive interval is the same quantity the domain reads off a detected flow.
 */
function resolveIdempotenceWindowDays(anchorDates: readonly Date[]): number {
	if (anchorDates.length < 2) return FALLBACK_IDEMPOTENCE_WINDOW_DAYS;

	const sorted = [...anchorDates].map(toIsoDate).sort((left, right) => left.localeCompare(right));
	const intervals = sorted
		.slice(1)
		.map((date, index) => daysBetween(sorted[index], date))
		.sort((left, right) => left - right);
	const middle = Math.floor(intervals.length / 2);
	const medianIntervalDays =
		intervals.length % 2 === 0
			? (intervals[middle - 1] + intervals[middle]) / 2
			: intervals[middle];

	// Two anchors on the same day (a split payment, say) give a median of 0, which is not a cadence.
	if (medianIntervalDays <= 0) return FALLBACK_IDEMPOTENCE_WINDOW_DAYS;

	return occurrenceActionWindowDays({ medianIntervalDays });
}

function parseActionKind(raw: string): StreamActionKind {
	if (raw === 'ignore' || raw === 'paid' || raw === 'exclude') return raw;
	throw error(400, m.upcoming_bills_error_invalid_action());
}

function parseDirection(raw: string): FlowDirection {
	if (raw === 'income' || raw === 'expense') return raw;
	throw error(400, m.upcoming_bills_error_invalid_action());
}

function parseDueDate(kind: StreamActionKind, raw: string | null): Date | null {
	// Not trusted to be a string either: a number or an object from a form body would throw a
	// TypeError out of `.trim()` and become a 500. Absent (null/undefined) is a legitimate value —
	// it is what an `exclude` must carry — but anything else is a malformed payload, refused as
	// such rather than silently read as "no due date".
	if (raw !== null && raw !== undefined && typeof raw !== 'string') {
		throw error(400, m.upcoming_bills_error_invalid_date());
	}
	const trimmed = (raw ?? '').trim();

	// An exclude targets the whole stream, so a due date on one is not "extra data" — it is a
	// payload that does not describe the action it claims to be.
	if (kind === 'exclude') {
		if (trimmed) throw error(400, m.upcoming_bills_error_invalid_date());
		return null;
	}

	if (!ISO_DATE_PATTERN.test(trimmed)) throw error(400, m.upcoming_bills_error_invalid_date());
	const parsed = new Date(`${trimmed}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime()) || toIsoDate(parsed) !== trimmed) {
		throw error(400, m.upcoming_bills_error_invalid_date());
	}

	return parsed;
}

function toIsoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function toEpochMs(iso: string): number {
	return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function daysBetween(leftIso: string, rightIso: string): number {
	return Math.round((toEpochMs(rightIso) - toEpochMs(leftIso)) / MS_PER_DAY);
}

function addDaysIso(iso: string, days: number): string {
	return new Date(toEpochMs(iso) + days * MS_PER_DAY).toISOString().slice(0, 10);
}
