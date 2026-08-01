import { error } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `$lib/server/budget/dashboard` is loaded FOR REAL here (only its prisma dependency is stubbed):
// `parseMonth` is the whole subject of two of these tests, so replacing it with a mock would
// replace the behaviour under test — the same trap CLAUDE.md records for query-shaped checks.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

const service = vi.hoisted(() => ({
	loadUpcomingBillsMonth: vi.fn(async (_userId: string, month: string) => ({
		month,
		todayIso: '2026-07-31',
		isCurrentMonth: true,
		isFutureMonth: false,
		streamCount: 0,
		remainingExpenseCents: 0,
		expectedIncomeCents: 0,
		oldestNavigableMonth: '2025-07',
		rows: [],
		observationCandidates: []
	})),
	// Parameters spelled out (rather than `vi.fn(async () => …)`) so `mock.calls[0][1]` is typed as
	// the input object instead of as an out-of-bounds index on an empty tuple.
	recordStreamAction: vi.fn(async (_userId: string, _input: Record<string, unknown>) => ({
		actionId: 'action-1'
	})),
	undoStreamAction: vi.fn(async (_userId: string, _actionId: string) => undefined),
	// A month no wall clock can produce, so the default-month test below fails if the load falls
	// back to `parseMonth`'s own `getCurrentMonth()` (the server's LOCAL month) instead.
	getCurrentBillsMonth: vi.fn(() => '1999-01'),
	// The boundary the load clamps to. Mocked, like the rest of the service, so this file tests the
	// ROUTE's decision; that this value really is the view's `oldestNavigableMonth` is asserted in
	// `service.spec.ts`, against the real derivation.
	getOldestNavigableBillsMonth: vi.fn(() => '2025-07')
}));

vi.mock('$lib/server/upcoming-bills/service', () => service);

const { load, actions } = await import('./+page.server');

const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

// `PageServerLoad`'s return type is the widened SvelteKit union (it allows `void`), so the cast
// narrows it to what this load actually returns rather than asserting a shape it does not have.
async function loadWith(search: string): Promise<{ bills: { month: string } }> {
	return (await load({
		locals: { user: testUser },
		url: new URL(`http://localhost/upcoming-bills${search}`)
	} as Parameters<typeof load>[0])) as { bills: { month: string } };
}

describe('/upcoming-bills load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// F2: the default month comes from the SERVICE's UTC clock, not from `parseMonth`, whose default
	// is the server's local month. The two differ east of Greenwich in the first hours of the 1st,
	// and the view then calls its own default month "future": no "Ce mois" badge, future copy, and
	// "Revenir à ce mois" pointing at the page already open.
	it("uses the service's current UTC month when no month parameter is given", async () => {
		expect.assertions(3);

		const data = await loadWith('');

		expect(service.getCurrentBillsMonth).toHaveBeenCalledTimes(1);
		expect(service.loadUpcomingBillsMonth).toHaveBeenCalledWith(testUser.id, '1999-01');
		expect(data.bills.month).toBe('1999-01');
	});

	it('honors an explicit month passed in the query', async () => {
		expect.assertions(2);

		const data = await loadWith('?month=2026-08');

		expect(service.loadUpcomingBillsMonth).toHaveBeenCalledWith(testUser.id, '2026-08');
		expect(data.bills.month).toBe('2026-08');
	});

	it('redirects an unauthenticated visitor to /login without touching the service', async () => {
		expect.assertions(2);

		// Routes are already guarded in hooks.server.ts; `requireUser` is the belt-and-braces layer,
		// and this asserts it is actually the FIRST thing the load does — a 303 before any read.
		await expect(
			load({
				locals: { user: null },
				url: new URL('http://localhost/upcoming-bills')
			} as Parameters<typeof load>[0])
		).rejects.toMatchObject({ status: 303, location: '/login' });
		expect(service.loadUpcomingBillsMonth).not.toHaveBeenCalled();
	});

	// B2/G1. The navigator stops at the detection window, but a typed or bookmarked URL did not: it
	// still rendered "Aucune échéance en juin 2024 · Changez de mois pour les retrouver" — false for a
	// user who did pay bills that month, and pointing at the one remedy that cannot work, since
	// nothing older than the window can ever render.
	//
	// A redirect rather than a 400: the boundary slides forward every month, so a URL that was legal
	// when bookmarked becomes out of range through no action of the user's — a different class from
	// `2026-13`, which is never legal and still 400s (test below). And rather than a silent clamp,
	// which would leave the URL naming one period while the page shows another, on a page whose whole
	// navigator contract is that the URL names the period.
	it('redirects a month earlier than the detection window to the boundary', async () => {
		expect.assertions(4);

		await expect(loadWith('?month=2024-06')).rejects.toMatchObject({
			status: 302,
			location: '/upcoming-bills?month=2025-07'
		});
		// The clamp happens BEFORE the read: an unreachable month must not cost a query.
		expect(service.loadUpcomingBillsMonth).not.toHaveBeenCalled();

		// The boundary month itself is inside the window — its second half renders real rows — so it
		// must load, not bounce. A `<=` here would make the redirect target redirect to itself.
		const data = await loadWith('?month=2025-07');
		expect(data.bills.month).toBe('2025-07');
		expect(service.loadUpcomingBillsMonth).toHaveBeenCalledWith(testUser.id, '2025-07');
	});

	it('rejects a malformed month with 400 rather than 500', async () => {
		expect.assertions(3);

		// A malformed month must never reach `formatMonthLabel`, which throws a RangeError (a 500).
		// `parseMonth` is what turns it into a 400 first — asserted on the status, not on the throw.
		await expect(loadWith('?month=2026-13')).rejects.toMatchObject({ status: 400 });
		await expect(loadWith('?month=nope')).rejects.toMatchObject({ status: 400 });
		expect(service.loadUpcomingBillsMonth).not.toHaveBeenCalled();
	});
});

