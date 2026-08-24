import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedCsvRow } from './types';

const findMany = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();
const accountFindFirst = vi.fn();

vi.mock('$lib/server/db', () => ({
	prisma: {
		importSourceSignature: { findMany, findFirst, create, updateMany },
		account: { findFirst: accountFindFirst }
	}
}));

const { resolveStatementAccount, sourceFingerprintFor } = await import('./sourceSignature');

const userId = 'user-mine';

/** `rows[0]` is the HEADER row, exactly as `parseRows` returns it and `findDiscriminantColumn`
 *  documents. Both fixtures below share this header, so both share one fingerprint. */
const HEADERS = ['date', 'libelle', 'montant', 'compte'];

function rowsWhoseAccountColumnReads(cell: string): ParsedCsvRow[] {
	return [
		{ cells: HEADERS, line: 1 },
		{ cells: ['2026-08-01', 'Cafe Fictif', '-2,50', cell], line: 2 },
		{ cells: ['2026-08-02', 'Boulangerie Fictive', '-3,10', cell], line: 3 }
	];
}

/** A statement whose `compte` column is a constant eight-digit account number: rank 1 territory. */
const fileNaming = (fragment: string) => rowsWhoseAccountColumnReads(`1234${fragment}`);

/** The SAME shape and therefore the same fingerprint, carrying nothing that can name an account. */
const fileNamingNothing = () => rowsWhoseAccountColumnReads('Compte courant');

/** Two well-formed identifiers that DIFFER per row, and no constant qualifying column beside them:
 *  the file offering evidence AGAINST a single account. */
function fileNamingTwoAccounts(): ParsedCsvRow[] {
	return [
		{ cells: HEADERS, line: 1 },
		{ cells: ['2026-08-01', 'Cafe Fictif', '-2,50', '12349032'], line: 2 },
		{ cells: ['2026-08-02', 'Boulangerie Fictive', '-3,10', '12340185'], line: 3 }
	];
}

const bpCurrent = (discriminant: string) => ({
	id: `account-current-${discriminant}`,
	source: 'csv',
	archivedAt: null,
	discriminant
});
const bpSavings = (discriminant: string) => ({
	id: `account-savings-${discriminant}`,
	source: 'csv',
	archivedAt: null,
	discriminant
});

/** What the memory holds, in the shape the read selects. */
const remembers = (...accountIds: string[]) =>
	findMany.mockResolvedValue(accountIds.map((accountId) => ({ accountId })));

beforeEach(() => {
	vi.clearAllMocks();
	findMany.mockResolvedValue([]);
});

describe('rank 1, what the file itself names', () => {
	// THE FILE BEATS THE MEMORY, ALWAYS. The inverse would replay a memorised mistake forever,
	// which is the defect with one extra step. The memory here deliberately names the OTHER
	// account, so the assertion cannot pass by the two agreeing.
	it('prefers the account the file names over the account the memory names', async () => {
		remembers(bpCurrent('0185').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNaming('9032'),
			accounts: [bpCurrent('0185'), bpSavings('9032')]
		});

		expect(resolution).toStrictEqual({
			rank: 1,
			accountId: bpSavings('9032').id,
			fragment: '9032'
		});
	});

	// The other direction of the same rule: a file that says it spans two accounts is not
	// overridden by a memory that says it is one.
	it('refuses a multi-account export rather than falling back to the memory', async () => {
		remembers(bpCurrent('0185').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingTwoAccounts(),
			accounts: [bpCurrent('0185'), bpSavings('9032')]
		});

		expect(resolution).toStrictEqual({ rank: 1, kind: 'multi-account' });
		// And the memory was never consulted, which is what "refuses" means here.
		expect(findMany).not.toHaveBeenCalled();
	});
});

describe('rank 3, what the memory holds', () => {
	it('returns a SET and never a choice when the fingerprint is known to two accounts', async () => {
		remembers(bpCurrent('0185').id, bpSavings('9032').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingNothing(),
			accounts: [bpCurrent('0185'), bpSavings('9032')]
		});

		expect(resolution).toStrictEqual({
			rank: 3,
			candidates: [bpCurrent('0185').id, bpSavings('9032').id]
		});
	});

	// 6b's central decision, asserted so nobody "improves" it later: an ambiguous row PRE-FILLS
	// NOTHING. A guess right eight times in ten produces two misfiled statements and no trace.
	it('pre-fills nothing when two accounts share the fingerprint', async () => {
		remembers(bpCurrent('0185').id, bpSavings('9032').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingNothing(),
			accounts: [bpCurrent('0185'), bpSavings('9032')]
		});

		expect('accountId' in resolution).toBe(false);
	});

	it('reports the memorised account as gone rather than proposing it', async () => {
		remembers(bpSavings('9032').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingNothing(),
			accounts: []
		});

		expect(resolution).toStrictEqual({ rank: 3, kind: 'orphan' });
	});

	// The companion to the orphan above, and the distinction is the whole reason both exist: an
	// empty memory is "we know nothing", an unresolvable memory is "the account you used is gone".
	it('says it knows nothing, rather than orphan, when the shape was never seen', async () => {
		remembers();

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingNothing(),
			accounts: [bpCurrent('0185')]
		});

		expect(resolution).toStrictEqual({ rank: 3, candidates: [] });
	});

	it('excludes an archived account from the candidates', async () => {
		const archived = { ...bpSavings('9032'), archivedAt: new Date() };
		remembers(bpCurrent('0185').id, archived.id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingNothing(),
			accounts: [bpCurrent('0185'), archived]
		});

		// One candidate left, so the row SHOWS it rather than asking. An archived account keeps its
		// past imports and stops being a destination.
		expect(resolution).toStrictEqual({ rank: 3, candidates: [bpCurrent('0185').id] });
	});

	it('excludes the manual bucket from the candidates', async () => {
		remembers(bpCurrent('0185').id, 'manual-1');

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingNothing(),
			accounts: [bpCurrent('0185'), { id: 'manual-1', source: 'manual', archivedAt: null }]
		});

		expect(resolution).toStrictEqual({ rank: 3, candidates: [bpCurrent('0185').id] });
	});
});

describe('the read is scoped', () => {
	/**
	 * The unit HALF, and it is deliberately not the control.
	 *
	 * A fingerprint is a hash of a bank's PUBLIC column names, so every user of that bank shares
	 * one: a lookup without `userId` reads somebody else's configuration, and that is the DESIGNED
	 * behaviour of the key rather than a rare collision. This assertion reads the where clause the
	 * query was built with, which catches the regression locally. It cannot be the control,
	 * because the fake above decides what `findMany` returns: dropping `userId` leaves every other
	 * test in this file green. `sourceSignature.db-smoke.ts` is where that is proven, against two
	 * real users holding the identical fingerprint.
	 */
	it('names userId in the same where clause as the fingerprint', async () => {
		remembers();

		await resolveStatementAccount({
			userId,
			rows: fileNamingNothing(),
			accounts: [bpCurrent('0185')]
		});

		expect(findMany).toHaveBeenCalledOnce();
		expect(findMany.mock.calls[0][0].where).toStrictEqual({
			userId,
			fingerprint: sourceFingerprintFor(HEADERS)
		});
	});
});
