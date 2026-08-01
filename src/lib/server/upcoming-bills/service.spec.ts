import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		transaction: {
			findMany: vi.fn()
		},
		monthlyBudget: {
			findMany: vi.fn()
		},
		categoryNatureMapping: {
			findMany: vi.fn()
		},
		recurringStreamAction: {
			findMany: vi.fn(),
			count: vi.fn(),
			create: vi.fn(),
			deleteMany: vi.fn()
		},
		// The cap check and the insert share one transaction; the mock runs the callback against the
		// same client, which is what the interactive form does.
		$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db.prisma))
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const {
	getCurrentBillsMonth,
	loadUpcomingBillsMonth,
	loadUpcomingBillsWidget,
	recordStreamAction,
	undoStreamAction,
	computeInertActionCutoff,
	computeDetectionLookbackStart,
	MAX_ANCHOR_ID_CHARS
} = await import('./service');
const { MAX_ANCHOR_CELL_CHARS, MAX_ANCHOR_IDS, MAX_PORTABLE_STRING, MAX_RECURRING_STREAM_ACTIONS } =
	await import('$lib/server/backup/schema');
const { STORED_LABEL_MAX_CHARS } = await import('$lib/domain/recurrence');
const { detectRecurringFlows, getFlowDisplayTier } = await import('$lib/domain/forecast');
const { occurrenceActionWindowDays } = await import('$lib/domain/upcomingBills');

const userId = 'user-00000001';
const actionId = 'action-00000001';
/**
 * Kept close enough to the fixtures' last occurrences that none of the streams below is stale (see
 * `isStreamStale`): the recency guard drops a stream that has been silent for longer than one
 * tolerated cycle, so moving this date FORWARD silently empties the views asserted here.
 *
 * The binding constraint is the weekly grocery stream of `plafonne à 5 lignes` (last transaction
 * 2026-07-06, cadence weekly, interval CV 0 -> tolerated silence 7 + 2 + 0 = 9 days): at this
 * `TODAY` it is 8 days silent, so there is exactly ONE day of headroom. A two-day move drops it and
 * that test fails with 3 rows instead of 5. SUBSCRIPTION (last paid 2026-06-10, tolerated silence
 * 36.5 days, 34 days silent here) is the second tightest at 2.5 days, and the uncertain-tier
 * fixture in `upcomingBills.spec.ts` has 2 — this one is not the whole picture, only the smallest.
 */
const TODAY = '2026-07-14T09:00:00.000Z';

// Raw bank labels, exactly the shape anonymizeLabel exists to strip. Asserting these never appear
// in a view object is what proves the anonymization boundary is not bypassed.
const RENT_LABEL = 'PRELEVEMENT SEPA LOYER SCI DUPONT REF9912345';
const SUBSCRIPTION_LABEL = 'CB ABONNEMENT NETFLIX 0712';
const SALARY_LABEL = 'VIREMENT SALAIRE ACME SAS';
const UTILITY_LABEL = 'PRELEVEMENT EDF FACTURE';
const GROCERY_LABEL = 'CB COURSES SUPERMARCHE';

interface RawTransaction {
	id: string;
	date: Date;
	label: string;
	amountCents: number;
	type: string | null;
	source: string;
	manualCategory: string | null;
	natureManual: null;
	category: { name: string };
}

function tx(
	id: string,
	dateIso: string,
	label: string,
	amountCents: number,
	category: string
): RawTransaction {
	return {
		id,
		date: new Date(`${dateIso}T00:00:00.000Z`),
		label,
		amountCents,
		type: amountCents >= 0 ? 'income' : 'expense',
		source: 'csv',
		manualCategory: null,
		natureManual: null,
		category: { name: category }
	};
}

/** Monthly stream: one transaction per month on `day`, oldest first. */
function monthlySeries(
	idPrefix: string,
	label: string,
	amountCents: number,
	category: string,
	months: readonly string[],
	day: string
): RawTransaction[] {
	return months.map((month, index) =>
		tx(`${idPrefix}-${index}`, `${month}-${day}`, label, amountCents, category)
	);
}

const RENT = monthlySeries(
	'rent',
	RENT_LABEL,
	-80_000,
	'Logement',
	['2026-04', '2026-05', '2026-06', '2026-07'],
	'05'
);
const SUBSCRIPTION = monthlySeries(
	'sub',
	SUBSCRIPTION_LABEL,
	-1_399,
	'Loisirs',
	['2026-04', '2026-05', '2026-06'],
	'10'
);
const SALARY = monthlySeries(
	'sal',
	SALARY_LABEL,
	250_000,
	'Revenus',
	['2026-04', '2026-05', '2026-06'],
	'28'
);
/** Stopped in April: still detected from the 12-month lookback, but stale (B1 recency guard). */
const STOPPED_SUBSCRIPTION = monthlySeries(
	'stopped',
	SUBSCRIPTION_LABEL,
	-1_399,
	'Loisirs',
	['2026-02', '2026-03', '2026-04'],
	'10'
);
const INSURANCE_LABEL = 'PRELEVEMENT ASSURANCE HABITATION MAIF';
/**
 * Quarterly, day 20, entirely inside the pinned detection window (which starts 2025-07-14, i.e.
 * 12 months before TODAY): intervals 92/92/90 -> high confidence -> tier 'confirmed'.
 */
const INSURANCE = ['2025-07-20', '2025-10-20', '2026-01-20', '2026-04-20'].map((date, index) =>
	tx(`ins-${index}`, date, INSURANCE_LABEL, -12_000, 'Assurance')
);
/**
 * The same stream, 15 days before its first in-window occurrence: inside the VIEWED month 2025-07,
 * outside the 12-month detection window. It is the whole point of the fixture — including it turns
 * the interval series into 15/92/92/90, which drops the confidence a tier.
 */
const INSURANCE_PRE_WINDOW = tx('ins-pre', '2025-07-05', INSURANCE_LABEL, -12_000, 'Assurance');

/** Exactly two occurrences -> 'tentative' -> uncertain tier. */
const UTILITY = monthlySeries(
	'edf',
	UTILITY_LABEL,
	-6_000,
	'Énergie',
	['2026-05', '2026-06'],
	'15'
);

function mockRead(transactions: readonly RawTransaction[], actions: readonly unknown[] = []) {
	db.prisma.transaction.findMany.mockResolvedValue([...transactions]);
	db.prisma.monthlyBudget.findMany.mockResolvedValue([]);
	db.prisma.categoryNatureMapping.findMany.mockResolvedValue([]);
	db.prisma.recurringStreamAction.findMany.mockResolvedValue([...actions]);
}

type TransactionQuery = { where?: { date?: { gte?: Date; lt?: Date } } };

/**
 * Range-aware read mock: applies the query's OWN date bounds, unlike `mockRead`, which hands back
 * every fixture whatever range was asked for.
 *
 * That distinction is what makes the detection-window test below non-vacuous. Under a range-blind
 * mock, every surface sees every fixture transaction, so the old widening code would report the same
 * tier everywhere and the test would pass on the bug it exists to catch.
 */
