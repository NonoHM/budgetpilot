import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAISON_V3_HEADER } from './profiles/maison-v3';
import type { ParsedCsvRow } from './types';

// The memory key's secret, as an explicit fixture (`accountMemoryKey.ts` reads it lazily).
process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);

const findFirst = vi.fn();

vi.mock('$lib/server/db', () => ({
	prisma: { rememberedAccount: { findFirst } }
}));

const { resolveStatementAccount } = await import('./sourceSignature');
const { accountMemoryKeyFor } = await import('./accountMemoryKey');

const userId = 'user-mine';

/** `rows[0]` is the HEADER row, exactly as `parseRows` returns it and `findDiscriminantColumn`
 *  documents. */
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

/** The SAME shape, carrying nothing that can name an account. */
const fileNamingNothing = () => rowsWhoseAccountColumnReads('Compte courant');

/**
 * Two verified IBANs that DIFFER per row, and no constant qualifying column beside them: the file
 * PROVING evidence against a single account (kind: 'contradictory', #485). Checksums computed rather
 * than typed, same pair as `discriminant.spec.ts`'s `ACCOUNT_A`/`ACCOUNT_B`.
 */
function fileNamingTwoAccounts(): ParsedCsvRow[] {
	return [
		{ cells: HEADERS, line: 1 },
		{ cells: ['2026-08-01', 'Cafe Fictif', '-2,50', 'FR7630001007941234567890185'], line: 2 },
		{
			cells: ['2026-08-02', 'Boulangerie Fictive', '-3,10', 'FR3730001007949876543210192'],
			line: 3
		}
	];
}

/**
 * A column that VARIES and qualifies the grammar, but only through the loose bare-digit-run
 * branch (kind: 'ambiguous', #485): exactly as consistent with a reference number as with a
 * second account, so the file does not PROVE anything at rank 1.
 */
function fileNamingTwoUnprovenValues(): ParsedCsvRow[] {
	return [
		{ cells: HEADERS, line: 1 },
		{ cells: ['2026-08-01', 'Cafe Fictif', '-2,50', '12349032'], line: 2 },
		{ cells: ['2026-08-02', 'Boulangerie Fictive', '-3,10', '12340185'], line: 3 }
	];
}

const V3_HEADERS = MAISON_V3_HEADER.split(';');

/** A V3 export naming ONE account in its `compte` column (the last cell of every row): rank 2
 *  territory. `date;libelle;categorie;montant;type;nature;source_bancaire;montant_total;part;
 *  categorie_parent;compte`, in that order, with the account name held constant. */
function v3RowsNaming(accountName: string): ParsedCsvRow[] {
	const row = (label: string) => [
		'2026-08-01',
		label,
		'Alimentation',
		'-2,50',
		'expense',
		'spending',
		'csv',
		'-2,50',
		'1/1',
		'Alimentation',
		accountName
	];
	return [
		{ cells: V3_HEADERS, line: 1 },
		{ cells: row('Cafe Fictif'), line: 2 },
		{ cells: row('Boulangerie Fictive'), line: 3 }
	];
}

const bpCurrent = (discriminant: string) => ({
	id: `account-current-${discriminant}`,
	name: 'BP courant',
	source: 'csv',
	archivedAt: null,
	discriminant
});
const bpSavings = (discriminant: string) => ({
	id: `account-savings-${discriminant}`,
	name: 'BP livret',
	source: 'csv',
	archivedAt: null,
	discriminant
});

/** What the memory holds for the file's identifier, in the shape the read selects. */
const remembers = (accountId: string | null) =>
	findFirst.mockResolvedValue(
		accountId === null
			? null
			: { accountId, useCount: 2, rememberedAt: new Date('2026-08-15T00:00:00.000Z') }
	);

beforeEach(() => {
	vi.clearAllMocks();
	findFirst.mockResolvedValue(null);
});

describe('rank 1, what the file itself names', () => {
	// THE FILE BEATS THE MEMORY, ALWAYS. The memory here deliberately names the OTHER account, so
	// the assertion cannot pass by the two agreeing, and it is not even read: the file proved it.
	it('prefers the account the file names, and does not read the memory', async () => {
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
		expect(findFirst).not.toHaveBeenCalled();
	});

	// The other direction of the same rule: a file that PROVES it spans two accounts is not
	// overridden by a memory that says it is one.
	it('refuses a multi-account export rather than falling back to the memory', async () => {
		remembers(bpCurrent('0185').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingTwoAccounts(),
			accounts: [bpCurrent('0185'), bpSavings('9032')]
		});

		expect(resolution).toStrictEqual({ rank: 1, kind: 'multi-account' });
		expect(findFirst).not.toHaveBeenCalled();
	});

	// An UNPROVEN varying column (#485) names no single identifier, so there is nothing the memory
	// could be keyed on: asked, and the memory is not read.
	it('asks, without reading the memory, when the varying column is unproven', async () => {
		remembers(bpCurrent('0185').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingTwoUnprovenValues(),
			accounts: [bpCurrent('0185'), bpSavings('9032')]
		});

		expect(resolution).toStrictEqual({ rank: 3, kind: 'unknown' });
		expect(findFirst).not.toHaveBeenCalled();
	});
});

