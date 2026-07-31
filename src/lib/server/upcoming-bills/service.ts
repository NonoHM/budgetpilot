import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import {
	detectRecurringFlows,
	getFlowAmountVariability,
	getFlowDisplayTier,
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
import { normalizeRecurringLabel } from '$lib/domain/recurrence';
import type { Transaction } from '$lib/domain/transaction';
import { readDashboardDataForRange } from '$lib/server/budget/dashboard';
import { FORECAST_LOOKBACK_MONTHS } from '$lib/server/forecast';
import { anonymizeLabel } from '$lib/server/reports/monthly';
// The single reader of the anchor column, exported from the restore path for exactly this reuse:
// a bare JSON.parse on a hand-edited (or restore-mangled) cell throws, and this column is read on
// every page load of the widget and the month view. Never duplicate it, never inline a parse.
import { parseAnchorTransactionIds } from '$lib/server/backup/import';
import {
	MAX_ANCHOR_IDS,
	MAX_PORTABLE_STRING,
	MAX_RECURRING_STREAM_ACTIONS
} from '$lib/server/backup/schema';
import { prisma } from '$lib/server/db';
import { normalizeId } from '$lib/server/transactions/where';

/**
 * Upcoming-bills server layer: reads the recurring flows out of the user's transactions, projects
 * them into a period, applies the user's persisted per-stream actions, and exposes the three
 * mutations behind those actions.
 *
 * Every raw label leaves this module through `anonymizeLabel` — with ONE deliberate exception, the
 * `actionPayload.label` hidden field, which is not display copy but the value `recordStreamAction`
 * will store, and which must therefore round-trip unchanged (see UpcomingBillRowView).
 */

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Rolling half-window of the widget, in days, on both sides of today (locked decisions 4 & 5). */
const WIDGET_WINDOW_DAYS = 30;
const WIDGET_ROW_LIMIT = 5;

/**
 * Longest a stored id may be. A cuid is 25 characters; 32 leaves room without letting a forged
 * payload push an arbitrarily long string into the `IN (...)` list of the ownership query below.
 */
const MAX_ANCHOR_ID_CHARS = 32;

/**
 * Tolerance used by the idempotence check when deciding whether a stored ignore/paid action already
 * covers the requested due date. Derived from the domain's own window function rather than written
 * as a literal: at record time there is no flow in hand to read a cadence off, so the widest window
 * the domain ever grants is used, which is the clamp ceiling of `occurrenceActionWindowDays`.
 */
const IDEMPOTENCE_WINDOW_DAYS = occurrenceActionWindowDays({ medianIntervalDays: 365 });

type DbActionKind = 'IGNORE' | 'PAID' | 'EXCLUDE';

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
	 * is the one raw value this module lets out, and it never reaches a rendered string.
	 */
	actionPayload: {
		direction: string;
		normalizedLabel: string;
		label: string;
		dueDate: string;
		anchorTransactionIds: string;
	};
}

export interface UpcomingBillsMonthView {
	/** YYYY-MM. */
	month: string;
	todayIso: string;
	isCurrentMonth: boolean;
	isFutureMonth: boolean;
	/** Flows surviving the user's exclusions, all tiers. */
	streamCount: number;
	remainingExpenseCents: number;
	expectedIncomeCents: number;
	/** Date ascending; the page groups them. */
	rows: UpcomingBillRowView[];
	/** Only meaningful when `rows` is empty — computed only then. */
	observationCandidates: { label: string; occurrenceCount: number }[];
}

export interface UpcomingBillsWidgetView {
	/** <= 5; upcoming|overdue only; confirmed|likely tiers only; date ascending. */
	rows: UpcomingBillRowView[];
	overdueCount: number;
	/** Rolling 30-day window, not the calendar month (locked decisions 4 & 5). */
	remainingExpenseCents: number;
	hasStreams: boolean;
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