function mockRangedRead(transactions: readonly RawTransaction[], actions: readonly unknown[] = []) {
	db.prisma.transaction.findMany.mockImplementation(async (query: TransactionQuery) => {
		const range = query?.where?.date;
		// Fail loudly rather than return everything: an unbounded read would silently restore the
		// range-blind behaviour this helper exists to avoid.
		if (!(range?.gte instanceof Date) || !(range?.lt instanceof Date)) {
			throw new Error('la lecture des transactions doit porter des bornes de dates');
		}
		const gte = range.gte;
		const lt = range.lt;
		return transactions.filter((transaction) => transaction.date >= gte && transaction.date < lt);
	});
	db.prisma.monthlyBudget.findMany.mockResolvedValue([]);
	db.prisma.categoryNatureMapping.findMany.mockResolvedValue([]);
	db.prisma.recurringStreamAction.findMany.mockResolvedValue([...actions]);
}

function storedAction(overrides: Record<string, unknown> = {}) {
	return {
		id: actionId,
		kind: 'IGNORE',
		direction: 'expense',
		normalizedLabel: 'cb abonnement netflix',
		// The RAW stored label, as the column holds it: the excluded-streams section reads it and has
		// to anonymize it, so a fixture carrying an already-clean label could not prove that.
		label: SUBSCRIPTION_LABEL,
		anchorTransactionIds: JSON.stringify(['sub-0', 'sub-1', 'sub-2']),
		dueDate: new Date('2026-07-10T00:00:00.000Z'),
		...overrides
	};
}

/** The shape of the prune's `where`, as `recordStreamAction` builds it. */
interface PruneWhere {
	userId: string;
	kind: { in: string[] };
	dueDate: { lt: Date };
}

interface PrunableRow {
	userId: string;
	kind: string;
	dueDate: Date | null;
}

/**
 * Runs the prune's own `where` against rows, with the engine's semantics — in particular that a
 * NULL `dueDate` satisfies no comparison, which is the second of the two things keeping an EXCLUDE
 * out of the delete.
 *
 * Deliberately not a shape assertion on the clause. A predicate that reaches an EXCLUDE is exactly
 * what this half of the task must forbid, and "the object equals this object" cannot fail for the
 * reason that matters — it fails for every reason at once. This EXECUTES the clause and reports
 * which rows it would take.
 */
function applyPruneWhere(rows: readonly PrunableRow[], where: PruneWhere): PrunableRow[] {
	return rows.filter(
		(row) =>
			row.userId === where.userId &&
			where.kind.in.includes(row.kind) &&
			row.dueDate !== null &&
			row.dueDate.getTime() < where.dueDate.lt.getTime()
	);
}

async function expectHttpError(promise: Promise<unknown>, status: number) {
	await expect(promise).rejects.toMatchObject({ status });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date(TODAY));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('getCurrentBillsMonth', () => {
	// Pinned against a REVERT to the local-clock `getCurrentMonth()`, which nothing else would catch:
	// `isCurrentMonth` / `isFutureMonth` are derived from a UTC `todayIso`, so a local-month default
	// makes the load resolve one month while the view labels it another — the page loses "Ce mois"
	// and renders "Revenir à ce mois" as a link to the page it is already on.
	//
	// The timezone has to be moved for the assertion to mean anything: on a UTC host both
	// implementations agree at every instant, and this test would pass on the broken one. Node
	// re-reads `process.env.TZ` on assignment (tzset), so the swap takes effect in-process.
	const originalTz = process.env.TZ;

	afterEach(() => {
		if (originalTz === undefined) delete process.env.TZ;
		else process.env.TZ = originalTz;
	});

	it('rend le mois UTC, pas le mois local, à la bascule de minuit sur un hôte à décalage positif', () => {
		process.env.TZ = 'Europe/Paris';
		vi.setSystemTime(new Date('2026-07-31T23:30:00.000Z'));

		// The host clock really is on the next month locally — otherwise the assertion below is
		// vacuous, which is the exact failure mode this test exists to avoid.
		expect(new Date().getMonth() + 1).toBe(8);
		expect(getCurrentBillsMonth()).toBe('2026-07');
	});
});

