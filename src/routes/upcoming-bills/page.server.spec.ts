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
		rows: [],
		observationCandidates: []
	})),
	// Parameters spelled out (rather than `vi.fn(async () => …)`) so `mock.calls[0][1]` is typed as
	// the input object instead of as an out-of-bounds index on an empty tuple.
	recordStreamAction: vi.fn(async (_userId: string, _input: Record<string, unknown>) => ({
		actionId: 'action-1'
	})),
	undoStreamAction: vi.fn(async (_userId: string, _actionId: string) => undefined)
}));

vi.mock('$lib/server/upcoming-bills/service', () => service);

const { getCurrentMonth } = await import('$lib/server/budget/dashboard');
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

	it('utilise le mois courant quand aucun parametre month n est fourni', async () => {
		expect.assertions(2);

		const data = await loadWith('');

		expect(service.loadUpcomingBillsMonth).toHaveBeenCalledWith(testUser.id, getCurrentMonth());
		expect(data.bills.month).toBe(getCurrentMonth());
	});

	it('honore un mois explicite passe en query', async () => {
		expect.assertions(2);

		const data = await loadWith('?month=2026-08');

		expect(service.loadUpcomingBillsMonth).toHaveBeenCalledWith(testUser.id, '2026-08');
		expect(data.bills.month).toBe('2026-08');
	});

	it('redirige un visiteur non authentifie vers /login sans toucher au service', async () => {
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

	it('rejette un mois malforme en 400 plutot qu en 500', async () => {
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
	] as const)('%s enregistre une action %s et renvoie de quoi peupler la banniere', async (
		name,
		kind
	) => {
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
	});

	it('excludeStream poste sans date d echeance et renvoie une banniere sans mois', async () => {
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

	it('undoAction supprime la decision et renvoie une banniere sans undo', async () => {
		expect.assertions(2);

		const result = await runAction('undoAction', { actionId: 'action-1' });

		expect(service.undoStreamAction).toHaveBeenCalledWith('user-a', 'action-1');
		// `actionId: null` is what hides the banner's own "Annuler": a restore has nothing left to undo.
		expect(result).toEqual({
			billAction: { kind: 'restore', actionId: null, month: '', label: '' }
		});
	});

	it("undo d'un id appartenant a un autre compte echoue en 404, pas en 500", async () => {
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

	it('une charge utile malformee echoue en 400 sans jamais atteindre le service', async () => {
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

	it('remonte le statut et le message d une erreur du service', async () => {
		expect.assertions(2);

		service.recordStreamAction.mockRejectedValueOnce(httpError(400, 'Action invalide.'));

		const result = await runAction('markPaid', CREATOR_FIELDS);

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { billError: string } }).data.billError).toBe('Action invalide.');
	});

	it('n echappe jamais le message d une erreur non-HTTP', async () => {
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

	it('refuse un visiteur non authentifie avant toute ecriture', async () => {
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
