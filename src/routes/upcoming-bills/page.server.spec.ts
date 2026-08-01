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
	}))
}));

vi.mock('$lib/server/upcoming-bills/service', () => service);

const { getCurrentMonth } = await import('$lib/server/budget/dashboard');
const { load } = await import('./+page.server');

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

	it('rejette un mois malforme en 400 plutot qu en 500', async () => {
		expect.assertions(3);

		// A malformed month must never reach `formatMonthLabel`, which throws a RangeError (a 500).
		// `parseMonth` is what turns it into a 400 first — asserted on the status, not on the throw.
		await expect(loadWith('?month=2026-13')).rejects.toMatchObject({ status: 400 });
		await expect(loadWith('?month=nope')).rejects.toMatchObject({ status: 400 });
		expect(service.loadUpcomingBillsMonth).not.toHaveBeenCalled();
	});
});