describe('loadUpcomingBillsMonth', () => {
	it('projette le mois: réalisé auto-réglé, retard et à venir, avec les totaux', async () => {
		mockRead([...RENT, ...SUBSCRIPTION, ...SALARY]);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');

		expect(view.month).toBe('2026-07');
		expect(view.todayIso).toBe('2026-07-14');
		expect(view.isCurrentMonth).toBe(true);
		expect(view.isFutureMonth).toBe(false);
		expect(view.streamCount).toBe(3);

		expect(view.rows.map((row) => [row.dateIso, row.status])).toEqual([
			['2026-07-05', 'settled'],
			['2026-07-10', 'overdue'],
			['2026-07-28', 'upcoming']
		]);

		const [rent, subscription, salary] = view.rows;
		expect(rent.settledKind).toBe('auto');
		expect(rent.amountCents).toBe(-80_000);
		expect(rent.countsInRemainingTotal).toBe(false);
		expect(subscription.daysLate).toBe(4);
		expect(subscription.tier).toBe('confirmed');
		expect(salary.direction).toBe('income');

		// Only the still-open expense counts; income is never netted against it.
		expect(view.remainingExpenseCents).toBe(1_399);
		expect(view.expectedIncomeCents).toBe(250_000);
		// Rows exist, so the observation list is not even computed.
		expect(view.observationCandidates).toEqual([]);
	});

	it('scope la lecture des transactions et des actions sur userId', async () => {
		mockRead(RENT);

		await loadUpcomingBillsMonth(userId, '2026-07');

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ userId }) })
		);
		expect(db.prisma.recurringStreamAction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId } })
		);
	});

	it('anonymise les libellés affichés et garde le libellé brut dans le seul payload d’action', async () => {
		mockRead(SUBSCRIPTION);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');
		const row = view.rows[0];

		expect(row.label).not.toContain('NETFLIX');
		// The merchant alone: the category is its own field and the design prints it in the row's
		// sub-line, so the composed anonymizeLabel form would show "Loisirs" twice per row.
		expect(row.label).toBe('Netflix');
		expect(row.label).not.toContain(row.category);
		// getInitials over exactly the string the surface displays. With the merchant alone a
		// single-word one gives a sane badge; the composed "Netflix - Loisirs" gave "N-", because
		// getInitials reads the hyphen as a word.
		expect(row.initials).toBe('N');
		// The hidden field is the value recordStreamAction will store, not display copy.
		expect(row.actionPayload.label).toBe(SUBSCRIPTION_LABEL);
		expect(row.actionPayload.normalizedLabel).toBe('cb abonnement netflix');
		expect(JSON.parse(row.actionPayload.anchorTransactionIds)).toEqual(['sub-0', 'sub-1', 'sub-2']);
	});

	it('applique une action ignore stockée à l’occurrence correspondante', async () => {
		mockRead([...SUBSCRIPTION], [storedAction()]);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');
		const row = view.rows.find((candidate) => candidate.dateIso === '2026-07-10');

		expect(row?.status).toBe('ignored');
		expect(row?.appliedActionId).toBe(actionId);
		expect(view.remainingExpenseCents).toBe(0);
	});

	it('retire du décompte de flux un stream exclu', async () => {
		mockRead(
			[...RENT, ...SUBSCRIPTION],
			[storedAction({ kind: 'EXCLUDE', dueDate: null, id: 'action-exclude' })]
		);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');

		expect(view.streamCount).toBe(1);
		expect(view.rows.every((row) => row.category !== 'Loisirs')).toBe(true);
	});

	// T5-c: the anchor column is user-restorable data read on a page load.
	it('tolère une cellule anchorTransactionIds malformée (jamais de throw)', async () => {
		mockRead(SUBSCRIPTION, [
			storedAction({ anchorTransactionIds: 'not json' }),
			storedAction({ id: 'action-2', anchorTransactionIds: '{"a":1}' })
		]);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');

		// Anchors degraded to [], so matching falls back to direction + normalized label and the
		// action still lands — the point is that nothing threw.
		expect(view.rows).toHaveLength(1);
		expect(view.rows[0].status).toBe('ignored');
	});

	it('ne propose des candidats en observation que quand aucune ligne n’existe, anonymisés', async () => {
		// Two same-amount transactions 45 days apart: no cadence window matches, so no flow claims
		// them and they surface as an observation candidate instead.
		mockRead([
			tx('obs-0', '2026-05-01', UTILITY_LABEL, -6_000, 'Énergie'),
			tx('obs-1', '2026-06-15', UTILITY_LABEL, -6_000, 'Énergie')
		]);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');

		expect(view.rows).toEqual([]);
		expect(view.observationCandidates).toEqual([{ label: 'Edf Facture', occurrenceCount: 2 }]);
	});

	/**
	 * B3-b. An exclusion removes the stream from every list, so without this the user has no way to
	 * see (let alone undo) a decision the app treats as permanent.
	 */
	it('expose les flux exclus, anonymisés, avec l’id de l’action à annuler', async () => {
		mockRead(SUBSCRIPTION, [
			storedAction({ kind: 'EXCLUDE', dueDate: null }),
			// Not an exclusion: it must not appear in the escape hatch.
			storedAction({ id: 'action-2', kind: 'IGNORE' })
		]);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');

		// One-word label -> one initial, the same rule `getInitials` applies to every avatar in the app.
		expect(view.excludedStreams).toEqual([{ actionId, label: 'Netflix', initials: 'N' }]);
		// The raw bank label never leaves the module, here as everywhere else.
		expect(JSON.stringify(view.excludedStreams)).not.toContain(SUBSCRIPTION_LABEL);
		// And the exclusion still does its job: the stream is gone from the rows.
		expect(view.rows).toEqual([]);
		expect(view.streamCount).toBe(0);
	});

	it('liste les flux exclus du plus ancien au plus récent', async () => {
		// Documented as oldest-first, which is a claim about the QUERY's ordering as much as about the
		// mapping: `findStreamActions` sorts by createdAt then id, and the section renders in that
		// order. Both halves asserted, because the mock preserves whatever order it is handed and the
		// mapping alone would look correct under any sort.
		mockRead(SUBSCRIPTION, [
			storedAction({ id: 'action-old', kind: 'EXCLUDE', dueDate: null }),
			storedAction({ id: 'action-new', kind: 'EXCLUDE', dueDate: null })
		]);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');

		expect(view.excludedStreams.map((stream) => stream.actionId)).toEqual([
			'action-old',
			'action-new'
		]);
		expect(db.prisma.recurringStreamAction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId },
				orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
			})
		);
	});

	it('liste un flux exclu dont la direction stockée est illisible', async () => {
		// `toStreamActionInputs` drops such a row rather than applying it to the wrong side of the
		// budget. It must still be LISTED, or the user holds a decision they can neither use nor
		// delete.
		mockRead(SUBSCRIPTION, [storedAction({ kind: 'EXCLUDE', direction: 'both', dueDate: null })]);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');

		expect(view.excludedStreams.map((stream) => stream.actionId)).toEqual([actionId]);
	});

	it('rend une occurrence marquée payée comme réglée manuellement', async () => {
		mockRead(SUBSCRIPTION, [
			storedAction({ kind: 'PAID', dueDate: new Date('2026-07-10T00:00:00.000Z') })
		]);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');
		const row = view.rows.find((candidate) => candidate.dateIso === '2026-07-10');

		expect(row?.status).toBe('settled');
		expect(row?.settledKind).toBe('manual');
		expect(row?.countsInRemainingTotal).toBe(false);
		expect(row?.appliedActionId).toBe(actionId);
		expect(row?.daysLate).toBeNull();
		expect(view.remainingExpenseCents).toBe(0);
	});

	it('rend un mois passé: uniquement des lignes réglées, plus rien à payer', async () => {
		mockRead([...RENT, ...SUBSCRIPTION]);

		const view = await loadUpcomingBillsMonth(userId, '2026-05');

		expect(view.isCurrentMonth).toBe(false);
		expect(view.isFutureMonth).toBe(false);
		expect(view.rows.map((row) => [row.dateIso, row.status])).toEqual([
			['2026-05-05', 'settled'],
			['2026-05-10', 'settled']
		]);
		expect(view.rows.every((row) => row.settledKind === 'auto')).toBe(true);
		expect(view.remainingExpenseCents).toBe(0);
		expect(view.expectedIncomeCents).toBe(0);
	});

	it('rend un mois futur: uniquement des projections à venir', async () => {
		mockRead([...RENT, ...SUBSCRIPTION, ...SALARY]);

		const view = await loadUpcomingBillsMonth(userId, '2026-09');

		expect(view.isFutureMonth).toBe(true);
		expect(view.isCurrentMonth).toBe(false);
		expect(view.rows.length).toBeGreaterThan(0);
		expect(view.rows.every((row) => row.status === 'upcoming')).toBe(true);
		expect(view.rows.every((row) => row.dateIso.startsWith('2026-09'))).toBe(true);
		expect(view.remainingExpenseCents).toBeGreaterThan(0);
	});

	// B1: a stream that stopped months ago is still detected from the 12-month lookback, and used to
	// project one "En retard" occurrence per month forever — inflating a total the user reads as a
	// balance. It now drops out silently: no row, nothing in the totals, and no new user-facing
	// concept. `streamCount` deliberately still counts it, since it is what tells the page a stream
	// has ever been detected (the alternative walls the period navigator off entirely).
	it('cesse de projeter un abonnement résilié, sans rien signaler à l’utilisateur', async () => {
		mockRead(STOPPED_SUBSCRIPTION);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');

		expect(view.rows).toEqual([]);
		expect(view.remainingExpenseCents).toBe(0);
		expect(view.expectedIncomeCents).toBe(0);
		expect(view.streamCount).toBe(1);
		// The guard makes `rows.length === 0` a common state, so it routinely reaches the branch that
		// computes the "en observation" list. The stopped stream's own transactions are claimed by the
		// detected flow, so it must not resurface there as a suggestion either.
		expect(view.observationCandidates).toEqual([]);
	});

	it('refuse un mois malformé avant toute requête', async () => {
		await expectHttpError(loadUpcomingBillsMonth(userId, '2026-13'), 400);
		await expectHttpError(loadUpcomingBillsMonth(userId, 'juillet'), 400);
		expect(db.prisma.transaction.findMany).not.toHaveBeenCalled();
	});
});