	// Detection needs its full 12-month lookback whatever period is being displayed (same
	// derivation as loadCashFlowForecast), and the fetch must also cover the displayed period —
	// which for a future month sits entirely after `now`, and for an old month entirely before
	// `lookbackStart`. Hence min/max rather than a single fixed range.
	const lookbackStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - FORECAST_LOOKBACK_MONTHS, now.getUTCDate())
	);
	const from = lookbackStart < monthStart ? lookbackStart : monthStart;
	const to = monthEndExclusive > now ? monthEndExclusive : now;

	const [{ transactions }, actionRows] = await Promise.all([
		readDashboardDataForRange(userId, { from, to, budgetMonth: month }),
		findStreamActions(userId)
	]);

	const actions = toStreamActionInputs(actionRows);
	const flows = detectRecurringFlows(transactions);
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
		streamCount: applyStreamExclusions(flows, actions).length,
		remainingExpenseCents: totals.remainingExpenseCents,
		expectedIncomeCents: totals.expectedIncomeCents,
		rows,
		// Computed only for the empty state it belongs to — and from the PRE-exclusion flow list,
		// because the `claimedIds` filter inside is what keeps a detected stream out of the
		// suggestions. Passing the post-exclusion list would resurface, as "en cours d'observation",
		// exactly the streams the user asked the app to stop detecting.
		observationCandidates: rows.length === 0 ? toObservationCandidateViews(transactions, flows) : []
	};
}

