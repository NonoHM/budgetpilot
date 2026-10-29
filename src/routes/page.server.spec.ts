import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The action under test reaches the database only through `createManualTransaction`, mocked below;
// the stub keeps every other module this route imports from opening a client.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

vi.hoisted(() => {
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
});
const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

const dashboard = vi.hoisted(() => ({
	createManualTransaction: vi.fn(async () => undefined),
	readAccountTransactionSpan: vi.fn()
}));
vi.mock('$lib/server/budget/dashboard', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/budget/dashboard')>()),
	...dashboard
}));

const { actions } = await import('./+page.server');
const { logUserPseudonym } = await import('$lib/server/logging/pseudonym');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

async function createTransaction(input: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);
	return (await (
		actions.createTransaction as (event: {
			locals: { user: typeof testUser };
			request: Request;
		}) => Promise<unknown>
	)({
		locals: { user: testUser },
		request: new Request('http://localhost/?/createTransaction', { method: 'POST', body: formData })
	})) as { status?: number; createTransactionSuccess?: boolean };
}

const FIELDS = {
	date: '2026-06-01',
	label: 'Boulangerie',
	amount: '-4.20',
	category: 'Alimentation'
};

/**
 * #1087 piece 2: a manual transaction writes `sensitive_create`, scope transaction, after
 * `createManualTransaction` returns. Wire names as literals.
 */
describe('#1087: createTransaction writes sensitive_create', () => {
	type Line = { event: string; attributes: Record<string, unknown> };
	const creates = () => (logged as Line[]).filter((line) => line.event === 'sensitive_create');

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
	});

	afterEach(() => {
		dashboard.createManualTransaction.mockReset();
		dashboard.createManualTransaction.mockImplementation(async () => undefined);
	});

	// Separates "the route logs a created transaction" from "the route writes nothing on create".
	it('a created transaction: one line, operation create_transaction, scope transaction', async () => {
		await createTransaction(FIELDS);
		expect(creates()).toEqual([
			{
				event: 'sensitive_create',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(testUser.id),
					'budgetpilot.data.operation': 'create_transaction',
					'budgetpilot.data.scope': 'transaction'
				}
			}
		]);
	});

	// Green today; separates "line after the create returned" from "line before the call".
	it('a refused transaction writes none', async () => {
		dashboard.createManualTransaction.mockRejectedValueOnce(new Error('invalid amount'));
		const result = await createTransaction({ ...FIELDS, amount: 'abc' });
		expect({ status: result.status, lines: creates() }).toEqual({ status: 400, lines: [] });
	});
});