describe("rank 2, what a V3 export's own compte column names", () => {
	it('resolves the account when the name matches exactly one destination', async () => {
		const resolution = await resolveStatementAccount({
			userId,
			rows: v3RowsNaming('Banque Populaire'),
			accounts: [
				{ id: 'account-bp', name: 'Banque Populaire', source: 'banque_populaire', archivedAt: null }
			]
		});

		expect(resolution).toStrictEqual({ rank: 2, accountId: 'account-bp' });
		expect(findFirst).not.toHaveBeenCalled();
	});

	it('asks when the name matches none of the destinations', async () => {
		const resolution = await resolveStatementAccount({
			userId,
			rows: v3RowsNaming('Compte disparu'),
			accounts: [
				{ id: 'account-bp', name: 'Banque Populaire', source: 'banque_populaire', archivedAt: null }
			]
		});

		expect(resolution).toStrictEqual({ rank: 3, kind: 'unknown' });
	});

	// THE SAFETY CASE. `@@unique([userId, name, source])` lets two of the user's own accounts
	// share one literal name across different sources, so a name match is not a proof the way a
	// verified IBAN pair is. Taking either would file the statement into an account it may not
	// have come from, so this gets the SAME answer as a name matching nothing: refused, not
	// guessed.
	it("refuses rather than guesses when the name matches two of the user's own accounts", async () => {
		const resolution = await resolveStatementAccount({
			userId,
			rows: v3RowsNaming('Compte import CSV'),
			accounts: [
				{ id: 'account-csv', name: 'Compte import CSV', source: 'csv', archivedAt: null },
				{
					id: 'account-bp-renamed',
					name: 'Compte import CSV',
					source: 'banque_populaire',
					archivedAt: null
				}
			]
		});

		expect(resolution).toStrictEqual({ rank: 3, kind: 'unknown' });
	});
});

describe("rank 3, what the user answered for the file's identifier", () => {
	it('proposes the account answered for an identifier no account holds', async () => {
		remembers(bpSavings('9032').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNaming('7777'),
			accounts: [bpCurrent('0185'), bpSavings('9032')]
		});

		expect(resolution).toStrictEqual({
			rank: 3,
			kind: 'remembered',
			accountId: bpSavings('9032').id
		});
	});

	it('reports the remembered account as gone rather than proposing it', async () => {
		remembers(bpSavings('9032').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNaming('7777'),
			accounts: [bpCurrent('0185')]
		});

		expect(resolution).toStrictEqual({ rank: 3, kind: 'orphan' });
	});

	// The companion to the orphan above: nothing remembered is « we know nothing », an answer whose
	// account is gone is « the account you chose is gone ».
	it('says it knows nothing, rather than orphan, when the identifier was never answered', async () => {
		remembers(null);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNaming('7777'),
			accounts: [bpCurrent('0185')]
		});

		expect(resolution).toStrictEqual({ rank: 3, kind: 'unknown' });
	});

	it('never proposes an archived account', async () => {
		const archived = { ...bpSavings('9032'), archivedAt: new Date() };
		remembers(archived.id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNaming('7777'),
			accounts: [bpCurrent('0185'), archived]
		});

		expect(resolution).toStrictEqual({ rank: 3, kind: 'orphan' });
	});

	it('never proposes the manual bucket', async () => {
		remembers('manual-1');

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNaming('7777'),
			accounts: [
				bpCurrent('0185'),
				{ id: 'manual-1', name: 'Manuel', source: 'manual', archivedAt: null }
			]
		});

		expect(resolution).toStrictEqual({ rank: 3, kind: 'orphan' });
	});

	// A file naming no account has no key: the memory is not read, and a shape shared by every
	// statement of one bank cannot stand in for one (#599).
	it('does not read the memory for a file that names no account', async () => {
		remembers(bpCurrent('0185').id);

		const resolution = await resolveStatementAccount({
			userId,
			rows: fileNamingNothing(),
			accounts: [bpCurrent('0185'), bpSavings('9032')]
		});

		expect(resolution).toStrictEqual({ rank: 3, kind: 'unknown' });
		expect(findFirst).not.toHaveBeenCalled();
	});
});

describe('the read is scoped', () => {
	/**
	 * The unit HALF, and it is deliberately not the control: the fake decides what `findFirst`
	 * returns, so dropping `userId` leaves every other test here green. The key is a function of
	 * the identifier and the instance secret alone, so two users importing one identifier compute
	 * one key; `accountMemory.db-smoke.ts` proves the scoping against two real users.
	 */
	it('names userId in the same where clause as the key of the FULL identifier', async () => {
		await resolveStatementAccount({
			userId,
			rows: fileNaming('7777'),
			accounts: [bpCurrent('0185')]
		});

		expect(findFirst).toHaveBeenCalledOnce();
		expect(findFirst.mock.calls[0][0].where).toStrictEqual({
			userId,
			identifierKey: accountMemoryKeyFor('12347777')
		});
	});
});
