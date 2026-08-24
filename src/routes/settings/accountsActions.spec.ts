import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages';

/**
 * WHAT THE THREE ACCOUNT ACTIONS READ OFF A SUBMISSION, AND WHAT THEY PASS ON.
 *
 * ## The one question this file asks, and why a spy is the right instrument for it
 *
 * Mass assignment is a claim about ARGUMENTS: does the action read named keys, or does it hand the
 * submission to the service. That is decided entirely inside the action, so a spy on the service
 * genuinely separates the two states — it is not the « the fake decided what the query returned »
 * failure this repository keeps recording, because no query is being asserted here.
 *
 * The other half, ownership, is NOT here and could not be: `manageStatementAccount.db-smoke.ts`
 * asserts it against a real engine holding a real foreign row, and the break matrix for this task
 * confirms that removing the `userId` clause reddens there and nowhere else. A one-field form is
 * exactly where nobody looks for mass assignment, so both halves are owed and they are owed in
 * different places.
 *
 * ## What is being attacked
 *
 * Every request below posts four columns the forms do not show, all of them deciding something:
 * `source` decides whether the row is a destination at all, `discriminant` is what rank 1 later
 * treats as certain about a file's identity, `netWorthAccountId` reaches the patrimoine figures,
 * and `archivedAt` decides whether the account is offered on import.
 *
 * ASVS 5.0.0 `v5.0.0-2.2.1`, as of the 2026-08-13 assessment of commit `d9c116c`.
 */

const accountsService = vi.hoisted(() => {
	class AccountWriteError extends Error {
		readonly reason: string;
		constructor(reason: string) {
			super(reason);
			this.name = 'AccountWriteError';
			this.reason = reason;
		}
	}
	return {
		AccountWriteError,
		MAX_ACCOUNT_NAME_LENGTH: 120,
		// Typed with a parameter, so `mock.calls[n][0]` is a value the compiler admits exists. A
		// zero-arity `vi.fn` gives an empty tuple and every argument read is a type error, which is
		// the wrong signal: the argument is exactly what these tests are about.
		renameStatementAccount: vi.fn(async (_input: Record<string, unknown>) => {}),
		archiveStatementAccount: vi.fn(async (_input: Record<string, unknown>) => {}),
		linkNetWorthAccount: vi.fn(async (_input: Record<string, unknown>) => {})
	};
});

const netWorthService = vi.hoisted(() => ({
	readLinkableNetWorthAccounts: vi.fn(async () => [])
}));

vi.mock('$lib/server/accounts/service', () => accountsService);
vi.mock('$lib/server/net-worth/service', () => netWorthService);

const { actions } = await import('./+page.server');

const USER = { id: 'user-1', email: 'a@example.test', role: 'USER' as const };

/**
 * Ids are 13 characters, not `acc-1`. `normalizeId` refuses anything under 8, so a short fixture
 * makes every action refuse before it reaches the service and the whole file reports « never
 * called » — which reads exactly like the mass-assignment guard working.
 */
function submit(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		locals: { user: USER },
		request: new Request('http://localhost/settings', { method: 'POST', body })
	};
}

function invoke(name: keyof typeof actions, fields: Record<string, string>) {
	return (actions[name] as unknown as (event: ReturnType<typeof submit>) => Promise<unknown>)(
		submit(fields)
	);
}