export async function loadUpcomingBillsWidget(userId: string): Promise<UpcomingBillsWidgetView> {
	const now = new Date();
	const todayIso = toIsoDate(now);
	const fromIso = addDaysIso(todayIso, -WIDGET_WINDOW_DAYS);
	const toIsoExclusive = addDaysIso(todayIso, WIDGET_WINDOW_DAYS);

	const lookbackStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - FORECAST_LOOKBACK_MONTHS, now.getUTCDate())
	);
	const windowEnd = new Date(`${toIsoExclusive}T00:00:00.000Z`);

	const [{ transactions }, actionRows] = await Promise.all([
		readDashboardDataForRange(userId, {
			from: lookbackStart,
			to: windowEnd > now ? windowEnd : now,
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
		hasStreams: applyStreamExclusions(flows, actions).length > 0
	};
}

export interface RecordStreamActionInput {
	kind: StreamActionKind;
	direction: string;
	normalizedLabel: string;
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

	// Both columns are varchar(191) on MySQL, and the schema's own doc comments name this function
	// as the cap that makes that safe. Real bank labels do exceed 191 (Transaction.label is
	// @db.Text), so without the slice the same input succeeds on SQLite/PostgreSQL and errors on
	// MySQL under STRICT_TRANS_TABLES — the provider divergence this codebase removes on sight.
	const normalizedLabel = input.normalizedLabel.trim().slice(0, MAX_PORTABLE_STRING);
	if (!normalizedLabel) throw error(400, m.upcoming_bills_error_invalid_action());
	// Falls back to the normalized form rather than storing an empty string: the column is NOT NULL
	// and the backup schema requires `min(1)`, so an empty label would produce a row whose own
	// export cannot be restored.
	const label = (input.label.trim() || normalizedLabel).slice(0, MAX_PORTABLE_STRING);

	const dueDate = parseDueDate(kind, input.dueDate);

	// Sanitize before the ownership query, not after: the sanitized list is what goes into the
	// `IN (...)`, so its size and element length must be bounded here. Truncation keeps the NEWEST
	// anchors (`occurrenceIds` is date-ascending) — the same rule the restore path applies, and for
	// the same reason: dropping old anchors only weakens the action to label-based matching.
	const requestedAnchors = [
		...new Set(
			input.anchorTransactionIds
				.map((id) => (typeof id === 'string' ? id.trim() : ''))
				.filter((id) => id.length > 0 && id.length <= MAX_ANCHOR_ID_CHARS)
		)
	].slice(-MAX_ANCHOR_IDS);
	if (requestedAnchors.length === 0) throw error(400, m.upcoming_bills_error_invalid_stream());

	// Ownership, fail closed. The `userId` conjunct is the whole point of this query: without it a
	// forged (or stale-after-restore) id would be persisted into this user's row and then read back
	// as one of their anchors, which is a cross-user reference. Only ids this user actually owns
	// survive, and if none does the action is refused rather than stored anchor-less.
	const owned = await prisma.transaction.findMany({
		where: { userId, id: { in: requestedAnchors } },
		select: { id: true }
	});
	const ownedIds = new Set(owned.map((transaction) => transaction.id));
	const anchors = requestedAnchors.filter((id) => ownedIds.has(id));
	if (anchors.length === 0) throw error(400, m.upcoming_bills_error_invalid_stream());

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
		return (
			Math.abs(daysBetween(toIsoDate(row.dueDate), toIsoDate(dueDate))) <= IDEMPOTENCE_WINDOW_DAYS
		);
	});
	if (duplicate) return { actionId: duplicate.id };

	// Refuse rather than prune. The backup validator caps a payload at MAX_RECURRING_STREAM_ACTIONS,
	// so an unbounded write path lets a user build a set their OWN export is then refused on — but
	// pruning to make room would silently delete a decision the user made (an excluded stream would
	// reappear with no trace). Refusing is visible, recoverable with one undo, and reachable only
	// far past what detection can produce.
	const total = await prisma.recurringStreamAction.count({ where: { userId } });
	if (total >= MAX_RECURRING_STREAM_ACTIONS) {
		throw error(400, m.upcoming_bills_error_action_limit());
	}

	const created = await prisma.recurringStreamAction.create({
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

	return { actionId: created.id };
}

export async function undoStreamAction(userId: string, actionId: string): Promise<void> {
	const id = normalizeId(actionId);
	if (!id) throw error(404, m.upcoming_bills_error_not_found());

	const result = await prisma.recurringStreamAction.deleteMany({ where: { id, userId } });
	if (result.count === 0) throw error(404, m.upcoming_bills_error_not_found());
}

// ─── Internals ──────────────────────────────────────────────────────────────

type StreamActionRow = {
	id: string;
	kind: DbActionKind;
	direction: string;
	normalizedLabel: string;
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
			anchorTransactionIds: true,
			dueDate: true
		}
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
	const label = anonymizeLabel(flow.label, flow.category);
	const normalizedLabel = normalizeRecurringLabel(flow.label);

	return {
		rowKey: `${flow.direction}:${normalizedLabel}:${occurrence.dateIso}:${index}`,
		label,
		// Same rule and same input string as the transaction-label avatars already rendered on `/`
		// and `/transactions`: the widget lands on that viewport, and a second initials rule would
		// give one merchant two different badges side by side.
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
			// Capped here as well as in recordStreamAction: the form posts these values back, and a
			// payload the write path would silently truncate is a payload whose idempotence check
			// compares a different string than the one that gets stored.
			normalizedLabel: normalizedLabel.slice(0, MAX_PORTABLE_STRING),
			label: flow.label.slice(0, MAX_PORTABLE_STRING),
			dueDate: occurrence.dateIso,
			anchorTransactionIds: JSON.stringify(flow.occurrenceIds.slice(-MAX_ANCHOR_IDS))
		}
	};
}

/**
 * Observation candidates carry the raw label of the transaction they were built from, and the
 * candidate type has no category to anonymize against — so the category is recovered from the
 * transaction that produced the label. A candidate whose label matches no transaction cannot
 * happen (the label IS a transaction's), but the fallback keeps the anonymizer's contract rather
 * than letting a raw label through.
 */
function toObservationCandidateViews(
	transactions: readonly Transaction[],
	flows: readonly RecurringFlow[]
): { label: string; occurrenceCount: number }[] {
	const categoryByLabel = new Map<string, string>();
	for (const transaction of transactions) {
		if (!categoryByLabel.has(transaction.label)) {
			categoryByLabel.set(transaction.label, transaction.category);
		}
	}

	return listObservationCandidates(transactions, flows).map((candidate) => ({
		label: anonymizeLabel(candidate.label, categoryByLabel.get(candidate.label) ?? ''),
		occurrenceCount: candidate.occurrenceCount
	}));
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