// ─── Actions ────────────────────────────────────────────────────────────────

type ActionName = 'markPaid' | 'ignoreOccurrence' | 'excludeStream' | 'undoAction';

/**
 * A real `HttpError`, which is the only thing `isHttpError` recognizes. SvelteKit 2's `error()`
 * THROWS rather than returning, so it cannot be handed straight to `mockRejectedValueOnce` — doing
 * that aborts the test at the arrange step instead of exercising the catch under test.
 */
function httpError(status: number, message: string): unknown {
	try {
		error(status, message);
	} catch (caught) {
		return caught;
	}
	throw new Error('unreachable');
}

function buildFormData(fields: Record<string, string>): FormData {
	const formData = new FormData();
	for (const [key, value] of Object.entries(fields)) formData.append(key, value);
	return formData;
}

async function runAction(name: ActionName, fields: Record<string, string>) {
	const action = actions?.[name];
	if (!action) throw new Error(`missing action ${name}`);
	return action({
		locals: { user: testUser },
		request: { formData: async () => buildFormData(fields) },
		url: new URL('http://localhost/upcoming-bills')
	} as unknown as Parameters<typeof action>[0]);
}

const CREATOR_FIELDS = {
	direction: 'expense',
	label: 'NETFLIX.COM',
	displayLabel: 'Netflix',
	dueDate: '2026-07-31',
	anchorTransactionIds: '["tx-a","tx-b"]'
};