describe('loadUpcomingBillsWidget', () => {
	it('ne garde que les échéances ouvertes et fiables de la fenêtre glissante', async () => {
		mockRead([...RENT, ...SUBSCRIPTION, ...SALARY, ...UTILITY]);

		const view = await loadUpcomingBillsWidget(userId);

		expect(view.todayIso).toBe('2026-07-14');
		expect(view.hasStreams).toBe(true);
		expect(view.rows.map((row) => [row.dateIso, row.status])).toEqual([
			['2026-07-10', 'overdue'],
			['2026-07-28', 'upcoming'],
			['2026-08-05', 'upcoming'],
			['2026-08-10', 'upcoming']
		]);
		// The uncertain-tier stream (2 occurrences) is detected but never shown here...
		expect(view.rows.every((row) => row.tier !== 'uncertain')).toBe(true);
		// ...and the already-realized rent occurrence of 2026-07-05 is settled, so it is gone too.
		expect(view.rows.some((row) => row.status === 'settled')).toBe(false);
		expect(view.overdueCount).toBe(1);
		expect(view.remainingExpenseCents).toBe(1_399 + 80_000 + 1_399);
	});

	// The widget's other tests assert outcomes only, so its isolation would rest on sharing a
	// helper with the month describe. Asserted here on its own queries.
	it('scope ses deux requêtes sur userId', async () => {
		mockRead(SUBSCRIPTION);

		await loadUpcomingBillsWidget(userId);

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ userId }) })
		);
		expect(db.prisma.recurringStreamAction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId } })
		);
	});

	it('plafonne à 5 lignes mais compte les retards et le total sur tout l’ensemble retenu', async () => {
		// A weekly stream tolerates only 9 days of silence, so it can carry at most one late
		// occurrence on its own: the surplus beyond the 5 displayed rows comes from stacking it with
		// the two monthly streams, not from letting one stream rot for a month.
		const weekly = ['2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06'].map((date, index) =>
			tx(`groc-${index}`, date, GROCERY_LABEL, -5_000, 'Alimentation')
		);
		mockRead([...weekly, ...RENT, ...SUBSCRIPTION]);

		const view = await loadUpcomingBillsWidget(userId);

		expect(view.rows).toHaveLength(5);
		expect(view.rows.map((row) => row.dateIso)).toEqual([
			'2026-07-10',
			'2026-07-13',
			'2026-07-20',
			'2026-07-27',
			'2026-08-03'
		]);
		// 8 occurrences survive the filter; 2 of them are late and all 8 are in the total.
		expect(view.overdueCount).toBe(2);
		expect(view.remainingExpenseCents).toBe(5 * 5_000 + 80_000 + 2 * 1_399);
		// rowKey stays unique even when one stream fills most of the list.
		expect(new Set(view.rows.map((row) => row.rowKey)).size).toBe(5);
	});

	// The widget carries the "N en retard" badge, which is the surface the stale rows inflated.
	// `hasStreams` stays true: the stream exists, it simply has nothing left to schedule, and the
	// card's "aucun stream détecté" empty state would be a different (wrong) claim.
	it('vide la carte d’un abonnement résilié sans annoncer de retard', async () => {
		mockRead(STOPPED_SUBSCRIPTION);

		const view = await loadUpcomingBillsWidget(userId);

		expect(view.hasStreams).toBe(true);
		expect(view.rows).toEqual([]);
		expect(view.overdueCount).toBe(0);
		expect(view.remainingExpenseCents).toBe(0);
	});

	it('signale l’absence de stream quand tout est exclu', async () => {
		mockRead(SUBSCRIPTION, [
			storedAction({ kind: 'EXCLUDE', dueDate: null, id: 'action-exclude' })
		]);

		const view = await loadUpcomingBillsWidget(userId);

		expect(view.hasStreams).toBe(false);
		expect(view.rows).toEqual([]);
		expect(view.remainingExpenseCents).toBe(0);
	});
});

/**
 * B2: the detector's input is the 12 months before TODAY on every surface. `loadUpcomingBillsMonth`
 * used to widen it to `min(lookbackStart, monthStart)`, so viewing a month older than the lookback
 * fed the detector history the widget never sees — and detection is not monotonic in its input, so
 * the same stream could read "Confirmé" on one screen and "Probable" on another.
 */
