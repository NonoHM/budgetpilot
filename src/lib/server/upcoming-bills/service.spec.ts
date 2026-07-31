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
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { loadUpcomingBillsMonth, loadUpcomingBillsWidget, recordStreamAction, undoStreamAction } =
	await import('./service');
const { MAX_ANCHOR_IDS, MAX_PORTABLE_STRING, MAX_RECURRING_STREAM_ACTIONS } =
	await import('$lib/server/backup/schema');

const userId = 'user-00000001';
const actionId = 'action-00000001';
const TODAY = '2026-07-20T09:00:00.000Z';

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

function storedAction(overrides: Record<string, unknown> = {}) {
	return {
		id: actionId,
		kind: 'IGNORE',
		direction: 'expense',
		normalizedLabel: 'cb abonnement netflix',
		anchorTransactionIds: JSON.stringify(['sub-0', 'sub-1', 'sub-2']),
		dueDate: new Date('2026-07-10T00:00:00.000Z'),
		...overrides
	};
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

describe('loadUpcomingBillsMonth', () => {
	it('projette le mois: réalisé auto-réglé, retard et à venir, avec les totaux', async () => {
		mockRead([...RENT, ...SUBSCRIPTION, ...SALARY]);

		const view = await loadUpcomingBillsMonth(userId, '2026-07');

		expect(view.month).toBe('2026-07');
		expect(view.todayIso).toBe('2026-07-20');
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
		expect(subscription.daysLate).toBe(10);
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
		expect(row.label).toBe('Netflix - Loisirs');
		// getInitials over the string the surface actually displays — including the " - category"
		// suffix anonymizeLabel appends, whose "-" becomes the second initial for a single-word
		// merchant. Deliberately NOT special-cased: a second initials rule is exactly what the
		// Task 2 ruling forbids (see the `initials` field in service.ts).
		expect(row.initials).toBe('N-');
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
		expect(view.observationCandidates).toEqual([
			{ label: 'Edf Facture - Énergie', occurrenceCount: 2 }
		]);
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

	it('plafonne à 5 lignes mais compte les retards et le total sur tout l’ensemble retenu', async () => {
		const weekly = ['2026-06-04', '2026-06-11', '2026-06-18', '2026-06-25'].map((date, index) =>
			tx(`groc-${index}`, date, GROCERY_LABEL, -5_000, 'Alimentation')
		);
		mockRead(weekly);

		const view = await loadUpcomingBillsWidget(userId);

		expect(view.rows).toHaveLength(5);
		expect(view.rows.map((row) => row.dateIso)).toEqual([
			'2026-07-02',
			'2026-07-09',
			'2026-07-16',
			'2026-07-23',
			'2026-07-30'
		]);
		// 7 occurrences survive the filter; 3 of them are late and all 7 are in the total.
		expect(view.overdueCount).toBe(3);
		expect(view.remainingExpenseCents).toBe(7 * 5_000);
		// rowKey stays unique even when one stream fills the whole list.
		expect(new Set(view.rows.map((row) => row.rowKey)).size).toBe(5);
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

describe('recordStreamAction', () => {
	function input(overrides: Partial<Parameters<typeof recordStreamAction>[1]> = {}) {
		return {
			kind: 'ignore' as const,
			direction: 'expense',
			normalizedLabel: 'cb abonnement netflix',
			label: SUBSCRIPTION_LABEL,
			dueDate: '2026-07-10',
			anchorTransactionIds: ['sub-0', 'sub-1', 'sub-2'],
			...overrides
		};
	}

	beforeEach(() => {
		db.prisma.recurringStreamAction.findMany.mockResolvedValue([]);
		db.prisma.recurringStreamAction.count.mockResolvedValue(0);
		db.prisma.recurringStreamAction.create.mockResolvedValue({ id: 'created-1' });
	});

	// T5-b: the anchor list must never reach SQL without a userId conjunct.
	it('filtre les ancres sur userId et ne persiste que celles que l’utilisateur possède', async () => {
		db.prisma.transaction.findMany.mockResolvedValue([{ id: 'sub-0' }, { id: 'sub-2' }]);

		const result = await recordStreamAction(
			userId,
			input({ anchorTransactionIds: ['sub-0', 'foreign-1', 'sub-2'] })
		);

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith({
			where: { userId, id: { in: ['sub-0', 'foreign-1', 'sub-2'] } },
			select: { id: true }
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
		db.prisma.transaction.findMany.mockResolvedValue([{ id: 'sub-0' }]);

		await recordStreamAction(
			userId,
			input({
				label: 'a'.repeat(MAX_PORTABLE_STRING),
				normalizedLabel: 'b'.repeat(MAX_PORTABLE_STRING),
				anchorTransactionIds: ['sub-0']
			})
		);
		const exact = db.prisma.recurringStreamAction.create.mock.calls[0][0].data;
		expect(exact.label).toBe('a'.repeat(MAX_PORTABLE_STRING));
		expect(exact.normalizedLabel).toBe('b'.repeat(MAX_PORTABLE_STRING));

		await recordStreamAction(
			userId,
			input({
				label: 'a'.repeat(MAX_PORTABLE_STRING + 1),
				normalizedLabel: 'b'.repeat(MAX_PORTABLE_STRING + 1),
				anchorTransactionIds: ['sub-0']
			})
		);
		const truncated = db.prisma.recurringStreamAction.create.mock.calls[1][0].data;
		expect(truncated.label).toHaveLength(MAX_PORTABLE_STRING);
		expect(truncated.normalizedLabel).toHaveLength(MAX_PORTABLE_STRING);
	});

	// T5-e: same truncation rule as the restore path, newest kept.
	it('tronque les ancres aux MAX_ANCHOR_IDS plus récentes', async () => {
		const anchors = Array.from({ length: MAX_ANCHOR_IDS + 40 }, (_, index) => `anchor-${index}`);
		db.prisma.transaction.findMany.mockImplementation(
			async ({ where }: { where: { id: { in: string[] } } }) =>
				where.id.in.map((id: string) => ({ id }))
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

	// T5-d: this is the reader the (userId, kind) index was kept for.
	it('est idempotente: renvoie l’action existante au lieu d’en insérer une seconde', async () => {
		db.prisma.transaction.findMany.mockResolvedValue([{ id: 'sub-0' }, { id: 'sub-1' }]);
		db.prisma.recurringStreamAction.findMany.mockResolvedValue([storedAction()]);

		const result = await recordStreamAction(userId, input());

		expect(db.prisma.recurringStreamAction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId, kind: 'IGNORE' } })
		);
		expect(result).toEqual({ actionId });
		expect(db.prisma.recurringStreamAction.create).not.toHaveBeenCalled();
	});

	it('insère quand l’action existante vise une autre échéance du même stream', async () => {
		db.prisma.transaction.findMany.mockResolvedValue([{ id: 'sub-0' }]);
		db.prisma.recurringStreamAction.findMany.mockResolvedValue([storedAction()]);

		const result = await recordStreamAction(
			userId,
			input({ dueDate: '2026-09-10', anchorTransactionIds: ['sub-0'] })
		);

		expect(result).toEqual({ actionId: 'created-1' });
		expect(db.prisma.recurringStreamAction.create).toHaveBeenCalledTimes(1);
	});

	// T5-f: the write path enforces the same cap the backup validator does.
	it('refuse (400) au-delà de MAX_RECURRING_STREAM_ACTIONS sans supprimer de décision', async () => {
		db.prisma.transaction.findMany.mockResolvedValue([{ id: 'sub-0' }]);
		db.prisma.recurringStreamAction.count.mockResolvedValue(MAX_RECURRING_STREAM_ACTIONS);

		await expectHttpError(recordStreamAction(userId, input()), 400);

		expect(db.prisma.recurringStreamAction.count).toHaveBeenCalledWith({ where: { userId } });
		expect(db.prisma.recurringStreamAction.create).not.toHaveBeenCalled();
		expect(db.prisma.recurringStreamAction.deleteMany).not.toHaveBeenCalled();
	});

	it('accepte encore la dernière place sous le plafond', async () => {
		db.prisma.transaction.findMany.mockResolvedValue([{ id: 'sub-0' }]);
		db.prisma.recurringStreamAction.count.mockResolvedValue(MAX_RECURRING_STREAM_ACTIONS - 1);

		await expect(recordStreamAction(userId, input())).resolves.toEqual({ actionId: 'created-1' });
	});

	it('valide kind, direction et dueDate', async () => {
		db.prisma.transaction.findMany.mockResolvedValue([{ id: 'sub-0' }]);

		await expectHttpError(recordStreamAction(userId, input({ kind: 'delete' as never })), 400);
		await expectHttpError(recordStreamAction(userId, input({ direction: 'both' })), 400);
		await expectHttpError(recordStreamAction(userId, input({ normalizedLabel: '   ' })), 400);
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

	it('stocke une exclusion sans date d’échéance', async () => {
		db.prisma.transaction.findMany.mockResolvedValue([{ id: 'sub-0' }]);

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