/** Every field the three forms do NOT show, posted at once. */
const HOSTILE = {
	source: 'manual',
	discriminant: '9999',
	netWorthAccountId: 'nwa-forged',
	archivedAt: '2020-01-01T00:00:00.000Z',
	nameKey: 'forged',
	userId: 'user-2',
	id2: 'acc-000000002'
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe('renameAccount reads a name and an id, and nothing beside them', () => {
	it('passes exactly three arguments, whatever the request posted', async () => {
		// SEPARATES: « the action names the keys it reads » FROM « the action spreads the form into
		// the service ». `toHaveBeenCalledWith` compares the argument object by DEEP EQUALITY rather
		// than by containment, which is the half that makes this an assertion at all: per-key checks
		// would be satisfied by a spread that added four more keys beside the three meant to be there.
		expect.assertions(2);
		await invoke('renameAccount', { ...HOSTILE, id: 'acc-000000001', newName: 'Livret A' });
		expect(accountsService.renameStatementAccount).toHaveBeenCalledTimes(1);
		expect(accountsService.renameStatementAccount).toHaveBeenCalledWith({
			userId: USER.id,
			accountId: 'acc-000000001',
			name: 'Livret A'
		});
	});

	it('takes the user id from the session and never from the request', async () => {
		// SEPARATES: « userId comes from `locals` » FROM « userId is read off the submission ». The
		// request above posts `userId: 'user-2'`, and this is the assertion that says which one won.
		expect.assertions(1);
		await invoke('renameAccount', { ...HOSTILE, id: 'acc-000000001', newName: 'Livret A' });
		expect(accountsService.renameStatementAccount.mock.calls[0][0]).toMatchObject({
			userId: 'user-1'
		});
	});

	it('refuses a submission with no id before calling anything', async () => {
		// SEPARATES: « the action refuses early » FROM « it passes an empty id down and lets the
		// database decide ». The second reaches a write path with a value nobody validated.
		expect.assertions(2);
		const result = await invoke('renameAccount', { newName: 'Livret A' });
		expect(accountsService.renameStatementAccount).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: 400,
			data: { accountsError: m.accounts_error_not_found() }
		});
	});

	it('renders one sentence per refusal, and never a 5xx', async () => {
		// SEPARATES: « each of the six reasons has its own sentence » FROM « one sentence covers
		// them all ». The `switch` is exhaustive so the compiler enforces the mapping; this asserts
		// the mapping is the RIGHT one, which the compiler cannot.
		expect.assertions(5);
		const expected: [string, string][] = [
			['name-required', m.accounts_error_name_required()],
			['name-taken', m.accounts_error_name_taken()],
			['not-found', m.accounts_error_not_found()],
			['net-worth-not-found', m.accounts_error_net_worth_not_found()],
			['name-too-long', m.accounts_error_name_too_long({ max: 120 })]
		];
		for (const [reason, sentence] of expected) {
			accountsService.renameStatementAccount.mockRejectedValueOnce(
				new accountsService.AccountWriteError(reason)
			);
			expect(await invoke('renameAccount', { id: 'acc-000000001', newName: 'x' })).toMatchObject({
				status: 400,
				data: { accountsError: sentence }
			});
		}
	});

	it('lets an error that is NOT a refusal through, rather than guessing a sentence for it', async () => {
		// SEPARATES: « an unexpected failure surfaces » FROM « every failure is rendered as a rule
		// the user broke ». Telling a user their name is taken when the database is unreachable is
		// worse than an error page: it is a false statement about their own input.
		expect.assertions(1);
		accountsService.renameStatementAccount.mockRejectedValueOnce(new Error('connection lost'));
		await expect(invoke('renameAccount', { id: 'acc-000000001', newName: 'x' })).rejects.toThrow(
			'connection lost'
		);
	});
});

describe('archiveAccount reads an id and one boolean', () => {
	it('passes exactly three arguments, whatever the request posted', async () => {
		expect.assertions(1);
		await invoke('archiveAccount', {
			...HOSTILE,
			id: 'acc-000000001',
			name: 'Renommée par surprise'
		});
		expect(accountsService.archiveStatementAccount).toHaveBeenCalledWith({
			userId: USER.id,
			accountId: 'acc-000000001',
			archived: true
		});
	});

	it('archives on a submission that says nothing, and only the literal `false` reactivates', async () => {
		// SEPARATES: « reactivation is asserted positively » FROM « anything not `true` reactivates ».
		// A hand-crafted request must not obtain a state change by OMITTING a field, which is the
		// ruling the import consent already makes, in the direction that matters here.
		expect.assertions(3);
		await invoke('archiveAccount', { id: 'acc-000000001' });
		expect(accountsService.archiveStatementAccount.mock.calls[0][0]).toMatchObject({
			archived: true
		});
		await invoke('archiveAccount', { id: 'acc-000000001', archived: 'FALSE' });
		expect(accountsService.archiveStatementAccount.mock.calls[1][0]).toMatchObject({
			archived: true
		});
		await invoke('archiveAccount', { id: 'acc-000000001', archived: 'false' });
		expect(accountsService.archiveStatementAccount.mock.calls[2][0]).toMatchObject({
			archived: false
		});
	});

	it('says which direction it went, so the banner is not the same sentence twice', async () => {
		expect.assertions(2);
		expect(await invoke('archiveAccount', { id: 'acc-000000001' })).toMatchObject({
			accountsSuccess: m.accounts_success_archived()
		});
		expect(
			await invoke('archiveAccount', { id: 'acc-000000001', archived: 'false' })
		).toMatchObject({
			accountsSuccess: m.accounts_success_unarchived()
		});
	});
});

describe('linkAccountNetWorth reads an id and a target', () => {
	it('passes exactly three arguments, whatever the request posted', async () => {
		expect.assertions(1);
		await invoke('linkAccountNetWorth', {
			...HOSTILE,
			id: 'acc-000000001',
			netWorthAccountId: 'nwa-000000001',
			name: 'Renommée par surprise'
		});
		expect(accountsService.linkNetWorthAccount).toHaveBeenCalledWith({
			userId: USER.id,
			accountId: 'acc-000000001',
			netWorthAccountId: 'nwa-000000001'
		});
	});

	it('turns an empty selection into null rather than passing an empty string down', async () => {
		// SEPARATES: « the boundary decides what `aucun` means » FROM « the service is handed a
		// value it has to interpret ». An empty string reaching a foreign key is a lookup for an
		// account whose id is the empty string, which is a query rather than a decision.
		expect.assertions(1);
		await invoke('linkAccountNetWorth', { id: 'acc-000000001', netWorthAccountId: '' });
		expect(accountsService.linkNetWorthAccount).toHaveBeenCalledWith({
			userId: USER.id,
			accountId: 'acc-000000001',
			netWorthAccountId: null
		});
	});
});