describe('fenêtre de détection figée à 12 mois', () => {
	/**
	 * Anti-vacuity guard, asserted on the domain rather than on the views: it pins the property the
	 * test below depends on — that the pre-window transaction really would change the tier. A fixture
	 * edit that makes both sets score the same tier fails HERE, instead of turning the consistency
	 * test into an assertion about nothing.
	 */
	it('le relevé hors fenêtre changerait bien le tier (garde anti-vacuité)', () => {
		const toForecastInput = (transaction: RawTransaction) => ({
			id: transaction.id,
			date: transaction.date.toISOString().slice(0, 10),
			label: transaction.label,
			amountCents: transaction.amountCents,
			category: transaction.category.name,
			type: 'expense' as const
		});

		const [pinned] = detectRecurringFlows(INSURANCE.map(toForecastInput));
		const [widened] = detectRecurringFlows(
			[...INSURANCE, INSURANCE_PRE_WINDOW].map(toForecastInput)
		);

		expect(getFlowDisplayTier(pinned)).toBe('confirmed');
		expect(getFlowDisplayTier(widened)).toBe('likely');
	});

	it('rend le même tier pour le mois courant, un mois ancien et le widget', async () => {
		mockRangedRead([...INSURANCE, INSURANCE_PRE_WINDOW]);

		const current = await loadUpcomingBillsMonth(userId, '2026-07');
		// 2025-07 is the first month that reaches BEHIND the lookback start (2025-07-14), which is
		// exactly where the old widening began.
		const past = await loadUpcomingBillsMonth(userId, '2025-07');
		const widget = await loadUpcomingBillsWidget(userId);

		// The old month's FETCH still reaches the pre-window transaction — the row source is untouched
		// and it is the detection input that is pinned. Without this, a narrowed fetch would produce
		// the same tiers for the wrong reason.
		const pastQuery = db.prisma.transaction.findMany.mock.calls[1][0] as TransactionQuery;
		expect(pastQuery.where?.date?.gte?.toISOString().slice(0, 10)).toBe('2025-07-01');

		expect(current.rows.map((row) => [row.dateIso, row.status, row.tier])).toEqual([
			['2026-07-20', 'upcoming', 'confirmed']
		]);
		// The past month still renders its settled row, and reads the same tier as everywhere else.
		expect(past.rows.map((row) => [row.dateIso, row.status, row.tier])).toEqual([
			['2025-07-20', 'settled', 'confirmed']
		]);
		expect(widget.rows.map((row) => [row.dateIso, row.status, row.tier])).toEqual([
			['2026-07-20', 'upcoming', 'confirmed']
		]);
	});

	// `listObservationCandidates` surfaces the pairs THE DETECTOR REJECTED, filtered by the ids the
	// detected flows claim. Handing it the wide fetch while the detector only saw the pinned set
	// breaks that contract from the other side: a pre-window pair the detector was never shown would
	// be presented as "en cours d'observation", i.e. as a stream the engine is about to confirm.
	it('ne propose pas en observation une paire que le détecteur n’a jamais vue', async () => {
		// 45 days apart: no cadence window matches, so nothing claims them — exactly the shape the
		// observation list is made of. Both sit before the lookback start (2025-07-14).
		const preWindowPair = ['2025-04-10', '2025-05-25'].map((date, index) =>
			tx(`obs-${index}`, date, 'CB VETERINAIRE DES LILAS', -8_400, 'Santé')
		);
		mockRangedRead([...INSURANCE, ...preWindowPair]);

		const view = await loadUpcomingBillsMonth(userId, '2025-04');

		// The pair really was fetched for this month — otherwise the assertion below holds for the
		// wrong reason.
		const query = db.prisma.transaction.findMany.mock.calls[0][0] as TransactionQuery;
		expect(query.where?.date?.gte?.toISOString().slice(0, 10)).toBe('2025-04-01');
		// The empty state is reached, so the list is genuinely computed and not skipped.
		expect(view.rows).toEqual([]);
		expect(view.observationCandidates).toEqual([]);
	});

	// The surprise itself, pinned: a month entirely older than the lookback renders nothing while the
	// stream count stays non-zero. That pair of facts is what makes the page's `nothingDueThisPeriod`
	// copy a false claim there, and what `oldestNavigableMonth` exists to keep unreachable — a change
	// in EITHER direction (rows appearing, or the count collapsing to 0) would otherwise be silent.
	it('rend un mois antérieur à la fenêtre entièrement vide, en gardant streamCount > 0', async () => {
		const beforeWindow = ['2024-05-03', '2024-06-03', '2024-07-03'].map((date, index) =>
			tx(`old-${index}`, date, RENT_LABEL, -80_000, 'Logement')
		);
		mockRangedRead([...INSURANCE, ...beforeWindow]);

		const view = await loadUpcomingBillsMonth(userId, '2024-06');

		expect(view.rows).toEqual([]);
		expect(view.streamCount).toBeGreaterThan(0);
		// The boundary the page navigator stops at, so the state above cannot be navigated to.
		expect(view.oldestNavigableMonth).toBe('2025-07');
	});
});

/** Monthly cadence: window = floor(30/2) = 15 days. */
const MONTHLY_ANCHOR_DATES = ['2026-04-10', '2026-05-10', '2026-06-10'] as const;
/** Weekly cadence: window = floor(7/2) = 3 days, so two taps 7 days apart must both persist. */
const WEEKLY_ANCHOR_DATES = ['2026-06-25', '2026-07-02', '2026-07-09'] as const;