describe('/upcoming-bills actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		service.recordStreamAction.mockResolvedValue({ actionId: 'action-1' });
		service.undoStreamAction.mockResolvedValue(undefined);
	});

	// One per creator: the kind reaching the service is the lowercase domain kind, the anchors
	// arrive parsed, and the result the banner reads carries the id, the period and the ANONYMIZED
	// label — never the raw one posted alongside it.
	it.each([
		['markPaid', 'paid'],
		['ignoreOccurrence', 'ignore']
	] as const)(
		'%s records a %s action and returns enough to populate the banner',
		async (name, kind) => {
			expect.assertions(3);

			const result = await runAction(name, CREATOR_FIELDS);

			expect(service.recordStreamAction).toHaveBeenCalledWith('user-a', {
				kind,
				direction: 'expense',
				label: 'NETFLIX.COM',
				dueDate: '2026-07-31',
				anchorTransactionIds: ['tx-a', 'tx-b']
			});
			expect(result).toEqual({
				billAction: { kind, actionId: 'action-1', month: '2026-07', label: 'Netflix' }
			});
			// The field was removed from the service's input type; TypeScript's excess-property check
			// only fires on a direct literal, so the absence is pinned here too.
			expect(service.recordStreamAction.mock.calls[0][1]).not.toHaveProperty('normalizedLabel');
		}
	);

	it('excludeStream posts without a due date and returns a banner with no month', async () => {
		expect.assertions(2);

		// An exclude targets the whole stream; the service refuses one carrying a due date, so the
		// form omits the field entirely and the route must send null rather than ''.
		const { dueDate: _dueDate, ...fields } = CREATOR_FIELDS;
		const result = await runAction('excludeStream', fields);

		expect(service.recordStreamAction).toHaveBeenCalledWith(
			'user-a',
			expect.objectContaining({ kind: 'exclude', dueDate: null })
		);
		expect(result).toEqual({
			billAction: { kind: 'exclude', actionId: 'action-1', month: '', label: 'Netflix' }
		});
	});

	it('undoAction deletes the decision and returns a banner with no undo', async () => {
		expect.assertions(2);

		const result = await runAction('undoAction', { actionId: 'action-1' });

		expect(service.undoStreamAction).toHaveBeenCalledWith('user-a', 'action-1');
		// `actionId: null` is what hides the banner's own "Annuler": a restore has nothing left to undo.
		expect(result).toEqual({
			billAction: { kind: 'restore', actionId: null, month: '', label: '' }
		});
	});

	it('undoing an id belonging to another account fails with 404, not 500', async () => {
		expect.assertions(2);

		// The service deletes by (id, userId) and throws 404 on a zero count, so a foreign id is
		// indistinguishable from one that never existed. The route must surface that status as a
		// `fail`, with the service's own localized message.
		service.undoStreamAction.mockRejectedValueOnce(httpError(404, 'Décision introuvable.'));

		const result = await runAction('undoAction', { actionId: 'someone-elses-id' });

		expect(result).toMatchObject({ status: 404 });
		expect((result as { data: { billError: string } }).data.billError).toBe(
			'Décision introuvable.'
		);
	});

	it('a malformed payload fails with 400 without ever reaching the service', async () => {
		expect.assertions(5);

		// `anchorTransactionIds` is a JSON string in a hidden field. A hand-edited (or truncated) one
		// would throw a SyntaxError out of JSON.parse and become a 500 — this is the guard that keeps
		// it a 400, for the three shapes that reach the parser: unparseable, not an array, and an
		// array holding something that is not an id.
		for (const anchorTransactionIds of ['{oops', '"tx-a"', '[1,2]', '']) {
			const result = await runAction('markPaid', { ...CREATOR_FIELDS, anchorTransactionIds });
			expect(result).toMatchObject({ status: 400 });
		}

		expect(service.recordStreamAction).not.toHaveBeenCalled();
	});

	it("surfaces a service error's status and message", async () => {
		expect.assertions(2);

		service.recordStreamAction.mockRejectedValueOnce(httpError(400, 'Action invalide.'));

		const result = await runAction('markPaid', CREATOR_FIELDS);

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { billError: string } }).data.billError).toBe('Action invalide.');
	});

	it('never leaks a non-HTTP error message', async () => {
		expect.assertions(2);

		// A Prisma failure can carry connection or query detail; it is reported through a generic
		// key instead of by echoing `caught.message`.
		service.recordStreamAction.mockRejectedValueOnce(
			new Error('connect ECONNREFUSED 127.0.0.1:5432')
		);

		const result = await runAction('markPaid', CREATOR_FIELDS);

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { billError: string } }).data.billError).not.toContain(
			'ECONNREFUSED'
		);
	});

	it('refuses an unauthenticated visitor before any write', async () => {
		expect.assertions(2);

		const action = actions?.markPaid;
		if (!action) throw new Error('missing action markPaid');
		await expect(
			action({
				locals: { user: null },
				request: { formData: async () => buildFormData(CREATOR_FIELDS) },
				url: new URL('http://localhost/upcoming-bills')
			} as unknown as Parameters<typeof action>[0])
		).rejects.toMatchObject({ status: 303, location: '/login' });
		expect(service.recordStreamAction).not.toHaveBeenCalled();
	});
});