describe('recordStreamAction', () => {
	function input(overrides: Partial<Parameters<typeof recordStreamAction>[1]> = {}) {
		return {
			kind: 'ignore' as const,
			direction: 'expense',
			// No normalizedLabel: it is derived server-side from `label`, never accepted as input.
			label: SUBSCRIPTION_LABEL,
			dueDate: '2026-07-10',
			anchorTransactionIds: ['sub-0', 'sub-1', 'sub-2'],
			...overrides
		};
	}

	/**
	 * Owned anchor rows as the ownership query returns them: `date` is selected too, because the
	 * idempotence window is derived from the median interval between these dates.
	 */
	function owned(ids: readonly string[], dates: readonly string[] = MONTHLY_ANCHOR_DATES) {
		return ids.map((id, index) => ({
			id,
			date: new Date(`${dates[index % dates.length]}T00:00:00.000Z`)
		}));
	}

	beforeEach(() => {
		db.prisma.recurringStreamAction.findMany.mockResolvedValue([]);
		db.prisma.recurringStreamAction.count.mockResolvedValue(0);
		db.prisma.recurringStreamAction.create.mockResolvedValue({ id: 'created-1' });
	});

	/** The `where` of the single prune the write path issues. */
	function pruneWhere(): PruneWhere {
		expect(db.prisma.recurringStreamAction.deleteMany).toHaveBeenCalledTimes(1);
		return db.prisma.recurringStreamAction.deleteMany.mock.calls[0][0].where;
	}

	// T5-b: the anchor list must never reach SQL without a userId conjunct.
	it('filtre les ancres sur userId et ne persiste que celles que l’utilisateur possède', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0', 'sub-2']));

		const result = await recordStreamAction(
			userId,
			input({ anchorTransactionIds: ['sub-0', 'foreign-1', 'sub-2'] })
		);

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith({
			where: { userId, id: { in: ['sub-0', 'foreign-1', 'sub-2'] } },
			select: { id: true, date: true }
		});
		expect(result).toEqual({ actionId: 'created-1' });
		const created = db.prisma.recurringStreamAction.create.mock.calls[0][0];
		expect(JSON.parse(created.data.anchorTransactionIds)).toEqual(['sub-0', 'sub-2']);
	});

	it('refuse (400) une action dont aucune ancre n’appartient à l’utilisateur', async () => {
		db.prisma.transaction.findMany.mockResolvedValue([]);

		await expectHttpError(
			recordStreamAction(userId, input({ anchorTransactionIds: ['foreign-1', 'foreign-2'] })),
			400
		);
		expect(db.prisma.recurringStreamAction.create).not.toHaveBeenCalled();
	});

	it('refuse (400) une action sans aucune ancre, sans interroger la base', async () => {
		await expectHttpError(recordStreamAction(userId, input({ anchorTransactionIds: [] })), 400);
		expect(db.prisma.transaction.findMany).not.toHaveBeenCalled();
	});

	// T5-a: both columns are varchar(191) on MySQL.
	it('accepte 191 caractères intacts et tronque 192 sans lever', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));

		await recordStreamAction(
			userId,
			input({ label: 'a'.repeat(MAX_PORTABLE_STRING), anchorTransactionIds: ['sub-0'] })
		);
		const exact = db.prisma.recurringStreamAction.create.mock.calls[0][0].data;
		expect(exact.label).toBe('a'.repeat(MAX_PORTABLE_STRING));
		// Derived from the stored label, so it is capped by construction as well as by its own slice.
		expect(exact.normalizedLabel).toBe('a'.repeat(MAX_PORTABLE_STRING));

		await recordStreamAction(
			userId,
			input({ label: 'a'.repeat(MAX_PORTABLE_STRING + 1), anchorTransactionIds: ['sub-0'] })
		);
		const truncated = db.prisma.recurringStreamAction.create.mock.calls[1][0].data;
		expect(truncated.label).toHaveLength(MAX_PORTABLE_STRING);
		expect(truncated.normalizedLabel).toHaveLength(MAX_PORTABLE_STRING);
	});

	// P2: normalizedLabel is the fallback half of the stream identity, so a client-supplied value
	// would be a way to aim an action at a stream the user never acted on.
	it('dérive normalizedLabel du libellé stocké et ignore toute valeur fournie', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));

		await recordStreamAction(userId, {
			...input({ anchorTransactionIds: ['sub-0'] }),
			// A forged extra field: the input type has no normalizedLabel, and nothing reads one.
			normalizedLabel: 'loyer sci dupont'
		} as Parameters<typeof recordStreamAction>[1]);

		const data = db.prisma.recurringStreamAction.create.mock.calls[0][0].data;
		expect(data.label).toBe(SUBSCRIPTION_LABEL);
		expect(data.normalizedLabel).toBe('cb abonnement netflix');
		expect(data.normalizedLabel).not.toBe('loyer sci dupont');
	});

	// T5-e: same truncation rule as the restore path, newest kept.
	it('tronque les ancres aux MAX_ANCHOR_IDS plus récentes', async () => {
		const anchors = Array.from({ length: MAX_ANCHOR_IDS + 40 }, (_, index) => `anchor-${index}`);
		db.prisma.transaction.findMany.mockImplementation(
			async ({ where }: { where: { id: { in: string[] } } }) => owned(where.id.in)
		);

		await recordStreamAction(userId, input({ anchorTransactionIds: anchors }));

		const queried = db.prisma.transaction.findMany.mock.calls[0][0].where.id.in;
		expect(queried).toHaveLength(MAX_ANCHOR_IDS);
		expect(queried[MAX_ANCHOR_IDS - 1]).toBe(`anchor-${anchors.length - 1}`);
		const stored = JSON.parse(
			db.prisma.recurringStreamAction.create.mock.calls[0][0].data.anchorTransactionIds
		);
		expect(stored).toHaveLength(MAX_ANCHOR_IDS);
		expect(stored[MAX_ANCHOR_IDS - 1]).toBe(`anchor-${anchors.length - 1}`);
	});

	// A4: the window must follow the stream's own cadence, not a fixed 15 days.
	it('dérive la fenêtre d’idempotence de la cadence réelle des ancres', async () => {
		// Weekly stream: two ignores 7 days apart are two DIFFERENT occurrences (window 3), where a
		// fixed 15-day window swallowed the second one and wrote no row — the tap looked broken.
		db.prisma.transaction.findMany.mockResolvedValue(
			owned(['w-0', 'w-1', 'w-2'], WEEKLY_ANCHOR_DATES)
		);
		db.prisma.recurringStreamAction.findMany.mockResolvedValue([
			storedAction({
				anchorTransactionIds: JSON.stringify(['w-0', 'w-1', 'w-2']),
				dueDate: new Date('2026-07-16T00:00:00.000Z')
			})
		]);

		const result = await recordStreamAction(
			userId,
			input({ dueDate: '2026-07-23', anchorTransactionIds: ['w-0', 'w-1', 'w-2'] })
		);

		expect(result).toEqual({ actionId: 'created-1' });
		expect(db.prisma.recurringStreamAction.create).toHaveBeenCalledTimes(1);
	});

	it('garde l’idempotence à l’intérieur de la fenêtre hebdomadaire', async () => {
		// Same weekly stream, same occurrence re-tapped one day later (1 <= 3): still one row.
		db.prisma.transaction.findMany.mockResolvedValue(
			owned(['w-0', 'w-1', 'w-2'], WEEKLY_ANCHOR_DATES)
		);
		db.prisma.recurringStreamAction.findMany.mockResolvedValue([
			storedAction({
				anchorTransactionIds: JSON.stringify(['w-0', 'w-1', 'w-2']),
				dueDate: new Date('2026-07-16T00:00:00.000Z')
			})
		]);

		const result = await recordStreamAction(
			userId,
			input({ dueDate: '2026-07-17', anchorTransactionIds: ['w-0', 'w-1', 'w-2'] })
		);

		expect(result).toEqual({ actionId });
		expect(db.prisma.recurringStreamAction.create).not.toHaveBeenCalled();
	});

	it('retombe sur la fenêtre par défaut avec une seule ancre', async () => {
		// One anchor -> no interval to measure -> the 15-day ceiling, so 2026-07-20 still matches the
		// stored 2026-07-10.
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));
		db.prisma.recurringStreamAction.findMany.mockResolvedValue([
			storedAction({ anchorTransactionIds: JSON.stringify(['sub-0']) })
		]);

		const result = await recordStreamAction(
			userId,
			input({ dueDate: '2026-07-20', anchorTransactionIds: ['sub-0'] })
		);

		expect(result).toEqual({ actionId });
	});

	// A5: bound what is WRITTEN, not only what is accepted.
	it('écrit une cellule d’ancres que le validateur de sauvegarde accepte', async () => {
		const anchors = Array.from({ length: MAX_ANCHOR_IDS }, (_, index) =>
			`c${index}`.padEnd(MAX_ANCHOR_ID_CHARS, 'x')
		);
		db.prisma.transaction.findMany.mockImplementation(
			async ({ where }: { where: { id: { in: string[] } } }) => owned(where.id.in)
		);

		await recordStreamAction(userId, input({ anchorTransactionIds: anchors }));

		const cell = db.prisma.recurringStreamAction.create.mock.calls[0][0].data
			.anchorTransactionIds as string;
		// The property the backup validator enforces on the way back in. Mirrors the assertion the
		// restore path already carries, but on the string THIS path writes.
		expect(cell.length).toBeLessThanOrEqual(MAX_ANCHOR_CELL_CHARS);
		expect(JSON.parse(cell)).toHaveLength(MAX_ANCHOR_IDS);
	});

	it('écarte une ancre trop longue, et refuse si c’était la seule', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));

		await recordStreamAction(userId, input({ anchorTransactionIds: ['sub-0', 'z'.repeat(33)] }));
		const queried = db.prisma.transaction.findMany.mock.calls[0][0].where.id.in;
		expect(queried).toEqual(['sub-0']);

		vi.clearAllMocks();
		await expectHttpError(
			recordStreamAction(userId, input({ anchorTransactionIds: ['z'.repeat(33)] })),
			400
		);
		expect(db.prisma.transaction.findMany).not.toHaveBeenCalled();
	});

	// A7: a cut inside a surrogate pair leaves a malformed string.
	it('ne coupe jamais au milieu d’une paire de surrogates', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));

		// 190 BMP characters then an emoji: cutting at 191 code units would split it.
		const label = `${'Loyer '.repeat(31)}abcd🙂`;
		expect(label.length).toBeGreaterThan(STORED_LABEL_MAX_CHARS);

		await recordStreamAction(userId, input({ label, anchorTransactionIds: ['sub-0'] }));

		const stored = db.prisma.recurringStreamAction.create.mock.calls[0][0].data.label as string;
		expect(stored.length).toBeLessThanOrEqual(STORED_LABEL_MAX_CHARS);
		// Well-formed: no lone surrogate survived the cut.
		expect(stored).toBe(stored.toWellFormed());
	});

	// A3: a malformed body is a 400, never a TypeError surfacing as a 500.
	it('refuse (400) un corps malformé au lieu de lever un TypeError', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));
		const malformed = (overrides: Record<string, unknown>) =>
			({ ...input({ anchorTransactionIds: ['sub-0'] }), ...overrides }) as Parameters<
				typeof recordStreamAction
			>[1];

		await expectHttpError(recordStreamAction(userId, malformed({ label: undefined })), 400);
		await expectHttpError(recordStreamAction(userId, malformed({ label: 42 })), 400);
		await expectHttpError(
			recordStreamAction(userId, malformed({ anchorTransactionIds: undefined })),
			400
		);
		await expectHttpError(
			recordStreamAction(userId, malformed({ anchorTransactionIds: 'sub-0' })),
			400
		);
		await expectHttpError(recordStreamAction(userId, malformed({ dueDate: 20260710 })), 400);
		expect(db.prisma.recurringStreamAction.create).not.toHaveBeenCalled();
	});

	it('écrit une action paid avec sa date d’échéance', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));

		await recordStreamAction(userId, input({ kind: 'paid', anchorTransactionIds: ['sub-0'] }));

		const data = db.prisma.recurringStreamAction.create.mock.calls[0][0].data;
		expect(data.kind).toBe('PAID');
		expect(data.dueDate).toEqual(new Date('2026-07-10T00:00:00.000Z'));
		expect(db.prisma.recurringStreamAction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId, kind: 'PAID' } })
		);
	});

	// A2: the cap check and the insert must not be separated by a window another write can use.
	it('compte et insère dans une seule transaction', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));

		await recordStreamAction(userId, input({ anchorTransactionIds: ['sub-0'] }));

		expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);
	});

	// T5-d: this is the reader the (userId, kind) index was kept for.
	it('est idempotente: renvoie l’action existante au lieu d’en insérer une seconde', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0', 'sub-1']));
		db.prisma.recurringStreamAction.findMany.mockResolvedValue([storedAction()]);

		const result = await recordStreamAction(userId, input());

		expect(db.prisma.recurringStreamAction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId, kind: 'IGNORE' } })
		);
		expect(result).toEqual({ actionId });
		expect(db.prisma.recurringStreamAction.create).not.toHaveBeenCalled();
	});

	it('insère quand l’action existante vise une autre échéance du même stream', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));
		db.prisma.recurringStreamAction.findMany.mockResolvedValue([storedAction()]);

		const result = await recordStreamAction(
			userId,
			input({ dueDate: '2026-09-10', anchorTransactionIds: ['sub-0'] })
		);

		expect(result).toEqual({ actionId: 'created-1' });
		expect(db.prisma.recurringStreamAction.create).toHaveBeenCalledTimes(1);
	});

	// T5-f: the write path enforces the same cap the backup validator does.
	it('refuse (400) au-delà de MAX_RECURRING_STREAM_ACTIONS sans évincer de décision vivante', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));
		db.prisma.recurringStreamAction.count.mockResolvedValue(MAX_RECURRING_STREAM_ACTIONS);

		await expectHttpError(recordStreamAction(userId, input()), 400);

		expect(db.prisma.recurringStreamAction.count).toHaveBeenCalledWith({ where: { userId } });
		expect(db.prisma.recurringStreamAction.create).not.toHaveBeenCalled();
		// The ONE delete this path may issue is the inert prune, whose predicate does not depend on
		// the count. Nothing evicts a live decision to make room — that would silently undo something
		// the user asked for.
		expect(db.prisma.recurringStreamAction.deleteMany).toHaveBeenCalledTimes(1);
		expect(pruneWhere()).toEqual({
			userId,
			kind: { in: ['IGNORE', 'PAID'] },
			dueDate: { lt: computeInertActionCutoff(new Date(TODAY)) }
		});
	});

	it('accepte encore la dernière place sous le plafond', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));
		db.prisma.recurringStreamAction.count.mockResolvedValue(MAX_RECURRING_STREAM_ACTIONS - 1);

		await expect(recordStreamAction(userId, input())).resolves.toEqual({ actionId: 'created-1' });
	});

	it('valide kind, direction et dueDate', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));

		await expectHttpError(recordStreamAction(userId, input({ kind: 'delete' as never })), 400);
		await expectHttpError(recordStreamAction(userId, input({ direction: 'both' })), 400);
		await expectHttpError(recordStreamAction(userId, input({ label: '   ' })), 400);
		// A label that normalizes to nothing has no fallback identity at all — refused rather than
		// written as a row only its anchors could ever match.
		await expectHttpError(recordStreamAction(userId, input({ label: '0712 //' })), 400);
		// ignore/paid require a real ISO date...
		await expectHttpError(recordStreamAction(userId, input({ dueDate: null })), 400);
		await expectHttpError(recordStreamAction(userId, input({ dueDate: '2026-02-30' })), 400);
		// ...and exclude requires the absence of one.
		await expectHttpError(
			recordStreamAction(userId, input({ kind: 'exclude', dueDate: '2026-07-10' })),
			400
		);
		expect(db.prisma.recurringStreamAction.create).not.toHaveBeenCalled();
	});

	/**
	 * B3-a. The prune runs on WRITE, inside the same transaction as the cap check, so a decision the
	 * user can no longer act on stops counting against them without a sweep, a boot job, or a DELETE
	 * on the page-load path.
	 */
	describe('purge des décisions inertes', () => {
		const cutoff = () => computeInertActionCutoff(new Date(TODAY));
		const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
		/** One day either side of the cutoff, so the bound itself is exercised, not just its sign. */
		const justBefore = () => new Date(cutoff().getTime() - 86_400_000);
		const justAfter = () => new Date(cutoff().getTime());

		beforeEach(() => {
			db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));
		});

		it('purge avant de compter, en scopant sur userId', async () => {
			await recordStreamAction(userId, input());

			expect(pruneWhere().userId).toBe(userId);
			// Order matters: a prune after the count would leave the cap describing rows that no longer
			// exist. `invocationCallOrder` is what proves it, not the source reading that way.
			expect(db.prisma.recurringStreamAction.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
				db.prisma.recurringStreamAction.count.mock.invocationCallOrder[0]
			);
		});

		it('supprime un IGNORE dont la période est passée depuis la fenêtre de détection', async () => {
			await recordStreamAction(userId, input());

			const row = { userId, kind: 'IGNORE', dueDate: justBefore() };
			expect(applyPruneWhere([row], pruneWhere())).toEqual([row]);
		});

		it('supprime un PAID dont l’occurrence a été absorbée puis sortie de la fenêtre', async () => {
			await recordStreamAction(userId, input());

			const row = { userId, kind: 'PAID', dueDate: justBefore() };
			expect(applyPruneWhere([row], pruneWhere())).toEqual([row]);
		});

		it('ne supprime JAMAIS un EXCLUDE, quel que soit son âge', async () => {
			await recordStreamAction(userId, input());

			// Both shapes an EXCLUDE can take on disk: the one the write path produces (dueDate NULL),
			// and the one only a hand-edited restore could — a due date older than any cutoff. Neither
			// may be touched: an exclusion is permanent and user-initiated.
			const excludes = [
				{ userId, kind: 'EXCLUDE', dueDate: null },
				{ userId, kind: 'EXCLUDE', dueDate: day('2000-01-01') }
			];
			expect(applyPruneWhere(excludes, pruneWhere())).toEqual([]);
		});

		it('ne supprime ni une décision encore vivante ni celle d’un autre utilisateur', async () => {
			await recordStreamAction(userId, input());

			const kept = [
				{ userId, kind: 'IGNORE', dueDate: justAfter() },
				{ userId, kind: 'PAID', dueDate: day('2026-07-10') },
				// dueDate NULL on an ignore/paid: unreachable through the app, and inert — left alone
				// rather than swept, because the prune only removes what it can prove is unreachable.
				{ userId, kind: 'IGNORE', dueDate: null },
				{ userId: 'user-00000002', kind: 'IGNORE', dueDate: justBefore() }
			];
			expect(applyPruneWhere(kept, pruneWhere())).toEqual([]);
		});

		it('crée bien la ligne demandée dans la même transaction que la purge', async () => {
			// The prune must not swallow the write it rides along with: a user's tap still has to
			// produce a row, and its id is what the result banner's "Annuler" posts back.
			const result = await recordStreamAction(userId, input());

			expect(result).toEqual({ actionId: 'created-1' });
			expect(db.prisma.recurringStreamAction.deleteMany).toHaveBeenCalledTimes(1);
			expect(db.prisma.recurringStreamAction.create).toHaveBeenCalledTimes(1);
		});

		/**
		 * The coexistence check. `computeInertActionCutoff` and `oldestNavigableMonth` are computed in
		 * two different functions, and the prune is only safe because the cutoff sits BEFORE the oldest
		 * day the month view can render. Asserting each alone proves nothing about the pair.
		 *
		 * Parameterized over the `now` values where the shared `Date.UTC` month arithmetic is not
		 * boring. A leap 29 February is the one that matters: `getUTCMonth() - 12` names a February
		 * with no 29th, so the value OVERFLOWS into 1 March — harmless, but only because both the
		 * cutoff and the read path overflow identically, which is exactly what
		 * `computeDetectionLookbackStart` now guarantees by being one function.
		 */
		const AWKWARD_NOW = [
			// 2028 is a leap year; 2027-02 has 28 days, so the lookback rolls to 2027-03-01.
			'2028-02-29T09:00:00.000Z',
			'2026-07-01T00:00:00.000Z',
			'2026-07-31T23:59:59.000Z',
			'2026-03-31T12:00:00.000Z'
		];

		it.each(AWKWARD_NOW)(
			'reste en deçà du plus ancien jour affichable (now = %s)',
			async (nowIso) => {
				vi.setSystemTime(new Date(nowIso));
				mockRead([...RENT]);

				const view = await loadUpcomingBillsMonth(userId, nowIso.slice(0, 7));
				const oldestRenderableDay = day(`${view.oldestNavigableMonth}-01`);
				const actual = computeInertActionCutoff(new Date(nowIso));

				expect(actual.getTime()).toBeLessThan(oldestRenderableDay.getTime());
				// And by at least the widest tolerance `assignActionsToOccurrences` grants, so no action on
				// the far side of the cutoff can still be assigned to that first renderable occurrence.
				expect(oldestRenderableDay.getTime() - actual.getTime()).toBeGreaterThanOrEqual(
					occurrenceActionWindowDays({ medianIntervalDays: 365 }) * 86_400_000
				);
			}
		);

		it('fait déborder février 29 exactement comme la fenêtre de détection', () => {
			// The overflow itself, pinned rather than merely tolerated: both sides must name 2027-03-01.
			const leapDay = new Date('2028-02-29T09:00:00.000Z');

			expect(computeDetectionLookbackStart(leapDay).toISOString().slice(0, 10)).toBe('2027-03-01');
			// Cutoff = 1st of that month, minus one full assignment window.
			expect(computeInertActionCutoff(leapDay).toISOString().slice(0, 10)).toBe('2027-02-14');
		});
	});

	it('stocke une exclusion sans date d’échéance', async () => {
		db.prisma.transaction.findMany.mockResolvedValue(owned(['sub-0']));

		await recordStreamAction(userId, input({ kind: 'exclude', dueDate: null }));

		const data = db.prisma.recurringStreamAction.create.mock.calls[0][0].data;
		expect(data.kind).toBe('EXCLUDE');
		expect(data.dueDate).toBeNull();
		expect(data.userId).toBe(userId);
	});
});

describe('undoStreamAction', () => {
	it('supprime en scopant sur userId', async () => {
		db.prisma.recurringStreamAction.deleteMany.mockResolvedValue({ count: 1 });

		await undoStreamAction(userId, actionId);

		expect(db.prisma.recurringStreamAction.deleteMany).toHaveBeenCalledWith({
			where: { id: actionId, userId }
		});
	});

	it('renvoie 404 pour une action appartenant à quelqu’un d’autre', async () => {
		db.prisma.recurringStreamAction.deleteMany.mockResolvedValue({ count: 0 });

		await expectHttpError(undoStreamAction(userId, 'action-someone-else'), 404);
	});

	it('renvoie 404 sans requête pour un id malformé', async () => {
		await expectHttpError(undoStreamAction(userId, 'x'), 404);
		expect(db.prisma.recurringStreamAction.deleteMany).not.toHaveBeenCalled();
	});
});

describe('bornes partagées', () => {
	/**
	 * The domain owns STORED_LABEL_MAX_CHARS because `actionMatchesFlow` needs it and may not import
	 * from `server/`; the backup validator owns MAX_PORTABLE_STRING because it is a statement about
	 * MySQL's varchar default. They describe the same column and must not drift.
	 */
	it('STORED_LABEL_MAX_CHARS et MAX_PORTABLE_STRING décrivent la même colonne', () => {
		expect(STORED_LABEL_MAX_CHARS).toBe(MAX_PORTABLE_STRING);
	});

	it('MAX_ANCHOR_ID_CHARS tient dans le budget de la cellule', () => {
		expect(MAX_ANCHOR_IDS * (MAX_ANCHOR_ID_CHARS + 3) + 2).toBeLessThanOrEqual(
			MAX_ANCHOR_CELL_CHARS
		);
		// Still clears a cuid, so no real id is ever dropped by this bound.
		expect(MAX_ANCHOR_ID_CHARS).toBeGreaterThanOrEqual(25);
	});
});
